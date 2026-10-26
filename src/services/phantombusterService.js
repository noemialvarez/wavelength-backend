const axios = require('axios');
const { normalizeProfileUrl } = require('../utils/linkedinUrl');
const { alnum, searchableCompanyName } = require('../utils/companyName');

const pb = axios.create({
  baseURL: 'https://api.phantombuster.com/api/v2',
  headers: { 'X-Phantombuster-Key': process.env.PHANTOMBUSTER_API_KEY },
});

// Per-cacheKey result cache: cacheKey -> { result, ts }
const resultCache = new Map();
// Per-agent in-flight promise: agentId -> Promise
const agentInFlight = new Map();
// Per-agent last-launch timestamp: agentId -> ms
const agentLastLaunch = new Map();
// Per-agent tail of the Phantom's last console output, so an empty search can say what the
// Phantom reported instead of just "0 results".
const lastRunOutput = new Map();

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MIN_LAUNCH_INTERVAL_MS = 30 * 1000;
const PARALLELISM_RETRY_WAIT_MS = 15 * 1000;

// LinkedIn credentials sent with every launch. LinkedIn ties a session cookie to the browser
// that created it, so PhantomBuster's own guidance is to supply the cookie together with that
// browser's user agent. The user agent is optional here: set PHANTOMBUSTER_LINKEDIN_USER_AGENT
// (copied from the same browser as the li_at cookie) and it's sent along with the cookie.
// The Search Export Phantom remembers every search it has run and, for a repeat, finishes
// with "We've already retrieved all results from that search" and returns nothing. Adding a
// throwaway parameter makes each launch a new search to it (LinkedIn ignores unknown
// parameters), so retries and refreshes actually run.
function withRunId(launchArgs) {
  if (typeof launchArgs.search !== 'string' || !/^https?:\/\//i.test(launchArgs.search)) return launchArgs;
  const sep = launchArgs.search.includes('?') ? '&' : '?';
  return { ...launchArgs, search: `${launchArgs.search}${sep}wlRun=${Date.now().toString(36)}` };
}

// What the Phantom itself reported, reduced to the lines that matter: its error / warning
// lines if it printed any (e.g. "No results found"), otherwise the last few lines. The
// Node/AWS SDK notice every run starts with is noise.
function summarizePhantomOutput(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/AWS SDK|maintenance mode|^\(node:|end-of-support|migrate your code|^For more information|node --trace-warnings/i.test(l));
  const flagged = lines.filter((l) => /^\[(error|warn_)\]/i.test(l));
  const chosen = (flagged.length ? flagged : lines).slice(-3);
  return chosen
    .map((l) => l.replace(/^\[[a-z_]+\]\s*/i, ''))
    .join(' | ')
    .slice(0, 400);
}

function linkedinAuth() {
  const auth = { sessionCookie: process.env.PHANTOMBUSTER_LINKEDIN_SESSION };
  const userAgent = (process.env.PHANTOMBUSTER_LINKEDIN_USER_AGENT || '').trim();
  if (userAgent) auth.userAgent = userAgent;
  return auth;
}

async function launchAgent(agentId, args = {}) {
  const body = { id: agentId, argument: JSON.stringify(args) };
  console.log('[phantombuster] request body:', JSON.stringify(body).replace(/("sessionCookie\\?":\\?")[^"\\]*/g, '$1[redacted]'));

  const attempt = async () => {
    try {
      const { data } = await pb.post('/agents/launch', body);
      return data;
    } catch (error) {
      console.log('[phantombuster] error response:', error.response ? error.response.data : null);
      const status = error.response?.status;
      const msg = JSON.stringify(error.response?.data || '');
      if (status === 429 || msg.includes('maxParallelismReached')) {
        const retryErr = new Error('retryable');
        retryErr.retryable = true;
        retryErr.cause = error;
        throw retryErr;
      }
      throw error;
    }
  };

  try {
    return await attempt();
  } catch (e) {
    if (e.retryable) {
      console.log('[phantombuster] agent busy (429/maxParallelismReached), waiting 15s then retrying once');
      await new Promise(r => setTimeout(r, PARALLELISM_RETRY_WAIT_MS));
      return attempt().catch(e2 => { throw e2.cause || e2; });
    }
    throw e;
  }
}

async function waitForAgent(agentId, containerId, pollMs = 5000, maxWaitMs = 180000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const { data } = await pb.get(`/containers/fetch?id=${containerId}`);
    console.log('[phantombuster] container status:', data.status, '| containerId:', containerId);
    if (data.status === 'finished') {
      const { data: output } = await pb.get(`/agents/fetch-output?id=${agentId}`);
      console.log('[phantombuster] fetch-output response:', JSON.stringify(output));
      return output;
    }
    if (data.status === 'error') throw new Error(`Phantombuster agent error: ${JSON.stringify(data)}`);
    await new Promise(r => setTimeout(r, pollMs));
  }
  throw new Error('Phantombuster agent timed out');
}

