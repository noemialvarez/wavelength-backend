const axios = require('axios');
const supabase = require('../config/supabase');
const apolloService = require('./apolloService');

// Adapters per source — each returns array of signal objects
const adapters = {
  wellfound: fetchWellfound,
  startupticker: fetchStartupticker,
};

async function runDiscovery(runId, sources) {
  await supabase.from('discovery_runs').update({ status: 'running' }).eq('id', runId);

  const signals = [];
  for (const source of sources) {
    const adapter = adapters[source];
    if (!adapter) continue;
    try {
      const results = await adapter();
      signals.push(...results.map(r => ({ ...r, source, run_id: runId, status: 'new' })));
    } catch (err) {
      console.error(`Discovery source ${source} failed:`, err.message);
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
    await supabase.from('discovery_signals').insert(signals);
  }

  await supabase
    .from('discovery_runs')
    .update({ status: 'completed', signal_count: signals.length, completed_at: new Date().toISOString() })
    .eq('id', runId);
}

async function fetchWellfound() {
  // Wellfound doesn't have a public API — scraping or using their GraphQL endpoint
  // requires auth cookies. Return empty until a real session is configured.
  // TODO: implement via Phantombuster scraper agent or partner API
  return [];
}

async function fetchStartupticker() {
  // Startupticker.ch has an RSS feed for news
  const { data } = await axios.get('https://www.startupticker.ch/en/news.rss', {
    timeout: 10000,
  });

  // Very basic RSS parse — replace with rss-parser if needed
  const items = [];
  const entries = data.match(/<item>([\s\S]*?)<\/item>/g) || [];
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
  return items;
}

module.exports = { runDiscovery };
