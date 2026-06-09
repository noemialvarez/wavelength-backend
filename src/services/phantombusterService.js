const axios = require('axios');

const pb = axios.create({
  baseURL: 'https://api.phantombuster.com/api/v2',
  headers: { 'X-Phantombuster-Key': process.env.PHANTOMBUSTER_API_KEY },
});

async function launchAgent(agentId, args = {}) {
  const { data } = await pb.post(`/agents/${agentId}/launch`, { arguments: args });
  return data;
}

async function waitForAgent(agentId, containerId, pollMs = 3000, maxWaitMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const { data } = await pb.get(`/containers/${containerId}`);
    if (data.status === 'finished') return data;
    if (data.status === 'error') throw new Error(`Phantombuster agent error: ${data.output}`);
    await new Promise(r => setTimeout(r, pollMs));
  }
  throw new Error('Phantombuster agent timed out');
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

module.exports = { enrichFounder, fetchLinkedInActivity, postLinkedInComment };