async function getAgentOutput(agentId) {
  const { data } = await pb.get(`/agents/${agentId}/output`);
  return data;
}

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function pickProfile(results, searchTitle) {
  console.log('[phantombuster] profiles count:', results.length);
  if (results.length > 0) {
    console.log('[phantombuster] first profile keys:', Object.keys(results[0]));
    console.log('[phantombuster] profiles array:', JSON.stringify(results));
  }
  // Build a regex that prefers profiles matching the searched title.
  // Fallback to the historical leader regex when no specific title was provided.
  var preferRe = searchTitle
    ? new RegExp(escapeRegex(searchTitle), 'i')
    : /founder|co.founder|ceo|chief executive|president/i;
  var match = results.find(function(r) {
    var title = r.title ? r.title : (r.occupation ? r.occupation : (r.currentJob ? r.currentJob : (r.jobTitle ? r.jobTitle : '')));
    return preferRe.test(title);
  });
  var finalResult = match ? match : (results[0] ? results[0] : null);
  console.log('[phantombuster] picked result:', JSON.stringify(finalResult));
  return finalResult;
}

async function fetchS3Results(outputText) {
  console.log('[phantombuster] agent output text:', outputText);
  // The results file link in the Phantom's console output. Matches any PhantomBuster-hosted
  // .json (the original S3 bucket, or a newer cache host) rather than one exact address, and
  // nothing outside PhantomBuster's domains, since this URL is fetched by the server.
  var match = (outputText || '').match(/(https?:\/\/[^\s\r\n]*phantombuster[^\s\r\n]*\.json)/i);
  if (!match) {
    console.log('[phantombuster] no S3 URL found in output text');
    // A Phantom that "finishes" with a session/login/error message produced no results
    // because it failed. Surface that instead of reporting an empty (successful) search.
    if (/cookie|session|log ?in|not logged|error|fail|limit|quota|execution time/i.test(outputText || '')) {
      const tail = String(outputText).trim().split('\n').slice(-3).join(' | ').slice(0, 300);
      throw new Error(`Phantombuster finished without results: ${tail}`);
    }
    return [];
  }
  var s3Url = match[1];
  console.log('[phantombuster] fetching S3 URL:', s3Url);
  var response = await axios.get(s3Url);
  var profiles = Array.isArray(response.data) ? response.data : [];
  console.log('[phantombuster] fetched profiles count:', profiles.length);
  console.log('[phantombuster] first profile:', JSON.stringify(profiles[0]));
  return profiles;
}

