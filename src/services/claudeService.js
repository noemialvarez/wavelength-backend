const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function draftOutreachEmail(lead, positioningContent) {
  const message = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: `You are drafting a personalized cold outreach email on behalf of a founder.

POSITIONING / ABOUT ME:
${positioningContent}

LEAD:
Name: ${lead.name}
Company: ${lead.company}
Role: ${lead.role || 'Founder'}
LinkedIn: ${lead.linkedin_url || 'N/A'}
Notes: ${lead.notes || 'None'}
Enrichment data: ${JSON.stringify(lead.enrichment_data || {})}

Write a short, warm, specific outreach email. No fluff. Max 5 sentences for the body.
Respond with JSON: { "subject": "...", "body": "..." }`,
      },
    ],
  });

  const text = message.content[0].text;
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Claude did not return valid JSON');
  return JSON.parse(jsonMatch[0]);
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

module.exports = { draftOutreachEmail, draftLinkedInComment };
