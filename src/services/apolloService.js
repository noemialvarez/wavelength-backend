const axios = require('axios');
const { alnum, domainOf, searchableCompanyName } = require('../utils/companyName');
const { seniorityRank } = require('../utils/titleSeniority');

function isConfigured() {
  const key = process.env.APOLLO_API_KEY;
  return !!(key && key !== 'your-apollo-api-key' && key.length > 10);
}

/**
 * Look up a person via Apollo People Match.
 * Returns { email, title, headline } on success (any of which may be null),
 * or null if not found / key not configured.
 * Never throws — failures are logged and swallowed so the caller flow continues.
 */
async function findPerson(name, company, linkedin_url) {
  if (!isConfigured()) {
    console.log('[Apollo] API key not configured — skipping people lookup');
    return null;
  }
  if (!name || !company) return null;

  const parts = name.trim().split(/\s+/);
  const firstName = parts[0];
  const lastName = parts.slice(1).join(' ') || undefined;

  const endpoint = 'https://api.apollo.io/api/v1/people/match';
  const payload = {
    first_name: firstName,
    last_name: lastName,
    organization_name: company,
    reveal_personal_emails: false,
  };
  if (linkedin_url) payload.linkedin_url = linkedin_url;
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache',
    'X-Api-Key': process.env.APOLLO_API_KEY,
  };

  console.log('[Apollo] Request →', {
    endpoint,
    headers: { ...headers, 'X-Api-Key': '[redacted]' },
    body: payload,
  });

  try {
    const { data } = await axios.post(endpoint, payload, { headers, timeout: 10000 });

    console.log('[Apollo] Full response:', JSON.stringify(data, null, 2));

    const person = data?.person || null;
    const email = person?.email || null;
    const title = person?.title || null;
    const headline = person?.headline || null;
    if (email) {
      console.log(`[Apollo] Found email for ${name} @ ${company}: ${email} (title: ${title})`);
    } else {
      console.log(`[Apollo] No email found for ${name} @ ${company} (title: ${title})`);
    }
    if (!person) return null;
    return { email, title, headline };
  } catch (err) {
    const status = err?.response?.status;
    console.error('[Apollo] Error response:', JSON.stringify(err?.response?.data, null, 2));
    if (status === 401 || status === 403) {
      console.error('[Apollo] Authentication failed — check APOLLO_API_KEY');
    } else if (status === 429) {
      console.error('[Apollo] Rate limit hit');
    } else {
      console.error('[Apollo] findPerson error:', err.message);
    }
    return null;
  }
}

// Backward-compatible wrapper for callers that only need the email.
async function findEmail(name, company, linkedin_url) {
  const person = await findPerson(name, company, linkedin_url);
  return person?.email || null;
}

/**
 * Look up a company's employee count via Apollo Organization Enrich.
 * Returns the estimated_num_employees integer, or null if not found.
 * Never throws.
 */
