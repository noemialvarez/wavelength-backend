const cron = require('node-cron');
const supabase = require('../config/supabase');
const phantombusterService = require('./phantombusterService');
const logError = require('../utils/logError');

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

// Normalises a Phantombuster connections-export profile URL for comparison —
// strips protocol/trailing slash/query string so minor formatting differences
// (http vs https, trailing slash) don't cause false negatives.
function normalizeProfileUrl(url) {
  if (!url) return '';
  return url.replace(/^https?:\/\//i, '').replace(/\/+$/, '').split('?')[0].toLowerCase();
}

// Job A: for leads with a pending connection request, check whether the
// connection has been accepted yet via Phantombuster's connections export.
// No-op (logs once) until PHANTOMBUSTER_CONNECTIONS_AGENT_ID is configured.
async function checkConnectionAcceptance() {
  if (!phantombusterService.isConnectionsCheckAgentConfigured()) {
    console.log('[cron] checkConnectionAcceptance skipped — PHANTOMBUSTER_CONNECTIONS_AGENT_ID not set');
    return;
  }

  try {
    const { data: pending, error } = await supabase
      .from('leads')
      .select('id, linkedin_url')
      .eq('linkedin_connection_status', 'requested')
      .not('linkedin_url', 'is', null);
    if (error) { logError('checkConnectionAcceptance fetch pending', error); return; }
    if (!pending.length) return;

    const connections = await phantombusterService.fetchAcceptedConnections();
    if (!connections) return;
    const connectedUrls = new Set(
      connections.map((c) => normalizeProfileUrl(c.profileUrl || c.linkedinUrl || c.url)).filter(Boolean),
    );

    const now = new Date().toISOString();
    for (const lead of pending) {
      if (!connectedUrls.has(normalizeProfileUrl(lead.linkedin_url))) continue;
      const { error: updateErr } = await supabase
        .from('leads')
        .update({ linkedin_connection_status: 'accepted', linkedin_connection_accepted_at: now })
        .eq('id', lead.id);
      if (updateErr) logError('checkConnectionAcceptance update', updateErr);
      else console.log(`[cron] connection accepted for lead ${lead.id}`);
    }
  } catch (err) {
    logError('checkConnectionAcceptance (thrown)', err);
  }
}

// Job B: leads whose connection was accepted 4+ hours ago and haven't had a
// message drafted yet move from 'waiting' to 'ready', surfacing them in the
// frontend's LinkedIn message queue.
async function promoteReadyMessages() {
  try {
    const cutoff = new Date(Date.now() - FOUR_HOURS_MS).toISOString();
    const { data, error } = await supabase
      .from('leads')
      .update({ linkedin_message_status: 'ready' })
      .eq('linkedin_connection_status', 'accepted')
      .eq('linkedin_message_status', 'waiting')
      .lte('linkedin_connection_accepted_at', cutoff)
      .select('id');
    if (error) { logError('promoteReadyMessages', error); return; }
    if (data.length) console.log(`[cron] promoted ${data.length} lead(s) to linkedin_message_status=ready`);
  } catch (err) {
    logError('promoteReadyMessages (thrown)', err);
  }
}

function start() {
  // Every 15 minutes: cheap DB-only status flip, safe to run often.
  cron.schedule('*/15 * * * *', promoteReadyMessages);
  // Every 30 minutes: launches a Phantombuster agent when configured, so kept
  // less frequent to stay within Phantombuster's usage/parallelism limits.
  cron.schedule('*/30 * * * *', checkConnectionAcceptance);
  console.log('[cron] scheduled: promoteReadyMessages (*/15 * * * *), checkConnectionAcceptance (*/30 * * * *)');
}

module.exports = { start, checkConnectionAcceptance, promoteReadyMessages };
