const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const supabase = require('../config/supabase');
const apolloService = require('./apolloService');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Keys must match the lowercased, space-stripped source names sent by the frontend
const adapters = {
  wellfound: fetchWellfound,
  'startupticker.ch': fetchStartupticker,
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

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

async function parseWithClaude(text, sourceLabel) {
  const truncated = text.slice(0, 80000);
  console.log(`[discovery] parseWithClaude (${sourceLabel}) — sending ${truncated.length} chars to Claude`);

  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: `Extract startup signal data from this web page content.

Source: ${sourceLabel}
Page content:
${truncated}

Return a JSON array of recently funded or newsworthy startups. For each include:
- company_name: the startup name
- signal_description: one sentence describing the signal (e.g. "Raised CHF 4M seed round led by Redalpine")
- signal_type: one of "Funding", "Key hire", "Product launch", "Other"
- source_url: the article or announcement URL if visible, otherwise null

Respond with ONLY a valid JSON array — no markdown, no explanation.
If no startups are found return: []`,
    }],
  });

  const raw = message.content[0].text.trim();
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const match = cleaned.match(/\[[\s\S]*\]/);
  if (!match) {
    console.warn(`[discovery] parseWithClaude (${sourceLabel}) — no JSON array in response: ${raw.slice(0, 300)}`);
    return [];
  }
  return JSON.parse(match[0]);
}

function toSignals(extracted, fallbackUrl) {
  return extracted.map(e => ({
    company_name: e.company_name,
    signal_description: e.signal_description,
    signal_type: e.signal_type,
    signal_url: e.source_url || fallbackUrl,
    founder_name: null,
    founder_email: null,
    linkedin_url: null,
  }));
}

async function fetchStartupticker() {
  const url = 'https://startupticker.ch/en/news';
  console.log(`[discovery] fetchStartupticker — fetching ${url}`);

  let response;
  try {
    response = await axios.get(url, {
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WavelengthBot/1.0)' },
    });
    console.log(`[discovery] fetchStartupticker — HTTP ${response.status} from ${url}`);
  } catch (err) {
    const status = err.response?.status;
    console.error(`[discovery] fetchStartupticker — fetch error${status ? ` (HTTP ${status})` : ''}: ${err.message}`);
    throw err;
  }

  const text = stripHtml(response.data);
  console.log(`[discovery] fetchStartupticker — ${text.length} chars of text after stripping HTML`);

  const extracted = await parseWithClaude(text, 'Startupticker.ch');
  console.log(`[discovery] fetchStartupticker — Claude extracted ${extracted.length} companies`);
  return toSignals(extracted, url);
}

async function fetchWellfound() {
  const url = 'https://wellfound.com/companies?filter_recently_funded=true';
  console.log(`[discovery] fetchWellfound — fetching ${url}`);

  let response;
  try {
    response = await axios.get(url, {
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WavelengthBot/1.0)' },
    });
    console.log(`[discovery] fetchWellfound — HTTP ${response.status} from ${url}`);
  } catch (err) {
    const status = err.response?.status;
    console.error(`[discovery] fetchWellfound — fetch error${status ? ` (HTTP ${status})` : ''}: ${err.message}`);
    throw err;
  }

  const text = stripHtml(response.data);
  console.log(`[discovery] fetchWellfound — ${text.length} chars of text after stripping HTML`);

  const extracted = await parseWithClaude(text, 'Wellfound');
  console.log(`[discovery] fetchWellfound — Claude extracted ${extracted.length} companies`);
  return toSignals(extracted, url);
}

module.exports = { runDiscovery };
