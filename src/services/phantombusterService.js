const axios = require('axios');
const { normalizeProfileUrl } = require('../utils/linkedinUrl');

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

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MIN_LAUNCH_INTERVAL_MS = 30 * 1000;
const PARALLELISM_RETRY_WAIT_MS = 15 * 1000;

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
  var match = (outputText || '').match(/JSON saved at (https:\/\/phantombuster\.s3\.amazonaws\.com\/[^\s\r\n]+\.json)/);
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
    const launch = await launchAgent(agentId, launchArgs);
    const agentOutput = await waitForAgent(agentId, launch.containerId, 5000, 180000);
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
    sessionCookie: process.env.PHANTOMBUSTER_LINKEDIN_SESSION,
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
    sessionCookie: process.env.PHANTOMBUSTER_LINKEDIN_SESSION,
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
    sessionCookie: process.env.PHANTOMBUSTER_LINKEDIN_SESSION,
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
    sessionCookie: process.env.PHANTOMBUSTER_LINKEDIN_SESSION,
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
    sessionCookie: process.env.PHANTOMBUSTER_LINKEDIN_SESSION,
  });
  return waitForAgent(agentId, launch.containerId);
}

async function enrichFounder(lead) {
  const launch = await launchAgent(process.env.PHANTOMBUSTER_SALES_NAV_AGENT_ID, {
    profileUrl: lead.linkedin_url,
    sessionCookie: process.env.PHANTOMBUSTER_LINKEDIN_SESSION,
  });

  const result = await waitForAgent(process.env.PHANTOMBUSTER_SALES_NAV_AGENT_ID, launch.containerId);

  // Parse the output JSON from Phantombuster
  const lines = (result.output || '').split('\n').filter(Boolean);
  for (const line of lines.reverse()) {
    try { return JSON.parse(line); } catch {}
  }
  return {};
}

async function fetchLinkedInActivity(profileUrls) {
  const launch = await launchAgent(process.env.PHANTOMBUSTER_LINKEDIN_AGENT_ID, {
    profileUrls,
    sessionCookie: process.env.PHANTOMBUSTER_LINKEDIN_SESSION,
    numberOfPosts: 5,
  });

  const result = await waitForAgent(process.env.PHANTOMBUSTER_LINKEDIN_AGENT_ID, launch.containerId);

  const lines = (result.output || '').split('\n').filter(Boolean);
  const activities = [];
  for (const line of lines) {
    try { activities.push(...JSON.parse(line)); } catch {}
  }
  return activities;
}

async function postLinkedInComment(postUrl, commentText) {
  const agentId = process.env.PHANTOMBUSTER_COMMENT_AGENT_ID;
  const launch = await launchAgent(agentId, {
    postUrl,
    comment: commentText,
    sessionCookie: process.env.PHANTOMBUSTER_LINKEDIN_SESSION,
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
async function getConnectionSet({ force = false } = {}) {
  if (!isConnectionsCheckAgentConfigured()) return null;
  if (!force && connectionCache.set && Date.now() - connectionCache.ts < CONNECTIONS_TTL_MS) {
    return connectionCache.set;
  }
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

function alnum(str) {
  return String(str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function profileFields(r) {
  const nameParts = [r.firstName, r.lastName].filter(Boolean);
  return {
    name: r.fullName || r.name || (nameParts.length ? nameParts.join(' ') : null),
    role: r.title || r.occupation || r.currentJob || r.jobTitle || r.headline || r.job || null,
    linkedin_url: r.profileUrl || r.linkedinUrl || r.url || null,
    company: r.company || r.companyName || r.currentCompany || null,
  };
}

// Keeps only current founders / executives of the company from raw search results.
function pickTeam(profiles, companyName) {
  const wanted = alnum(companyName);
  const seen = new Set();
  const people = [];
  for (const raw of profiles) {
    const p = profileFields(raw);
    if (!p.name || !p.linkedin_url || !p.role) continue;
    if (!LEADERSHIP_RE.test(p.role) || NOT_CURRENT_RE.test(p.role)) continue;
    if (!alnum(`${p.role} ${p.company || ''}`).includes(wanted)) continue;
    const key = normalizeProfileUrl(p.linkedin_url);
    if (seen.has(key)) continue;
    seen.add(key);
    people.push({
      name: p.name,
      role: p.role,
      linkedin_url: p.linkedin_url,
      is_founder: /founder|\bowner\b/i.test(p.role),
    });
  }
  return people;
}

// Searches LinkedIn for people at a company with a founder / C-level / VP / head-of
// title, using ONE search-export launch, then keeps only results whose headline
// mentions the company and isn't a former/advisory role — a wrong person here would
// later get a connection request.
async function searchTeam(companyName) {
  const agentId = process.env.PHANTOMBUSTER_LINKEDIN_SEARCH_AGENT_ID;
  const roles =
    'founder OR cofounder OR "co-founder" OR CEO OR CTO OR COO OR CFO OR CMO OR chief OR "managing director" OR president OR "head of" OR VP OR "vice president"';
  const keywords = `"${companyName}" AND (${roles})`;
  const searchUrl =
    `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(keywords)}&origin=GLOBAL_SEARCH_HEADER`;
  console.log('[phantombuster] team search url:', searchUrl);

  const profiles = await runSearchAgent(agentId, `team::${companyName.toLowerCase()}`, {
    search: searchUrl,
    sessionCookie: process.env.PHANTOMBUSTER_LINKEDIN_SESSION,
    numberOfResultsPerSearch: 25,
  });

  return pickTeam(profiles, companyName);
}

// Finds a company's LinkedIn page URL through the same search-export agent.
// Returns null when nothing usable comes back (e.g. the agent only supports people search).
async function searchCompanyPage(companyName) {
  const agentId = process.env.PHANTOMBUSTER_LINKEDIN_SEARCH_AGENT_ID;
  const searchUrl =
    `https://www.linkedin.com/search/results/companies/?keywords=${encodeURIComponent(companyName)}&origin=GLOBAL_SEARCH_HEADER`;
  const profiles = await runSearchAgent(agentId, `company-page::${companyName.toLowerCase()}`, {
    search: searchUrl,
    sessionCookie: process.env.PHANTOMBUSTER_LINKEDIN_SESSION,
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
async function fetchPostsFor(url) {
  const activities = await fetchLinkedInActivity([url]);
  return activities
    .map((a) => ({
      text: a.text || a.content || '',
      post_url: a.postUrl || a.url || null,
      date: a.date || null,
      type: a.type || 'post',
    }))
    .filter((a) => a.text)
    .slice(0, 5);
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
  searchCompanyPage,
  fetchPostsFor,
  isMessageAgentConfigured,
  sendLinkedInMessage,
  enrichFounder,
  fetchLinkedInActivity,
  postLinkedInComment,
};
