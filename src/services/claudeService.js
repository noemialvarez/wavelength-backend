const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function draftOutreachEmail(lead, positioningContent) {
  const firstName = lead.name?.split(' ')[0] || lead.name || 'there';

  const message = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 800,
    messages: [
      {
        role: 'user',
        content: `Draft a personalized cold outreach email. Swiss German business context.

ABOUT THE SENDER:
${positioningContent}

LEAD:
First name: ${firstName}
Company: ${lead.company || 'their company'}
Role: ${lead.role || 'Founder'}
Signal / recent news: ${lead.notes || ''}

RULES:
- Greeting: "Hi ${firstName}," — never use last name
- Line 1: one specific sentence referencing their signal/news. Be concrete.
- Line 2: one sentence on why the sender is relevant to them right now.
- Line 3: clear CTA — propose a 15-minute call this week or next.
- Sign off: "Best," on its own line (no name — sender adds it manually)
- Short sentences. Direct. Warm but not effusive.
- Max 3 sentences in the body (not counting greeting and sign-off).
- No "I hope this finds you well". No hollow compliments. No buzzwords.
- Subject: specific and concise, tied to the signal. No clickbait.

Respond with ONLY valid JSON — no markdown, no explanation:
{ "subject": "...", "body": "..." }`,
      },
    ],
  });

  const raw = message.content[0].text.trim();
  // Strip markdown code fences if model wraps response
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Claude did not return valid JSON. Got: ${raw.slice(0, 300)}`);
  return JSON.parse(match[0]);
}

async function draftLinkedInComment(activity) {
  const message = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 256,
    messages: [
      {
        role: 'user',
        content: `Draft a short, genuine LinkedIn comment for this post by ${activity.watched_prospects?.name || 'a prospect'}.

POST CONTENT:
${activity.content}

Rules:
- Max 2 sentences
- Sound human, not AI-generated
- Add a specific observation or question
- No hashtags or emojis

Return only the comment text, nothing else.`,
      },
    ],
  });

  return message.content[0].text.trim();
}

async function findCompaniesByDescription({ description, industry, geography, audience, companySize }) {
  const message = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 2048,
    messages: [
      {
        role: 'user',
        content: `You are a B2B sales researcher. Generate a list of 10 real companies that match the following criteria.

CRITERIA:
- Description: ${description}
- Industry: ${industry || 'any'}
- Geography: ${geography || 'any'}
- Audience: ${audience || 'any'}
- Company size: ${companySize || 'any'}

Return ONLY a valid JSON array — no markdown, no explanation:
[
  {
    "company_name": "...",
    "website": "...",
    "industry": "...",
    "geography": "...",
    "description": "...",
    "why_match": "..."
  }
]

Rules:
- Only real, verifiable companies
- "why_match" must explain specifically why this company fits the description
- "website" must be the real homepage domain (e.g. "https://example.com")
- Return exactly 10 entries`,
      },
    ],
  });

  const raw = message.content[0].text.trim();
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const match = cleaned.match(/\[[\s\S]*\]/);
  if (!match) throw new Error(`Claude did not return a valid JSON array. Got: ${raw.slice(0, 300)}`);
  return JSON.parse(match[0]);
}

module.exports = { draftOutreachEmail, draftLinkedInComment, findCompaniesByDescription };
