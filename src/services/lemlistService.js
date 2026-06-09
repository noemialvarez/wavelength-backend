const axios = require('axios');

const lemlist = axios.create({
  baseURL: 'https://api.lemlist.com/api',
  auth: { username: '', password: process.env.LEMLIST_API_KEY },
});

async function listCampaigns() {
  const { data } = await lemlist.get('/campaigns');
  return data;
}

async function getCampaignLeads(campaignId) {
  const { data } = await lemlist.get(`/campaigns/${campaignId}/leads`);
  return data;
}

async function addLeadToSequence(lead, draft) {
  const campaignId = process.env.LEMLIST_DEFAULT_CAMPAIGN_ID;
  const { data } = await lemlist.post(`/campaigns/${campaignId}/leads/${lead.email}`, {
    firstName: lead.name?.split(' ')[0] || '',
    lastName: lead.name?.split(' ').slice(1).join(' ') || '',
    companyName: lead.company || '',
    icebreaker: draft.body,
    subject: draft.subject,
    linkedinUrl: lead.linkedin_url || '',
  });
  return data;
}

module.exports = { listCampaigns, getCampaignLeads, addLeadToSequence };
