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

async function apolloPost(path, entries, what) {
  try {
    const { data } = await axios.post(`${APOLLO_API}${path}?${queryString(entries)}`, null, {
      headers: apolloHeaders(),
      timeout: 20000,
    });
    return data;
  } catch (err) {
    throw apolloError(err, what);
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
function pickOrganization(orgs, name) {
  const wanted = alnum(name);
  if (!wanted) return null;
  const clean = (o) => alnum(searchableCompanyName(o.name));
  // A company named like its own web address ("Create.xyz") matches Apollo's record by domain.
  const byDomain = (o) => !!o.primary_domain && alnum(o.primary_domain) === wanted;
  return orgs.find((o) => clean(o) === wanted) || orgs.find((o) => alnum(o.name) === wanted) || orgs.find(byDomain) || null;
}

// People API Search: current founders, owners, C-suite, VPs and heads of the organization. 0 credits.
async function searchLeaders(orgFilter) {
  const data = await apolloPost(
    '/mixed_people/api_search',
    [...orgFilter, ['person_seniorities', LEADER_SENIORITIES], ['per_page', 25], ['page', 1]],
    'people search',
  );
  return { people: data?.people || [], total: data?.total_entries ?? data?.pagination?.total_entries ?? (data?.people || []).length };
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
    raw: 0, kept: 0, no_linkedin: 0, enrich_failed: 0, credits_estimate: 0,
  };

  // 1. which Apollo company
  let orgFilter;
  let org = null;
  const domain = domainOf(companyName);
  if (domain) {
    orgFilter = [['q_organization_domains_list', [domain]]];
    stats.org_found = true;
    stats.org_name = domain;
  } else {
    const orgs = await searchOrganizations(name);
    stats.credits_estimate += 1;
    org = pickOrganization(orgs, name);
    stats.org_candidates = orgs.slice(0, 5).map((o) => o.name);
    if (!org) return { people: [], org: null, stats };
    stats.org_found = true;
    stats.org_name = org.name;
    orgFilter = [['organization_ids', [org.id]]];
  }

  // 2. who leads it
  const found = await searchLeaders(orgFilter);
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
  findTeamAtCompany, pickOrganization, rankLeaders, queryString,
};
