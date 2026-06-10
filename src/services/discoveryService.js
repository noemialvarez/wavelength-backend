const axios = require('axios');
const supabase = require('../config/supabase');
const apolloService = require('./apolloService');

// Adapters per source — each returns array of signal objects
const adapters = {
  wellfound: fetchWellfound,
  startupticker: fetchStartupticker,
};

async function runDiscovery(runId, sources) {
  console.log(`[discovery] run=${runId} starting — sources: ${sources.join(', ')}`);
  await supabase.from('discovery_runs').update({ status: 'running' }).eq('id', runId);

  const signals = [];
  for (const source of sources) {
    const adapter = adapters[source];
    if (!adapter) {
      console.log(`[discovery] run=${runId} source=${source} — no adapter registered, skipping`);
      continue;
    }
    try {
      const results = await adapter();
      console.log(`[discovery] run=${runId} source=${source} — extracted ${results.length} companies`);
      signals.push(...results.map(r => ({ ...r, source, run_id: runId, status: 'new' })));
    } catch (err) {
      console.error(`[discovery] run=${runId} source=${source} — fetch/parse error: ${err.message}`);
    }
  }

  // Enrich emails via Apollo for signals that have a founder name but no email
  if (apolloService.isConfigured()) {
    for (const signal of signals) {
      if (signal.founder_name && !signal.founder_email) {
        signal.founder_email = await apolloService.findEmail(signal.founder_name, signal.company_name);
      }
    }
  }

  if (signals.length > 0) {
    console.log(`[discovery] run=${runId} — inserting ${signals.length} signal(s) into database`);
    const { error: insertError } = await supabase.from('discovery_signals').insert(signals);
    if (insertError) {
      console.error(`[discovery] run=${runId} — Supabase insert error: ${insertError.message}`);
    } else {
      console.log(`[discovery] run=${runId} — insert successful`);
    }
  } else {
    console.log(`[discovery] run=${runId} — no signals to insert`);
  }

  await supabase
    .from('discovery_runs')
    .update({ status: 'completed', signal_count: signals.length, completed_at: new Date().toISOString() })
    .eq('id', runId);

  console.log(`[discovery] run=${runId} — completed, total signals: ${signals.length}`);
}

async function fetchWellfound() {
  console.log('[discovery] fetchWellfound — no adapter implemented, returning empty');
  return [];
}

async function fetchStartupticker() {
  const url = 'https://www.startupticker.ch/en/news.rss';
  console.log(`[discovery] fetchStartupticker — fetching ${url}`);

  let response;
  try {
    response = await axios.get(url, { timeout: 10000 });
    console.log(`[discovery] fetchStartupticker — HTTP ${response.status} from ${url}`);
  } catch (err) {
    const status = err.response?.status;
    console.error(`[discovery] fetchStartupticker — fetch error${status ? ` (HTTP ${status})` : ''}: ${err.message}`);
    throw err;
  }

  const entries = (response.data.match(/<item>([\s\S]*?)<\/item>/g) || []);
  const items = [];
  for (const entry of entries.slice(0, 20)) {
    const title = (entry.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || [])[1] || '';
    const link = (entry.match(/<link>(.*?)<\/link>/) || [])[1] || '';
    const description = (entry.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/) || [])[1] || '';
    if (title) {
      items.push({
        company_name: title,
        signal_url: link,
        raw_data: { title, description, link },
        founder_name: null,
        founder_email: null,
        linkedin_url: null,
      });
    }
  }

  console.log(`[discovery] fetchStartupticker — parsed ${items.length} companies from ${entries.length} feed entries`);
  return items;
}

module.exports = { runDiscovery };