async function getCompanyEmployeeCount(domain) {
  if (!isConfigured() || !domain) return null;
  // Strip protocol/path to get bare domain
  const bare = domain.replace(/^https?:\/\//i, '').split('/')[0].trim();
  if (!bare) return null;
  try {
    const { data } = await axios.get(
      'https://api.apollo.io/api/v1/organizations/enrich',
      {
        params: { domain: bare },
        headers: { 'X-Api-Key': process.env.APOLLO_API_KEY, 'Cache-Control': 'no-cache' },
        timeout: 8000,
      }
    );
    const count = data?.organization?.estimated_num_employees ?? null;
    console.log(`[Apollo] ${bare} employee count: ${count}`);
    return count;
  } catch (err) {
    console.error(`[Apollo] getCompanyEmployeeCount failed for ${bare}:`, err?.response?.status ?? err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Team lookup: company name -> founders / executives -> LinkedIn URL (+ email)
//
//   1. Organization Search by name -> Apollo company (1 credit; skipped when the lead's company
//      is already a web address, since people search can take the domain directly)
//   2. People API Search for that company, founders/owners/C-suite/VP/heads (0 credits;
//      returns first name, partial last name and title only)
//   3. People Enrichment per person, most senior first, capped (about 1 credit each) for the
//      full name, LinkedIn URL and email
// ---------------------------------------------------------------------------

const APOLLO_API = 'https://api.apollo.io/api/v1';
const LEADER_SENIORITIES = ['founder', 'owner', 'c_suite', 'vp', 'head'];
const TEAM_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const teamCache = new Map(); // company key -> { result, ts }; avoids spending credits twice on a repeat click

function apolloHeaders() {
  return { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'X-Api-Key': process.env.APOLLO_API_KEY };
}

// An Error that carries a message the UI can show directly, and whether it is a "stop everything"
// problem (key, plan) or something to skip over.
function apolloError(err, what) {
  const status = err?.response?.status;
  const make = (httpStatus, code, message, fatal) => {
    const e = new Error(message);
    e.friendly = { status: httpStatus, code, message };
    e.fatal = fatal;
    return e;
  };
  if (status === 401) return make(502, 'apollo_key', 'Apollo rejected the API key. Check APOLLO_API_KEY in Railway.', true);
  if (status === 403) {
    return make(502, 'apollo_plan', "Apollo says this key isn't allowed to use that search. Check the key's endpoint scopes (People API Search, Organization Search, People Enrichment), use a master API key, or use a plan that includes API access.", true);
  }
  if (err?.code === 'ECONNABORTED' || /timeout/i.test(err?.message || '')) {
    return make(502, 'apollo_timeout', `Apollo took too long to answer the ${what}. Large companies can be slow — try again in a minute.`, false);
  }
  if (status === 429) return make(502, 'apollo_rate', 'Apollo is rate limiting requests. Wait a few minutes and try again.', false);
  if (status === 422) return make(502, 'apollo_request', `Apollo rejected the ${what} request: ${JSON.stringify(err.response.data).slice(0, 200)}`, false);
  return make(502, 'apollo', `Apollo ${what} failed: ${err?.message || 'unknown error'}`, false);
}

function queryString(entries) {
  const qs = new URLSearchParams();
  for (const [key, value] of entries) {
    if (Array.isArray(value)) value.forEach((v) => qs.append(`${key}[]`, v));
    else if (value !== undefined && value !== null) qs.append(key, String(value));
  }
  return qs.toString();
}

// Apollo can be slow for large companies (a 20s wait was not enough for Deep Instinct), so each
// call waits longer and a timeout is retried once. Other errors (key, plan, rate limit) are not.
async function apolloPost(path, entries, what, { timeoutMs = 30000, retries = 1 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const { data } = await axios.post(`${APOLLO_API}${path}?${queryString(entries)}`, null, {
        headers: apolloHeaders(),
        timeout: timeoutMs,
      });
      return data;
    } catch (err) {
      const timedOut = err?.code === 'ECONNABORTED' || /timeout/i.test(err?.message || '');
      if (timedOut && attempt < retries) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      throw apolloError(err, what);
    }
  }
}

// Organization Search by name. 1 credit.
async function searchOrganizations(name) {
  const data = await apolloPost('/mixed_companies/search', [['q_organization_name', name], ['per_page', 10], ['page', 1]], 'company search');
  return data?.organizations || data?.accounts || [];
}

// The organization whose name is the company we asked for. Exact match only (ignoring legal
// suffixes and punctuation): Apollo's name search is partial, and the wrong company would mean
// sending connection requests to the wrong people.
// Apollo can hold several records with the same name (duplicates, old and new), so every exact
// match is returned, best first, up to 3.
function pickOrganizations(orgs, name) {
  const wanted = alnum(name);
  if (!wanted) return [];
  const clean = (o) => alnum(searchableCompanyName(o.name));
  // A company named like its own web address ("Create.xyz") matches Apollo's record by domain.
  const byDomain = (o) => !!o.primary_domain && alnum(o.primary_domain) === wanted;
  const rank = (o) => (clean(o) === wanted ? 0 : alnum(o.name) === wanted ? 1 : byDomain(o) ? 2 : 3);
  return orgs.filter((o) => rank(o) < 3).sort((a, b) => rank(a) - rank(b)).slice(0, 3);
}

function pickOrganization(orgs, name) {
  return pickOrganizations(orgs, name)[0] || null;
}

// Titles that make someone part of the leadership, for when Apollo hasn't tagged seniority.
const LEADERSHIP_TITLE_RE = /founder|\bceo\b|\bcto\b|\bcoo\b|\bcfo\b|\bcmo\b|\bcpo\b|\bcro\b|\bcio\b|chief|managing director|\bpresident\b|\bvp\b|vice president|head of|\bowner\b|\bpartner\b/i;

// People API Search for one organization filter. 0 credits. The search lists people Apollo hasn't
// shown you before under `people` and anyone already saved in your Apollo account under `contacts`,
// so both are read (a contact's Apollo person ID is `person_id`).
async function searchPeople(orgFilter, { seniorities, perPage }) {
  const entries = [...orgFilter];
  if (seniorities) entries.push(['person_seniorities', seniorities]);
  entries.push(['per_page', perPage], ['page', 1]);
  const data = await apolloPost('/mixed_people/api_search', entries, 'people search', { timeoutMs: 45000, retries: 1 });
  const seen = new Set();
  const people = [];
  for (const p of [...(data?.people || []), ...(data?.contacts || [])]) {
    const id = p.person_id || p.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    people.push({ ...p, id });
  }
  return { people, total: data?.total_entries ?? data?.pagination?.total_entries ?? people.length };
}

// The founders / executives Apollo lists for a company, trying each way of pointing at it:
// by Apollo company ID, then by website domain. For each, first the people Apollo has tagged
// founder / owner / C-suite / VP / head; if there are none (Apollo often hasn't tagged small or
// new companies), everyone it lists, keeping those with a leadership title. All free searches.
// `trail` records what each attempt returned, so an empty result can be explained.
async function findLeaders(filters, trail) {
  let error = null;
  for (const f of filters) {
    const step = { by: f.by };
    trail.push(step);
    try {
      const tagged = await searchPeople(f.entries, { seniorities: LEADER_SENIORITIES, perPage: 25 });
      step.tagged_leaders = tagged.people.length;
      if (tagged.people.length) return { people: tagged.people, total: tagged.total };
      const everyone = await searchPeople(f.entries, { perPage: 100 });
      const byTitle = everyone.people.filter((p) => LEADERSHIP_TITLE_RE.test(p.title || ''));
      step.listed = everyone.total;
      step.leaders_by_title = byTitle.length;
      // The titles Apollo has for them (no names), so "lists N people, none senior" can be explained.
      step.titles = everyone.people.slice(0, 10).map((p) => String(p.title || '(no title)').slice(0, 50));
      if (byTitle.length) return { people: byTitle, total: byTitle.length };
    } catch (err) {
      if (err.fatal) throw err; // key / plan problem: nothing else will work either
      // A slow or failed search must not read as "Apollo lists nobody": remember it, try the next
      // way of finding the company, and report it if nothing turns up.
      step.error = err.friendly?.code || 'error';
      error = error || err;
    }
  }
  return { people: [], total: 0, error };
}

// Last resort: Apollo sometimes files a company's founders under a different record (or none), so
// the company's own record lists nobody senior. Search leaders across Apollo by the company name
// and keep only those whose employer is that company, which the result states. Free.
async function findLeadersByName(name, trail) {
  const step = { by: 'name search' };
  trail.push(step);
  let res;
  try {
    res = await searchPeople([['q_keywords', name]], { seniorities: LEADER_SENIORITIES, perPage: 100 });
  } catch (err) {
    if (err.fatal) throw err;
    step.error = err.friendly?.code || 'error';
    return { people: [], total: 0, error: err };
  }
  const wanted = alnum(name);
  const atCompany = res.people.filter((p) => alnum(searchableCompanyName(p.organization?.name)) === wanted);
  step.returned = res.people.length;
  step.at_company = atCompany.length;
  step.employers = [...new Set(res.people.map((p) => p.organization?.name).filter(Boolean))].slice(0, 6);
  return { people: atCompany, total: atCompany.length };
}

function organizationFilters(org) {
  const filters = [];
  if (org.id) filters.push({ by: 'company id', entries: [['organization_ids', [org.id]]] });
  if (org.primary_domain) filters.push({ by: 'website', entries: [['q_organization_domains_list', [org.primary_domain]]] });
  return filters;
}

// Most senior first, founders ahead of everyone.
function rankLeaders(people) {
  const score = (p) => (/founder|\bowner\b/i.test(p.title || '') ? 1000 : 0) + seniorityRank(p.title);
  return [...people].sort((a, b) => score(b) - score(a));
}

// People Enrichment by Apollo ID: full name, LinkedIn URL, email. About 1 credit when data is returned.
async function enrichPerson(id) {
  const data = await apolloPost('/people/match', [['id', id], ['reveal_personal_emails', false]], 'person lookup');
  return data?.person || null;
}

/**
 * Finds the founders / executive team of a company through Apollo.
 * Returns { people, org, stats }; people have { name, role, linkedin_url, is_founder, email, apollo_id }.
 * Throws an error with a `.friendly` message for key / plan / rate-limit problems.
 */
async function findTeamAtCompany(companyName, { maxPeople } = {}) {
  if (!isConfigured()) {
    const e = new Error('Apollo is not configured');
    e.friendly = { status: 502, code: 'apollo_key', message: 'Apollo is not set up. Add APOLLO_API_KEY in Railway.' };
    throw e;
  }
  const cap = maxPeople || Number(process.env.APOLLO_MAX_PEOPLE) || 5;
  const name = searchableCompanyName(companyName);
  const cacheKey = alnum(companyName);
  const cached = teamCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < TEAM_CACHE_TTL_MS) return { ...cached.result, stats: { ...cached.result.stats, from_cache: true } };

  const stats = {
    source: 'apollo', searched_for: name, org_found: false, org_name: null, org_candidates: [],
    raw: 0, kept: 0, no_linkedin: 0, enrich_failed: 0, credits_estimate: 0, tried: [],
  };

  // 1 + 2. which Apollo company, and who leads it
  let org = null;
  let found = { people: [], total: 0 };
  const domain = domainOf(companyName);
  if (domain) {
    stats.org_found = true;
    stats.org_name = domain;
    stats.org_domain = domain;
    const trail = [];
    found = await findLeaders([{ by: 'website', entries: [['q_organization_domains_list', [domain]]] }], trail);
    stats.tried.push({ org: domain, domain, steps: trail });
    // Nobody found AND a search failed (e.g. timed out): that is not "Apollo lists nobody".
    if (!found.people.length && found.error) throw found.error;
  } else {
    const orgs = await searchOrganizations(name);
    stats.credits_estimate += 1;
    const matches = pickOrganizations(orgs, name);
    stats.org_candidates = orgs.slice(0, 5).map((o) => o.name);
    if (!matches.length) return { people: [], org: null, stats };
    stats.org_found = true;
    stats.org_matches = matches.length; // more than one means several Apollo companies share this name
    let searchError = null; // a search that failed (e.g. timed out) rather than coming back empty
    for (const candidate of matches) {
      const trail = [];
      const attempt = await findLeaders(organizationFilters(candidate), trail);
      stats.tried.push({ org: candidate.name, domain: candidate.primary_domain || null, steps: trail });
      if (attempt.error) searchError = searchError || attempt.error;
      if (attempt.people.length) { org = candidate; found = attempt; break; }
    }
    if (!org) {
      org = matches[0]; // the company's own record lists nobody senior; its LinkedIn page is still worth keeping
      const trail = [];
      const byName = await findLeadersByName(name, trail);
      stats.tried.push({ org: 'search by company name', domain: null, steps: trail });
      if (byName.error) searchError = searchError || byName.error;
      if (byName.people.length) found = byName;
      // Nobody found AND some search failed: report the failure instead of "Apollo lists nobody".
      if (!found.people.length && searchError) throw searchError;
    }
    stats.org_name = org.name;
    stats.org_domain = org.primary_domain || null; // which company record the people came from
  }
  stats.raw = found.total;
  // A couple of spare candidates, so a lookup that returns nothing doesn't use up a slot; the cost
  // is still bounded (a lookup that returns no data costs no credit).
  const candidates = rankLeaders(found.people).slice(0, cap + 2);

  // 3. their LinkedIn URLs and emails
  const people = [];
  for (const c of candidates) {
    if (people.length >= cap) break;
    let person;
    try {
      person = await enrichPerson(c.id);
    } catch (err) {
      if (err.fatal) throw err; // key / plan problem: no point continuing
      stats.enrich_failed++;
      continue;
    }
    if (!person) { stats.enrich_failed++; continue; }
    stats.credits_estimate += 1;
    if (!person.linkedin_url) { stats.no_linkedin++; continue; } // can't connect without a profile link
    const role = person.title || c.title || null;
    const emailOk = person.email && !/unavailable|bounced|invalid/i.test(person.email_status || '');
    people.push({
      name: person.name || [person.first_name, person.last_name].filter(Boolean).join(' ') || c.first_name,
      role,
      linkedin_url: person.linkedin_url,
      is_founder: /founder|\bowner\b/i.test(role || ''),
      email: emailOk ? person.email : null,
      apollo_id: c.id,
    });
  }
  stats.kept = people.length;

  const result = { people, org, stats };
  if (people.length) teamCache.set(cacheKey, { result, ts: Date.now() });
  return result;
}

module.exports = {
  isConfigured, findEmail, findPerson, getCompanyEmployeeCount,
  findTeamAtCompany, pickOrganization, pickOrganizations, rankLeaders, queryString,
};
