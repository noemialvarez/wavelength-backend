const axios = require('axios');

const pb = axios.create({
  baseURL: 'https://api.phantombuster.com/api/v2',
  headers: { 'X-Phantombuster-Key': process.env.PHANTOMBUSTER_API_KEY },
});

// Per-company result cache: companyName -> { result, ts }
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
  console.log('[phantombuster] request body:', JSON.stringify(body));

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

async function launchFounderSearch(companyName, searchTitle) {
  const title = (searchTitle && String(searchTitle).trim()) || 'founder';
  const cacheKey = `${companyName}::${title.toLowerCase()}`;

  // 1. Return per-(company, title) cached result if still fresh
  const cached = resultCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    console.log('[phantombuster] cache hit for', cacheKey, '— returning cached result');
    return cached.result;
  }

  const agentId = process.env.PHANTOMBUSTER_LINKEDIN_SEARCH_AGENT_ID;

  // 2. If the agent is already running, wait for it then re-check cache
  if (agentInFlight.has(agentId)) {
    console.log('[phantombuster] agent already running, waiting for in-flight run to finish');
    await agentInFlight.get(agentId).catch(() => {});
    const fresh = resultCache.get(cacheKey);
    if (fresh && Date.now() - fresh.ts < CACHE_TTL_MS) return fresh.result;
  }

  // 3. Enforce 30s minimum gap between launches
  const lastLaunch = agentLastLaunch.get(agentId) || 0;
  const msSinceLast = Date.now() - lastLaunch;
  if (msSinceLast < MIN_LAUNCH_INTERVAL_MS) {
    const waitMs = MIN_LAUNCH_INTERVAL_MS - msSinceLast;
    console.log(`[phantombuster] rate limit cooldown: waiting ${Math.ceil(waitMs / 1000)}s before next launch`);
    await new Promise(r => setTimeout(r, waitMs));
  }

  // 4. Launch and register the in-flight promise so concurrent callers queue behind it
  const runPromise = (async () => {
    agentLastLaunch.set(agentId, Date.now());

    // Quote multi-word titles so LinkedIn search treats them as one phrase
    const titleKeyword = title.includes(' ') ? `"${title}"` : title;
    const searchUrl =
      `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(titleKeyword)}+${encodeURIComponent(companyName)}&origin=GLOBAL_SEARCH_HEADER`;
    console.log('[phantombuster] search url:', searchUrl);

    const launch = await launchAgent(agentId, {
      search: searchUrl,
      sessionCookie: process.env.PHANTOMBUSTER_LINKEDIN_SESSION,
      numberOfResultsPerSearch: 10,
    });

    const agentOutput = await waitForAgent(agentId, launch.containerId, 5000, 180000);
    const profiles = await fetchS3Results(agentOutput.output);
    const result = pickProfile(profiles, searchTitle);

    resultCache.set(cacheKey, { result, ts: Date.now() });
    return result;
  })().finally(() => {
    agentInFlight.delete(agentId);
  });

  agentInFlight.set(agentId, runPromise);
  return runPromise;
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

module.exports = { getAgentOutput, launchFounderSearch, enrichFounder, fetchLinkedInActivity, postLinkedInComment };
