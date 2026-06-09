const supabase = require('../config/supabase');
const lemlistService = require('../services/lemlistService');

async function listSequences(req, res) {
  const { data, error } = await supabase
    .from('sequences')
    .select('*, sequence_leads(count)')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
}

async function getSequence(req, res) {
  const { data, error } = await supabase
    .from('sequences')
    .select('*')
    .eq('id', req.params.id)
    .single();

  if (error) return res.status(404).json({ error: 'Sequence not found' });
  res.json(data);
}

async function getSequenceLeads(req, res) {
  const { data, error } = await supabase
    .from('sequence_leads')
    .select('*, leads(name, company, email)')
    .eq('sequence_id', req.params.id)
    .order('added_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
}

async function syncFromLemlist(req, res) {
  const lemlistCampaigns = await lemlistService.listCampaigns();

  const sequenceRows = lemlistCampaigns.map(c => ({
    lemlist_id: c._id,
    name: c.name,
    status: c.status,
    synced_at: new Date().toISOString(),
  }));

  await supabase
    .from('sequences')
    .upsert(sequenceRows, { onConflict: 'lemlist_id' });

  // Sync leads for each campaign
  let totalLeads = 0;
  for (const campaign of lemlistCampaigns) {
    const campaignLeads = await lemlistService.getCampaignLeads(campaign._id);
    const { data: seq } = await supabase
      .from('sequences')
      .select('id')
      .eq('lemlist_id', campaign._id)
      .single();

    if (!seq) continue;

    const leadRows = campaignLeads.map(l => ({
      sequence_id: seq.id,
      lemlist_lead_id: l._id,
      email: l.email,
      status: l.status,
      step: l.currentStep,
      last_event_at: l.lastEmailSentAt,
    }));

    await supabase
      .from('sequence_leads')
      .upsert(leadRows, { onConflict: 'sequence_id,lemlist_lead_id' });

    totalLeads += leadRows.length;
  }

  res.json({ synced_sequences: sequenceRows.length, synced_leads: totalLeads });
}

async function listAllSequenceLeads(req, res) {
  const { data, error } = await supabase
    .from('sequence_leads')
    .select('*, sequences(name), leads(name, company)')
    .order('added_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
}

module.exports = { listSequences, getSequence, getSequenceLeads, syncFromLemlist, listAllSequenceLeads };
