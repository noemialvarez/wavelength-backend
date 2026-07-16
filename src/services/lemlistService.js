const axios = require('axios');
const logError = require('../utils/logError');

function isConfigured() {
  const key = process.env.LEMLIST_API_KEY;
  return key && key !== 'placeholder' && key.length > 10;
}

function client() {
  return axios.create({
    baseURL: 'https://api.lemlist.com/api',
    auth: { username: '', password: process.env.LEMLIST_API_KEY },
  });
}

// Extract the first paragraph of the email body as the personalized icebreaker
function extractIcebreaker(body) {
  const firstPara = (body || '').split(/\n\n/)[0].replace(/^Hi\s+\w+,?\s*/i, '').trim();
  return firstPara.length > 250 ? firstPara.slice(0, 250) + '…' : firstPara;
}

async function listCampaigns() {
  if (!isConfigured()) {
    console.log('[Lemlist] API key not configured — returning empty campaign list');
    return [];
  }
  const { data } = await client().get('/campaigns');
  return data;
}

async function getCampaignLeads(campaignId) {
  if (!isConfigured()) return [];
  const { data } = await client().get(`/campaigns/${campaignId}/leads`);
  return data;
}


// Email outreach only — LinkedIn sends go through Phantombuster's LinkedIn
// Message Sender instead (see phantombusterService.sendLinkedInMessage),
// since LinkedIn steps on Lemlist require their paid Multichannel tier.
async function addLeadToSequence(lead, draft, campaignId) {
  console.log('LEMLIST_API_KEY present:', !!process.env.LEMLIST_API_KEY);
  campaignId = campaignId || process.env.LEMLIST_DEFAULT_CAMPAIGN_ID;

  if (!isConfigured()) {
    console.log(`[Lemlist] API key not configured — skipping push for ${lead?.email} (campaign: ${campaignId || 'none'})`);
    return { _id: `skipped_${Date.now()}`, skipped: true, reason: 'Lemlist API key not configured' };
  }

  if (!campaignId) {
    console.log(`[Lemlist] No campaign ID provided — skipping push for ${lead?.email}`);
    return { _id: `skipped_${Date.now()}`, skipped: true, reason: 'No sequence ID — add one in Settings' };
  }

  // Lemlist's lead-add endpoint is keyed by email (/campaigns/:id/leads/:email).
  const email = lead.email;
  if (!email) {
    throw new Error(`Lead "${lead.name || lead.id}" has no email address — cannot push to Lemlist.`);
  }

  const payload = {
    firstName: lead.name?.split(' ')[0] || '',
    lastName: lead.name?.split(' ').slice(1).join(' ') || '',
    companyName: lead.company || '',
    icebreaker: extractIcebreaker(draft.body),
    linkedinUrl: lead.linkedin_url || '',
    subject: draft.subject || '',
    emailBody: draft.body || '',
  };

  console.log(`[Lemlist] Pushing ${email} to campaign ${campaignId}`, JSON.stringify(payload));
  try {
    const { data } = await client().post(`/campaigns/${campaignId}/leads/${encodeURIComponent(email)}`, payload);
    return data;
  } catch (err) {
    const status = err?.response?.status;
    console.error(`[Lemlist] ${status || 'unknown'} response body:`, JSON.stringify(err?.response?.data));
    throw err;
  }
}

module.exports = { listCampaigns, getCampaignLeads, addLeadToSequence };
