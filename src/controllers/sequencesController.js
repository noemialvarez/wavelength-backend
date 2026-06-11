const supabase = require('../config/supabase');
const lemlistService = require('../services/lemlistService');
const logError = require('../utils/logError');

const STATUS_MAP = {
  contacted:     'Active',
  inProgress:    'Active',
  interested:    'Replied',
  notInterested: 'Unsubscribed',
  unsubscribed:  'Unsubscribed',
  bounced:       'Bounced',
};

function mapStatus(raw) {
  return STATUS_MAP[raw] ?? 'Active';
}

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
    // Read the saved campaign ID — same source as the Lemlist push
    const { data: settings } = await supabase
      .from('positioning').select('lemlist_campaign_id').limit(1).maybeSingle();

    const campaignId = settings?.lemlist_campaign_id || process.env.LEMLIST_DEFAULT_CAMPAIGN_ID;
    if (!campaignId) {
      return res.status(400).json({ error: 'No campaign ID configured — save one in Email Outreach Settings.' });
    }
    console.log(`[syncFromLemlist] campaign: ${campaignId}`);

    // Upsert the campaign row (name comes from the campaigns list)
    const allCampaigns = await lemlistService.listCampaigns();
    const meta = allCampaigns.find(c => c._id === campaignId);
    const { error: seqErr } = await supabase.from('sequences').upsert(
      { lemlist_id: campaignId, name: meta?.name ?? campaignId, status: meta?.status ?? null, synced_at: new Date().toISOString() },
      { onConflict: 'lemlist_id' }
    );
    if (seqErr) { logError('syncFromLemlist upsert sequence', seqErr); return res.status(500).json({ error: seqErr.message }); }

    const { data: seq, error: fetchSeqErr } = await supabase
      .from('sequences').select('id').eq('lemlist_id', campaignId).single();
    if (fetchSeqErr) { logError('syncFromLemlist fetch seq row', fetchSeqErr); return res.status(500).json({ error: fetchSeqErr.message }); }

    // Fetch leads from Lemlist — only _id and state are available
    const leads = await lemlistService.getCampaignLeads(campaignId);
    console.log(`[syncFromLemlist] fetched ${leads.length} leads from Lemlist`);
    console.log('[syncFromLemlist] first lead raw:', JSON.stringify(leads[0]));

    // Upsert status/step/last_event_at for each lead
    const statusRows = leads.map(l => ({
      sequence_id:     seq.id,
      lemlist_lead_id: l._id,
      status:          mapStatus(l.state ?? l.status),
      step:            String(l.currentStep ?? l.step ?? ''),
      last_event_at:   l.lastEmailSentAt ?? l.updatedAt ?? null,
    }));

    const { error: leadErr } = await supabase
      .from('sequence_leads')
      .upsert(statusRows, { onConflict: 'sequence_id,lemlist_lead_id' });
    if (leadErr) { logError('syncFromLemlist upsert leads', leadErr); return res.status(500).json({ error: leadErr.message }); }

    // Back-fill lead_id / name / company / email by matching lemlist_lead_id
    // against outreach_drafts.lemlist_id (set when the lead was pushed)
    const lemlistIds = leads.map(l => l._id).filter(Boolean);
    if (lemlistIds.length > 0) {
      const { data: matchedDrafts } = await supabase
        .from('outreach_drafts')
        .select('lemlist_id, lead_id, leads(id, name, company, email)')
        .in('lemlist_id', lemlistIds);

      for (const d of matchedDrafts ?? []) {
        if (!d.lemlist_id || !d.lead_id) continue;
        await supabase.from('sequence_leads')
          .update({
            lead_id: d.lead_id,
            name:    d.leads?.name    ?? '',
            company: d.leads?.company ?? '',
            email:   d.leads?.email   ?? '',
          })
          .eq('sequence_id', seq.id)
          .eq('lemlist_lead_id', d.lemlist_id);
      }
      console.log(`[syncFromLemlist] back-filled ${(matchedDrafts ?? []).length} leads from outreach_drafts`);
    }

    res.json({ synced_sequences: 1, synced_leads: leads.length });
  } catch (err) {
    logError('syncFromLemlist (thrown)', err);
    res.status(500).json({ error: err.message });
  }
}

module.exports = { listSequences, getSequence, getSequenceLeads, listAllSequenceLeads, syncFromLemlist };