// Shared queued-launch helper: caches by cacheKey, serialises + rate-limits per agentId
// so concurrent callers targeting the same Phantombuster agent don't blow its parallelism
// limit. Both people-search flows (founder search, by-name search) share this.
async function runSearchAgent(agentId, cacheKey, launchArgs) {
  const cached = resultCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    console.log('[phantombuster] cache hit for', cacheKey, '— returning cached result');
    return cached.result;
  }

  if (agentInFlight.has(agentId)) {
    console.log('[phantombuster] agent already running, waiting for in-flight run to finish');
    await agentInFlight.get(agentId).catch(() => {});
    const fresh = resultCache.get(cacheKey);
    if (fresh && Date.now() - fresh.ts < CACHE_TTL_MS) return fresh.result;
  }

  const lastLaunch = agentLastLaunch.get(agentId) || 0;
  const msSinceLast = Date.now() - lastLaunch;
  if (msSinceLast < MIN_LAUNCH_INTERVAL_MS) {
    const waitMs = MIN_LAUNCH_INTERVAL_MS - msSinceLast;
    console.log(`[phantombuster] rate limit cooldown: waiting ${Math.ceil(waitMs / 1000)}s before next launch`);
    await new Promise(r => setTimeout(r, waitMs));
  }

  const runPromise = (async () => {
    agentLastLaunch.set(agentId, Date.now());
    const launch = await launchAgent(agentId, withRunId(launchArgs));
    const agentOutput = await waitForAgent(agentId, launch.containerId, 5000, 180000);
    lastRunOutput.set(agentId, String(agentOutput.output || ''));
    const profiles = await fetchS3Results(agentOutput.output);
    if (profiles.length > 0) resultCache.set(cacheKey, { result: profiles, ts: Date.now() });
    return profiles;
  })().finally(() => {
    agentInFlight.delete(agentId);
  });

  agentInFlight.set(agentId, runPromise);
  return runPromise;
}

async function launchFounderSearch(companyName, searchTitle) {
  const title = (searchTitle && String(searchTitle).trim()) || 'founder';
  const cacheKey = `founder::${companyName}::${title.toLowerCase()}`;
  const agentId = process.env.PHANTOMBUSTER_LINKEDIN_SEARCH_AGENT_ID;

  const titleKeyword = title.includes(' ') ? `"${title}"` : title;
  const searchUrl =
    `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(titleKeyword)}+${encodeURIComponent(companyName)}&origin=GLOBAL_SEARCH_HEADER`;
  console.log('[phantombuster] search url:', searchUrl);

  const profiles = await runSearchAgent(agentId, cacheKey, {
    search: searchUrl,
    ...linkedinAuth(),
    numberOfResultsPerSearch: 10,
  });

  return pickProfile(profiles, searchTitle);
}

// Search LinkedIn by a specific person's name (Option 4 — "by name" discovery).
// Reuses the same search-export agent as founder search since both just need
// a LinkedIn people-search URL + result export; no separate agent required.
async function searchPersonByName(firstName, lastName, company) {
  const agentId = process.env.PHANTOMBUSTER_LINKEDIN_SEARCH_AGENT_ID;
  const fullName = [firstName, lastName].filter(Boolean).join(' ').trim();
  const keywords = company ? `${fullName} ${company}` : fullName;
  const cacheKey = `by-name::${keywords.toLowerCase()}`;
  const searchUrl =
    `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(keywords)}&origin=GLOBAL_SEARCH_HEADER`;
  console.log('[phantombuster] by-name search url:', searchUrl);

  const profiles = await runSearchAgent(agentId, cacheKey, {
    search: searchUrl,
    ...linkedinAuth(),
    numberOfResultsPerSearch: 5,
  });

  return profiles.slice(0, 5);
}

function isConnectAgentConfigured() {
  return !!process.env.PHANTOMBUSTER_CONNECT_AGENT_ID;
}

// Sends a LinkedIn connection request via Phantombuster's "LinkedIn Auto
// Connect" agent. Requires PHANTOMBUSTER_CONNECT_AGENT_ID to be set up in the
// Phantombuster account — see README for setup notes. Throws a clear error if
// not configured rather than silently no-op'ing, so callers surface it to the
// user instead of hanging.
//
// Unlike "LinkedIn Search to Lead Connection" (tried first, but turned out to
// be a paced Workflow that queues invites for a separate recurring schedule
// rather than sending on launch — see git history), this agent takes a direct
// profileUrl and sends within the same launch: numberOfAddsPerLaunch caps how
// many it sends per call, set to 1 so each call handles exactly one person.
// Argument schema confirmed via GET /agents/fetch against a live agent.
async function sendConnectionRequest(profileUrl, note) {
  if (!isConnectAgentConfigured()) {
    throw new Error(
      'PHANTOMBUSTER_CONNECT_AGENT_ID is not configured — set up a LinkedIn Auto Connect agent in Phantombuster and add its ID to the backend env vars',
    );
  }
  const agentId = process.env.PHANTOMBUSTER_CONNECT_AGENT_ID;
  const launch = await launchAgent(agentId, {
    inputType: 'profileUrl',
    profileUrl,
    numberOfAddsPerLaunch: 1,
    message: note || '',
    ...linkedinAuth(),
  });
  return waitForAgent(agentId, launch.containerId);
}

