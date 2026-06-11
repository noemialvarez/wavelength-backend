const axios = require('axios');

const pb = axios.create({
  baseURL: 'https://api.phantombuster.com/api/v2',
  headers: { 'X-Phantombuster-Key': process.env.PHANTOMBUSTER_API_KEY },
});

async function launchAgent(agentId, args = {}) {
  const body = { id: agentId, argument: JSON.stringify(args) };
  console.log('[phantombuster] request body:', JSON.stringify(body));
  try {
    const { data } = await pb.post('/agents/launch', body);
    return data;
  } catch (error) {
    console.log('[phantombuster] error response:', error.response ? error.response.data : null);
    throw error;
  }
}

async function waitForAgent(agentId, containerId, pollMs = 5000, maxWaitMs = 180000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const { data } = await pb.get(`/containers/fetch-output?id=${containerId}`);
    console.log('[phantombuster] container output:', JSON.stringify(data));
    if (data.status === 'finished') return data;
    if (data.status === 'error') throw new Error(`Phantombuster agent error: ${data.output}`);
    await new Promise(r => setTimeout(r, pollMs));
  }
  throw new Error('Phantombuster agent timed out');
}

async function getAgentOutput(agentId) {
  const { data } = await pb.get(`/agents/${agentId}/output`);
  return data;
}

function parseFounderOutput(outputStr) {
  var lines = (outputStr || '').split('\n').filter(Boolean);
  var results = [];
  for (var i = 0; i < lines.length; i++) {
    try {
      var parsed = JSON.parse(lines[i]);
      if (Array.isArray(parsed)) results.push.apply(results, parsed);
      else results.push(parsed);
    } catch (e) {}
  }
  var founderRe = /co[\s-]?founder|founder|ceo/i;
  var founderMatch = results.find(function(r) {
    var title = r.title ? r.title : (r.occupation ? r.occupation : (r.currentJob ? r.currentJob : ''));
    return founderRe.test(title);
  });
  var finalResult = founderMatch ? founderMatch : (results[0] ? results[0] : null);
  console.log('[phantombuster] parsed result:', JSON.stringify(finalResult));
  return finalResult;
}

async function launchFounderSearch(companyName) {
  const agentId = process.env.PHANTOMBUSTER_LINKEDIN_SEARCH_AGENT_ID;

  // Use cached results from last run if less than 24 hours old
  try {
    const { data: cached } = await pb.get(`/agents/fetch-output?id=${agentId}`);
    const endedAt = cached.endedAt ? new Date(cached.endedAt).getTime() : 0;
    const ageMs = Date.now() - endedAt;
    if (cached.output && ageMs < 24 * 60 * 60 * 1000) {
      console.log('[phantombuster] using cached results, age:', Math.round(ageMs / 60000), 'min');
      return parseFounderOutput(cached.output);
    }
    console.log('[phantombuster] cached results too old or missing, launching new run');
  } catch (e) {
    console.log('[phantombuster] could not fetch cached results:', e.message);
  }

  const searchUrl =
    `https://www.linkedin.com/search/results/people/?keywords=founder+${encodeURIComponent(companyName)}&origin=GLOBAL_SEARCH_HEADER`;

  const launch = await launchAgent(agentId, {
    search: searchUrl,
    sessionCookie: process.env.PHANTOMBUSTER_LINKEDIN_SESSION,
    numberOfResultsPerSearch: 10,
  });

  const agentOutput = await waitForAgent(agentId, launch.containerId, 5000, 180000);
  return parseFounderOutput(agentOutput.output);
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
  // Requires a dedicated Phantombuster agent for posting comments
  const agentId = process.env.PHANTOMBUSTER_COMMENT_AGENT_ID;
  const launch = await launchAgent(agentId, {
    postUrl,
    comment: commentText,
    sessionCookie: process.env.PHANTOMBUSTER_LINKEDIN_SESSION,
  });
  return waitForAgent(agentId, launch.containerId);
}

module.exports = { getAgentOutput, launchFounderSearch, enrichFounder, fetchLinkedInActivity, postLinkedInComment };
