const supabase = require('../config/supabase');
const lemlistService = require('../services/lemlistService');
const logError = require('../utils/logError');

async function listSequences(req, res) {
  try {
    const { data, error } = await supabase
      .from('sequences')
      .select('*, sequence_leads(count)')
      .order('created_at', { ascending: false });

    if (error) { logError('listSequences', error); return res.status(500).json({ error: error.message }); }
    res.json(data);
  } catch (err) {
    logError('listSequences (thrown)', err);
    res.status(500).json({ error: err.message });
  }
}

async function getSequence(req, res) {
  try {
    const { data, error } = await supabase
      .from('sequences')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error) { logError('getSequence', error); return res.status(404).json({ error: 'Sequence not found' }); }
    res.json(data);
  } catch (err) {
    logError('getSequence (thrown)', err);
    res.status(500).json({ error: err.message });
  }
}

async function getSequenceLeads(req, res) {
  try {
    const { data, error } = await supabase
      .from('sequence_leads')
      .select('*, leads(name, company, email)')
      .eq('sequence_id', req.params.id)
      .order('added_at', { ascending: false });

    if (error) { logError('getSequenceLeads', error); return res.status(500).json({ error: error.message }); }
    res.json(data);
  } catch (err) {
    logError('getSequenceLeads (thrown)', err);
    res.status(500).json({ error: err.message });
  }
}

async function listAllSequenceLeads(req, res) {
  try {
    const { data, error } = await supabase
      .from('sequence_leads')
      .select('*, sequences(name), leads(name, company)')
      .order('added_at', { ascending: false });

    if (error) { logError('listAllSequenceLeads', error); return res.status(500).json({ error: error.message }); }
    res.json(data);
  } catch (err) {
    logError('listAllSequenceLeads (thrown)', err);
    res.status(500).json({ error: err.message });
  }
}

async function syncFromLemlist(req, res) {
  try {
    const lemlistCampaigns = await lemlistService.listCampaigns();

    const sequenceRows = lemlistCampaigns.map(c => ({
      lemlist_id: c._id,
      name: c.name,
      status: c.status,
      synced_at: new Date().toISOString(),
    }));

    const { error: upsertError } = await supabase
      .from('sequences')
      .upsert(sequenceRows, { onConflict: 'lemlist_id' });

    if (upsertError) { logError('syncFromLemlist upsert sequences', upsertError); return res.status(500).json({ error: upsertError.message }); }

    let totalLeads = 0;
    for (const campaign of lemlistCampaigns) {
      const campaignLeads = await lemlistService.getCampaignLeads(campaign._id);
      const { data: seq, error: seqError } = await supabase
        .from('sequences')
        .select('id')
        .eq('lemlist_id', campaign._id)
        .single();

      if (seqError) { logError(`syncFromLemlist fetch seq ${campaign._id}`, seqError); continue; }
      if (!seq) continue;

      const leadRows = campaignLeads.map(l => ({
        sequence_id: seq.id,
        lemlist_lead_id: l._id,
        email: l.email,
        status: l.status,
        step: l.currentStep,
        last_event_at: l.lastEmailSentAt,
      }));

      const { error: leadUpsertError } = await supabase
        .from('sequence_leads')
        .upsert(leadRows, { onConflict: 'sequence_id,lemlist_lead_id' });

      if (leadUpsertError) logError(`syncFromLemlist upsert leads for ${campaign._id}`, leadUpsertError);
      else totalLeads += leadRows.length;
    }

    res.json({ synced_sequences: sequenceRows.length, synced_leads: totalLeads });
  } catch (err) {
    logError('syncFromLemlist (thrown)', err);
    res.status(500).json({ error: err.message });
  }
}

module.exports = { listSequences, getSequence, getSequenceLeads, listAllSequenceLeads, syncFromLemlist };