function isConnectionsCheckAgentConfigured() {
  return !!process.env.PHANTOMBUSTER_CONNECTIONS_AGENT_ID;
}

// Fetches the current list of 1st-degree LinkedIn connections via
// Phantombuster's "LinkedIn Connections Export" agent, used by the
// acceptance-polling cron to detect which pending connection requests have
// been accepted. Returns null (not an empty array) when the agent isn't
// configured, so callers can distinguish "not set up yet" from "checked,
// found nothing". Argument schema confirmed via agents/fetch: numberOfProfiles
// + sortBy + sessionCookie. Sorted newest-first, capped at 100 — comfortably
// covers new acceptances between polling runs (see cronService).
async function fetchAcceptedConnections(limit = 100) {
  if (!isConnectionsCheckAgentConfigured()) return null;
  const agentId = process.env.PHANTOMBUSTER_CONNECTIONS_AGENT_ID;
  const launch = await launchAgent(agentId, {
    numberOfProfiles: limit,
    sortBy: 'Recently added',
    ...linkedinAuth(),
  });
  const output = await waitForAgent(agentId, launch.containerId, 5000, 180000);
  return fetchS3Results(output.output);
}

function isMessageAgentConfigured() {
  return !!process.env.PHANTOMBUSTER_MESSAGE_AGENT_ID;
}

// Sends a LinkedIn DM to an existing 1st-degree connection via Phantombuster's
// "LinkedIn Message Sender" agent — used for both the initial post-connection
// outreach message and the 3-day no-reply reminder (Lemlist only handles the
// email-escalation fallback; it isn't in the loop for LinkedIn sends at all,
// since that requires Lemlist's paid Multichannel tier).
//
// Argument schema confirmed via agents/fetch: `spreadsheetUrl` + `message` +
// `sessionCookie`. Unlike the Connect agent, spreadsheetUrl accepts a bare
// profile URL directly (confirmed empirically), so no search-URL workaround
// is needed here — lead.linkedin_url is passed straight through.
async function sendLinkedInMessage(profileUrl, message) {
  if (!isMessageAgentConfigured()) {
    throw new Error(
      'PHANTOMBUSTER_MESSAGE_AGENT_ID is not configured — set up a LinkedIn Message Sender agent in Phantombuster and add its ID to the backend env vars',
    );
  }
  const agentId = process.env.PHANTOMBUSTER_MESSAGE_AGENT_ID;
  const launch = await launchAgent(agentId, {
    spreadsheetUrl: profileUrl,
    message,
    ...linkedinAuth(),
  });
  return waitForAgent(agentId, launch.containerId);
}

async function enrichFounder(lead) {
  const launch = await launchAgent(process.env.PHANTOMBUSTER_SALES_NAV_AGENT_ID, {
    profileUrl: lead.linkedin_url,
    ...linkedinAuth(),
  });

  const result = await waitForAgent(process.env.PHANTOMBUSTER_SALES_NAV_AGENT_ID, launch.containerId);

  // Parse the output JSON from Phantombuster
  const lines = (result.output || '').split('\n').filter(Boolean);
  for (const line of lines.reverse()) {
    try { return JSON.parse(line); } catch {}
  }
  return {};
}

// Recent activity (posts, and for people also likes/comments) of one or more LinkedIn pages, via
// the LinkedIn Activity Extractor. Like the other agents it saves its results to a file and only
// prints a log, so the records are read from that file (the log never contains them). The link goes
// in `spreadsheetUrl`, where these Phantoms take a single URL. Nothing else is sent: the Phantom's
// argument is validated against a strict schema (extra keys make it reject the run), so the number
// of posts etc. come from the Phantom's own saved settings.
async function fetchLinkedInActivity(profileUrls) {
  const agentId = process.env.PHANTOMBUSTER_LINKEDIN_AGENT_ID;
  const urls = (Array.isArray(profileUrls) ? profileUrls : [profileUrls]).filter(Boolean);
  const activities = [];
  for (const url of urls) {
    const launch = await launchAgent(agentId, {
      spreadsheetUrl: url,
      ...linkedinAuth(),
    });
    const result = await waitForAgent(agentId, launch.containerId);
    lastRunOutput.set(agentId, String(result.output || ''));
    activities.push(...(await fetchS3Results(result.output)));
  }
  return activities;
}

