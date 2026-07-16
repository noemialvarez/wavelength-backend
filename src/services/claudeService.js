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

async function draftLinkedInOutreachMessage(lead) {
  const firstName = lead.name?.split(' ')[0] || lead.name || 'there';

  const message = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 500,
    messages: [
      {
        role: 'user',
        content: `Draft a personalized LinkedIn message to send after a connection request was just accepted.

RECIPIENT:
First name: ${firstName}
Company: ${lead.company || 'their company'}
Role: ${lead.role || ''}
LinkedIn headline / notes: ${lead.notes || ''}

PURPOSE OF CONTACT (why we're reaching out — the message must clearly serve this):
${lead.purpose_of_contact || 'General introduction'}

RULES:
- Greeting: "Hi ${firstName}," on its own line
- Thank them briefly for connecting, then get straight to the purpose of contact above
- Personalize using their role/company/notes where relevant — be specific, not generic
- Conversational LinkedIn DM tone: shorter and less formal than an email
- Max 4 sentences total (not counting greeting and sign-off)
- Clear, low-friction ask tied to the purpose of contact
- Sign off: "Best," on its own line (no name)
- No "I hope this finds you well". No hollow compliments. No buzzwords.

Respond with ONLY the message text — no JSON, no markdown, no explanation.`,
      },
    ],
  });

  return message.content[0].text.trim();
}

async function draftLinkedInReminder(lead) {
  const firstName = lead.name?.split(' ')[0] || lead.name || 'there';

  const message = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 300,
    messages: [
      {
        role: 'user',
        content: `Draft a short, friendly follow-up LinkedIn message. We messaged this person 3+ days ago and haven't heard back.

RECIPIENT:
First name: ${firstName}
Company: ${lead.company || 'their company'}

ORIGINAL MESSAGE SENT:
${lead.linkedin_message_draft || '(not available)'}

PURPOSE OF CONTACT:
${lead.purpose_of_contact || 'General introduction'}

RULES:
- Greeting: "Hi ${firstName}," on its own line
- Max 2 sentences total (not counting greeting and sign-off)
- Light, no-pressure nudge — acknowledge they're busy, restate the ask in one line
- Do not repeat the full original message, just reference it briefly
- Sign off: "Best," on its own line (no name)

Respond with ONLY the message text — no JSON, no markdown, no explanation.`,
      },
    ],
  });

  return message.content[0].text.trim();
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
    max_tokens: 4096,
    system: 'You are a B2B sales researcher. You respond with raw JSON only — no preamble, no disclaimer, no explanation, no markdown. Your entire response must be a valid JSON array starting with [ and ending with ].',
    messages: [
      {
        role: 'user',
        content: `Generate a list of 20 real companies that match these criteria:
- Description: ${description}
- Industry: ${industry || 'any'}
- Geography: ${geography || 'any'}
- Audience: ${audience || 'any'}
${companySize ? `- Target company size: ${companySize} employees. Only include companies you are highly confident have ${companySize} employees. If you are not certain of a company's size, exclude it. It is better to return 3 correct results than 10 wrong ones.` : ''}
${audience === 'B2B' ? `- Audience is B2B: do NOT return consumer brands. Victorinox, Swatch, Nestlé, Lindt, Caran d'Ache, Nespresso, Logitech and any other B2C lifestyle or consumer product brand must be excluded when B2B is selected. Only return companies whose primary customers are other businesses.` : ''}

Do not add any text before or after the JSON array.

Return this exact structure:
[
  {
    "company_name": "string",
    "website": "string",
    "industry": "string",
    "geography": "string",
    "description": "string",
    "why_match": "string"
  }
]`,
      },
    ],
  });

  const raw = message.content[0].text.trim();
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const match = cleaned.match(/\[[\s\S]*\]/);
  if (!match) throw new Error(`Claude did not return a valid JSON array. Got: ${raw.slice(0, 300)}`);
  return JSON.parse(match[0]);
}

module.exports = {
  draftOutreachEmail,
  draftLinkedInOutreachMessage,
  draftLinkedInReminder,
  draftLinkedInComment,
  findCompaniesByDescription,
};
