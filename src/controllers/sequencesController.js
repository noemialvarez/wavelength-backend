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

    // Fetch all leads for this campaign from Lemlist
    const leads = await lemlistService.getCampaignLeads(campaignId);
    console.log(`[syncFromLemlist] fetched ${leads.length} leads from Lemlist`);
    console.log('[syncFromLemlist] first lead raw:', JSON.stringify(leads[0]));

    const leadRows = [];
    for (const l of leads) {
      const email = l.email ?? '';

      let details = null;
      if (email) {
        try {
          details = await lemlistService.getLead(email);
          console.log(`[syncFromLemlist] lead details for ${email}:`, JSON.stringify(details));
        } catch (err) {
          console.error(`[syncFromLemlist] getLead(${email}) failed:`, err.message);
        }
      }

      const firstName = details?.firstName ?? '';
      const lastName  = details?.lastName  ?? '';
      const name      = [firstName, lastName].filter(Boolean).join(' ') || email;
      leadRows.push({
        sequence_id:     seq.id,
        lemlist_lead_id: l._id,
        email,
        name,
        company:         details?.companyName ?? '',
        status:          mapStatus(l.state ?? l.status),
        step:            String(l.currentStep ?? l.step ?? ''),
        last_event_at:   l.lastEmailSentAt ?? l.updatedAt ?? null,
      });
    }

    const { error: leadErr } = await supabase
      .from('sequence_leads')
      .upsert(leadRows, { onConflict: 'sequence_id,lemlist_lead_id' });
    if (leadErr) { logError('syncFromLemlist upsert leads', leadErr); return res.status(500).json({ error: leadErr.message }); }

    // Back-fill lead_id FK by matching email to our leads table
    for (const row of leadRows) {
      if (!row.email) continue;
      const { data: lead } = await supabase.from('leads').select('id').eq('email', row.email).maybeSingle();
      if (lead) {
        await supabase.from('sequence_leads')
          .update({ lead_id: lead.id })
          .eq('sequence_id', seq.id)
          .eq('lemlist_lead_id', row.lemlist_lead_id);
      }
    }

    res.json({ synced_sequences: 1, synced_leads: leadRows.length });
  } catch (err) {
    logError('syncFromLemlist (thrown)', err);
    res.status(500).json({ error: err.message });
  }
}

module.exports = { listSequences, getSequence, getSequenceLeads, listAllSequenceLeads, syncFromLemlist };