// Field names this Phantom uses for a post's text, link, date and kind aren't documented, so the
// likely ones are tried in turn, with a fallback to the longest free-text field.
const ACTIVITY_TEXT_KEYS = ['postContent', 'postText', 'text', 'content', 'postBody', 'body', 'commentary', 'description', 'message'];
const ACTIVITY_URL_KEYS = ['postUrl', 'postURL', 'postLink', 'url', 'link', 'permalink', 'shareUrl'];
const ACTIVITY_DATE_KEYS = ['postDate', 'date', 'timestamp', 'publishedAt', 'postTimestamp', 'publishedDate', 'timeAgo'];
const ACTIVITY_TYPE_KEYS = ['action', 'type', 'activityType', 'postType'];

function firstString(rec, keys) {
  for (const k of keys) {
    if (typeof rec[k] === 'string' && rec[k].trim()) return rec[k].trim();
  }
  return '';
}

function normalizeActivity(a) {
  let text = firstString(a, ACTIVITY_TEXT_KEYS);
  if (!text) {
    const candidates = Object.entries(a)
      .filter(([k, v]) => typeof v === 'string' && !/url|link|image|photo|date|time|id$/i.test(k) && !/^https?:\/\//i.test(v))
      .map(([, v]) => v.trim())
      .sort((x, y) => y.length - x.length);
    if (candidates[0] && candidates[0].length >= 20) text = candidates[0]; // too short to be a post otherwise
  }
  const postUrl =
    firstString(a, ACTIVITY_URL_KEYS) ||
    stringValues(a).find((s) => /linkedin\.com\/(posts|feed\/update)/i.test(s)) ||
    null;
  return {
    text,
    post_url: postUrl,
    date: firstString(a, ACTIVITY_DATE_KEYS) || null,
    type: firstString(a, ACTIVITY_TYPE_KEYS) || 'post',
  };
}

// Posts the page itself published. A person's activity also lists what they liked or commented
// on; those are only used when there are no posts of their own, since a summary of "what they
// post about" should come from what they wrote.
function normalizeActivities(activities) {
  const items = activities.map(normalizeActivity).filter((a) => a.text);
  const own = items.filter((a) => /post|share|article/i.test(a.type) && !/like|react|comment/i.test(a.type));
  return (own.length ? own : items).slice(0, 5);
}

// The Auto Commenter reads its post URL(s) and comment(s) from a spreadsheet (Google
// Sheet or public CSV) — confirmed in its own setup UI ("Your post URLs and comments" /
// "Give your list of LinkedIn post URLs and comments in separate columns in a
// spreadsheet"), unlike the other agents which take direct fields. `csvUrl` is our own
// backend's one-row CSV (see contactsController's commentCsv) generated fresh per call,
// so there's no need for an actual Google Sheet.
async function postLinkedInComment(csvUrl) {
  const agentId = process.env.PHANTOMBUSTER_COMMENT_AGENT_ID;
  const launch = await launchAgent(agentId, {
    spreadsheetUrl: csvUrl,
    ...linkedinAuth(),
  });
  return waitForAgent(agentId, launch.containerId);
}

// ---------------------------------------------------------------------------
// Team lookup, connection check and post fetching (LinkedIn Engagement flow)
// ---------------------------------------------------------------------------

const CONNECTIONS_TTL_MS = 6 * 60 * 60 * 1000;
let connectionCache = { set: null, ts: 0 };
let connectionInFlight = null;

// Set of normalised profile URLs the LinkedIn account is connected to, from a full
// Connections Export (cached for 6h — the export is slow and rate-limited).
// Returns null when the agent isn't configured or the export came back empty, so
// callers can report "unknown" instead of wrongly reporting "not connected".
async function getConnectionSet({ force = false, cachedOnly = false } = {}) {
  if (!isConnectionsCheckAgentConfigured()) return null;
  if (!force && connectionCache.set && Date.now() - connectionCache.ts < CONNECTIONS_TTL_MS) {
    return connectionCache.set;
  }
  // cachedOnly: never launch the (slow) export here — used by Find team so one click doesn't
  // chain two multi-minute Phantom runs. "Refresh connections" does the real export.
  if (cachedOnly) return null;
  if (connectionInFlight) return connectionInFlight;

  connectionInFlight = (async () => {
    const limit = Number(process.env.PHANTOMBUSTER_CONNECTIONS_EXPORT_LIMIT) || 2000;
    const profiles = await fetchAcceptedConnections(limit);
    const set = new Set(
      (profiles || [])
        .map((c) => normalizeProfileUrl(c.profileUrl || c.linkedinUrl || c.url))
        .filter(Boolean),
    );
    if (set.size === 0) return null;
    connectionCache = { set, ts: Date.now() };
    return set;
  })().finally(() => {
    connectionInFlight = null;
  });
  return connectionInFlight;
}

const LEADERSHIP_RE = /founder|\bceo\b|\bcto\b|\bcoo\b|\bcfo\b|\bcmo\b|\bcpo\b|\bcro\b|\bcio\b|chief|managing director|\bpresident\b|head of|\bvp\b|vice president|\bowner\b/i;
const NOT_CURRENT_RE = /\b(former|formerly|ex[- ]|advisor|adviser|investor|board member)\b/i;


function profileFields(r) {
  const nameParts = [r.firstName, r.lastName].filter(Boolean);
  return {
    name: r.fullName || r.name || (nameParts.length ? nameParts.join(' ') : null),
    role: r.title || r.occupation || r.currentJob || r.jobTitle || r.headline || r.job || null,
    linkedin_url: r.profileUrl || r.linkedinUrl || r.url || null,
    company: r.company || r.companyName || r.currentCompany || null,
  };
}

// LinkedIn search results carry the connection degree of each person relative to the
// logged-in account ("1st" / "2nd" / "3rd"). That answers "are we connected?" without the
// slow Connections Export and without matching profile URLs. Returns undefined when absent.
function connectionFromDegree(r) {
  const d = r.connectionDegree ?? r.degree ?? r.distance ?? r.connection_degree;
  if (d == null) return undefined;
  const s = String(d).toLowerCase();
  if (/\b1(st)?\b|first/.test(s)) return 'yes';
  if (/\b[23](nd|rd)?\b|second|third|out of network/.test(s)) return 'no';
  return undefined;
}

// Every string anywhere in a raw search result (the Phantom's field names aren't guaranteed,
// so don't depend on which field a given line arrives in).
function stringValues(value, depth = 0) {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object' || depth > 2) return [];
  return Object.values(value).flatMap((v) => stringValues(v, depth + 1));
}

// The (role, company) pairs a search result states about a person:
//   - LinkedIn's "Current: Founder at Coda Labs" / "Past: CEO at Coda Labs" snippet lines
//   - the headline, split as "Role at Company" when written that way
//   - the result's own title + company fields
// `past` marks a Past/Previous/Former line, which never counts as a current role.
const SNIPPET_RE = /\b(Current|Past|Previous|Former)\s*:\s*([^\r\n]+?)\s+(?:at|@)\s+([^\r\n]+)/gi;
function relationsFor(raw, p) {
  const rels = [];
  for (const text of stringValues(raw)) {
    for (const m of text.matchAll(SNIPPET_RE)) {
      rels.push({ role: m[2].trim(), company: m[3].trim(), past: !/^current$/i.test(m[1]) });
    }
  }
  if (p.role) {
    const m = String(p.role).match(/^(.+?)\s+(?:at|@)\s+(.+)$/i);
    rels.push(m ? { role: m[1].trim(), company: m[2].trim(), past: false } : { role: String(p.role), company: p.company || '', past: false });
  }
  return rels;
}

// Keeps only current founders / executives of the company from raw search results, and
// reports why everyone else was dropped (counts, plus a few role/company examples with no
// names) so an empty result can be explained instead of just shown as "0 found".
function pickTeamDetailed(profiles, companyName) {
  const wanted = alnum(searchableCompanyName(companyName));
  const seen = new Set();
  const people = [];
  const dropped = { missing_fields: 0, not_leadership: 0, former_or_advisor: 0, other_company: 0, duplicate: 0 };
  const samples = [];
  const drop = (reason, p) => {
    dropped[reason]++;
    if (samples.length < 8) {
      samples.push({ reason, role: String(p.role || '').slice(0, 90), company: String(p.company || '').slice(0, 60) });
    }
  };

  for (const raw of profiles) {
    const p = profileFields(raw);
    if (!p.name || !p.linkedin_url) { drop('missing_fields', p); continue; }

    // Judge the person's relationship to THIS company, not their headline alone: a headline
    // can be about another company or be unrelated text, while LinkedIn's own
    // "Current: Founder at <company>" / "Past: CEO at <company>" lines say it directly.
    const mine = relationsFor(raw, p).filter((r) => alnum(`${r.company} ${r.role}`).includes(wanted));
    if (!mine.length) { drop('other_company', p); continue; }
    if (mine.every((r) => r.past)) { drop('former_or_advisor', { ...p, role: mine[0].role }); continue; }
    const leaders = mine.filter((r) => !r.past && LEADERSHIP_RE.test(r.role));
    if (!leaders.length) { drop('not_leadership', { ...p, role: mine[0].role }); continue; }
    const current = leaders.find((r) => !NOT_CURRENT_RE.test(r.role));
    if (!current) { drop('former_or_advisor', { ...p, role: leaders[0].role }); continue; }

    const key = normalizeProfileUrl(p.linkedin_url);
    if (seen.has(key)) { drop('duplicate', p); continue; }
    seen.add(key);
    people.push({
      name: p.name,
      role: current.role,
      linkedin_url: p.linkedin_url,
      is_founder: /founder|\bowner\b/i.test(current.role),
      connection: connectionFromDegree(raw),
    });
  }
  return {
    people,
    stats: {
      searched_for: searchableCompanyName(companyName),
      raw: profiles.length,
      kept: people.length,
      dropped,
      samples,
      fields: Object.keys(profiles[0] || {}),
    },
  };
}

function pickTeam(profiles, companyName) {
  return pickTeamDetailed(profiles, companyName).people;
}

// Combines the outcome of several searches for the same company into one: people de-duplicated
// by profile (preferring an entry that already knows the connection), counts added up.
function mergeTeamResults(results) {
  const byUrl = new Map();
  for (const r of results) {
    for (const p of r.people) {
      const key = normalizeProfileUrl(p.linkedin_url);
      const existing = byUrl.get(key);
      if (!existing || (!existing.connection && p.connection)) byUrl.set(key, p);
    }
  }
  const dropped = {};
  for (const r of results) for (const [k, v] of Object.entries(r.stats.dropped)) dropped[k] = (dropped[k] || 0) + v;
  const people = [...byUrl.values()];
  return {
    people,
    stats: {
      searched_for: results[0].stats.searched_for,
      raw: results.reduce((n, r) => n + r.stats.raw, 0),
      kept: people.length,
      dropped,
      samples: results.flatMap((r) => r.stats.samples).slice(0, 8),
      fields: (results.find((r) => r.stats.fields.length) || results[0]).stats.fields,
      // What the Phantom reported on a search that found nothing (e.g. "No results found").
      phantom_output: [...results].reverse().find((r) => r.stats.raw === 0)?.stats.phantom_output || '',
    },
  };
}

// Searches LinkedIn for the founders / executives of a company, then keeps only people whose
// current role at that company is a leadership one — a wrong person here would later get a
// connection request.
//
// Plain queries only: LinkedIn answered "No results found" for boolean queries
// ('"Coda Labs" AND (founder OR CEO ...)') even typed by hand, while "founder Coda Labs"
// works. Each query surfaces people matching its role word, so two are run and merged:
// founders, and the CEO. Two launches per company at most, and the second is skipped if the
// first was slow, to keep the load on the LinkedIn session (and the request time) down.
const TEAM_QUERY_WORDS = ['founder', 'CEO'];
const TEAM_SEARCH_BUDGET_MS = 150 * 1000;

async function searchTeam(companyName) {
  const agentId = process.env.PHANTOMBUSTER_LINKEDIN_SEARCH_AGENT_ID;
  const name = searchableCompanyName(companyName);
  const startedAt = Date.now();

  const results = [];
  const attempts = [];
  for (const [i, word] of TEAM_QUERY_WORDS.entries()) {
    if (i > 0 && Date.now() - startedAt > TEAM_SEARCH_BUDGET_MS) {
      attempts.push({ query: word, skipped: 'first search was slow' });
      continue;
    }
    const searchUrl =
      `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(`${word} ${name}`)}&origin=GLOBAL_SEARCH_HEADER`;
    console.log(`[phantombuster] team search (${word}) url:`, searchUrl);

    let profiles;
    try {
      profiles = await runSearchAgent(agentId, `team::${name.toLowerCase()}::${word.toLowerCase()}`, {
        search: searchUrl,
        ...linkedinAuth(),
        numberOfResultsPerSearch: 25,
      });
    } catch (err) {
      // The first search failing is the real problem (session, plan, key) and is reported as such.
      // A later one failing must not throw away the people the first one already found.
      if (i === 0) throw err;
      console.log(`[phantombuster] team search (${word}) failed, keeping earlier results:`, err.message);
      attempts.push({ query: word, error: String(err.message).slice(0, 200) });
      continue;
    }

    const r = pickTeamDetailed(profiles, companyName);
    r.stats.phantom_output = summarizePhantomOutput(lastRunOutput.get(agentId));
    results.push(r);
    attempts.push({ query: word, raw: r.stats.raw, kept: r.stats.kept });
    // Counts and field names only (no personal data) so an empty result can be explained from the logs.
    console.log(`[phantombuster] team search (${word}) for "${name}": ${r.stats.raw} raw, ${r.stats.kept} kept, dropped:`, r.stats.dropped, 'fields:', r.stats.fields);
  }

  const merged = mergeTeamResults(results);
  merged.stats.attempts = attempts;
  return merged;
}

// Finds a company's LinkedIn page URL through the same search-export agent.
// Returns null when nothing usable comes back (e.g. the agent only supports people search).
async function searchCompanyPage(companyName) {
  const agentId = process.env.PHANTOMBUSTER_LINKEDIN_SEARCH_AGENT_ID;
  const searchUrl =
    `https://www.linkedin.com/search/results/companies/?keywords=${encodeURIComponent(companyName)}&origin=GLOBAL_SEARCH_HEADER`;
  const profiles = await runSearchAgent(agentId, `company-page::${companyName.toLowerCase()}`, {
    search: searchUrl,
    ...linkedinAuth(),
    numberOfResultsPerSearch: 5,
  });
  const wanted = alnum(companyName);
  const pages = profiles
    .map((r) => ({
      name: r.companyName || r.name || r.fullName || '',
      url: r.companyUrl || r.profileUrl || r.linkedinUrl || r.url || '',
    }))
    .filter((c) => /linkedin\.com\/company\//i.test(c.url));
  const best = pages.find((c) => alnum(c.name).includes(wanted)) || pages[0];
  return best ? best.url : null;
}

// Recent posts for a single profile / company page via the LinkedIn Activity agent.
// Returns { posts, debug }: `debug` says what the Phantom returned (how many records, their field
// names, and its own last messages) so an empty result can be explained instead of just "no posts".
async function fetchPostsFor(url) {
  const activities = await fetchLinkedInActivity([url]);
  const posts = normalizeActivities(activities);
  const agentId = process.env.PHANTOMBUSTER_LINKEDIN_AGENT_ID;
  return {
    posts,
    debug: {
      records: activities.length,
      fields: Object.keys(activities[0] || {}),
      phantom_output: summarizePhantomOutput(lastRunOutput.get(agentId)),
    },
  };
}

module.exports = {
  getAgentOutput,
  launchFounderSearch,
  searchPersonByName,
  isConnectAgentConfigured,
  sendConnectionRequest,
  isConnectionsCheckAgentConfigured,
  fetchAcceptedConnections,
  getConnectionSet,
  searchTeam,
  pickTeam,
  pickTeamDetailed,
  searchableCompanyName,
  searchCompanyPage,
  fetchPostsFor,
  normalizeActivities,
  isMessageAgentConfigured,
  sendLinkedInMessage,
  enrichFounder,
  fetchLinkedInActivity,
  postLinkedInComment,
};
