const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Keys must match the lowercased, space-stripped source names sent by the frontend
// e.g. "Startupticker.ch" → "startupticker.ch", "Wellfound" → "wellfound"
const adapters = {
  'startupticker.ch': fetchStartupticker,
  wellfound: fetchTechCrunchStartups,
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

async function parseWithClaude(text, sourceLabel, maxChars = 80000) {
  const truncated = text.slice(0, maxChars);
  console.log(`[scanner] parseWithClaude (${sourceLabel}) — sending ${truncated.length} chars to Claude`);

  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: `Extract all startup company names mentioned in this text that have recently raised funding or had significant news.

Source: ${sourceLabel}
Page content:
${truncated}

Return a JSON array of objects with fields: company_name, signal_description, signal_type, source_url.
- company_name: the startup name
- signal_description: one sentence describing the signal (e.g. "Raised CHF 4M seed round led by Redalpine")
- signal_type: one of "Funding", "Key hire", "Product launch", "Other"
- source_url: the article or announcement URL if visible, otherwise null

Respond with ONLY a valid JSON array — no markdown, no explanation.
If none found return: []`,
    }],
  });

  const raw = message.content[0].text.trim();
  // Extract content from inside code fences if present (handles text before/after the fence block)
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenceMatch ? fenceMatch[1].trim() : raw;
  const match = candidate.match(/\[[\s\S]*\]/);
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
  const extracted = await parseWithClaude(text, 'Startupticker.ch', 15000);
  console.log(`[scanner] fetchStartupticker — Claude extracted ${extracted.length} companies`);
  return toSignals(extracted, url);
}

async function fetchTechCrunchStartups() {
  const url = 'https://techcrunch.com/tag/startups/';
  const html = await fetchPage(url, 'fetchTechCrunchStartups');
  const text = stripHtml(html);
  console.log(`[scanner] fetchTechCrunchStartups — ${text.length} chars after stripping HTML`);
  const extracted = await parseWithClaude(text, 'TechCrunch Startups', 15000);
  console.log(`[scanner] fetchTechCrunchStartups — Claude extracted ${extracted.length} companies`);
  return toSignals(extracted, url);
}

module.exports = { hasAdapter, runAdapter };
