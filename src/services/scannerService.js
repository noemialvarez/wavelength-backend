const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Keys must match the lowercased, space-stripped source names sent by the frontend
// e.g. "Startupticker.ch" → "startupticker.ch", "Wellfound" → "wellfound"
const adapters = {
  'startupticker.ch': fetchStartupticker,
  wellfound: fetchWellfound,
};

function hasAdapter(source) {
  return source in adapters;
}

async function runAdapter(source) {
  const fn = adapters[source];
  if (!fn) throw new Error(`No adapter registered for source: ${source}`);
  return fn();
}

// --- Helpers ---

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
  console.log(`[scanner] parseWithClaude (${sourceLabel}) — sending ${truncated.length} chars to Claude`);

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
    console.warn(`[scanner] parseWithClaude (${sourceLabel}) — no JSON array in response: ${raw.slice(0, 300)}`);
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

async function fetchPage(url, label) {
  console.log(`[scanner] ${label} — fetching ${url}`);
  try {
    const response = await axios.get(url, {
      timeout: 15000,
      headers: { 'User-Agent': BROWSER_UA },
    });
    console.log(`[scanner] ${label} — HTTP ${response.status} from ${url}`);
    return response.data;
  } catch (err) {
    const status = err.response?.status;
    console.error(`[scanner] ${label} — fetch error${status ? ` (HTTP ${status})` : ''}: ${err.message}`);
    throw err;
  }
}

// --- Adapters ---

async function fetchStartupticker() {
  const url = 'https://startupticker.ch/en/news';
  const html = await fetchPage(url, 'fetchStartupticker');
  const text = stripHtml(html);
  console.log(`[scanner] fetchStartupticker — ${text.length} chars after stripping HTML`);
  const extracted = await parseWithClaude(text, 'Startupticker.ch');
  console.log(`[scanner] fetchStartupticker — Claude extracted ${extracted.length} companies`);
  return toSignals(extracted, url);
}

async function fetchWellfound() {
  const url = 'https://wellfound.com/companies?filter_recently_funded=true';
  const html = await fetchPage(url, 'fetchWellfound');
  const text = stripHtml(html);
  console.log(`[scanner] fetchWellfound — ${text.length} chars after stripping HTML`);
  const extracted = await parseWithClaude(text, 'Wellfound');
  console.log(`[scanner] fetchWellfound — Claude extracted ${extracted.length} companies`);
  return toSignals(extracted, url);
}

module.exports = { hasAdapter, runAdapter };
