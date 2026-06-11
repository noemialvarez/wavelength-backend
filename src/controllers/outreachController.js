const supabase = require('../config/supabase');
const claudeService = require('../services/claudeService');
const lemlistService = require('../services/lemlistService');
const { extractText } = require('../utils/extractText');
const logError = require('../utils/logError');

// ─── Positioning ─────────────────────────────────────────────────────────────

async function uploadPositioning(req, res) {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const content = await extractText(req.file.buffer, req.file.mimetype, req.file.originalname);
    if (!content) return res.status(400).json({ error: 'Could not extract text from file' });

    const { data: existing } = await supabase.from('positioning').select('id').limit(1).maybeSingle();

    const payload = { content, updated_at: new Date().toISOString() };
    let result;
    if (existing) {
      result = await supabase.from('positioning').update(payload).eq('id', existing.id).select().single();
    } else {
      result = await supabase.from('positioning').insert(payload).select().single();
    }

    if (result.error) { logError('uploadPositioning', result.error); return res.status(500).json({ error: result.error.message }); }
    res.json({ ...result.data, filename: req.file.originalname });
  } catch (err) {
    logError('uploadPositioning (thrown)', err);
    res.status(500).json({ error: err.message });
  }
}

async function getPositioning(req, res) {
  try {
    const { data, error } = await supabase.from('positioning').select('*').limit(1).maybeSingle();
    if (error) { logError('getPositioning', error); return res.status(500).json({ error: error.message }); }
    if (!data) return res.status(404).json({ error: 'No positioning file found' });
    res.json(data);
  } catch (err) {
    logError('getPositioning (thrown)', err);
    res.status(500).json({ error: err.message });
  }
}

async function upsertPositioning(req, res) {
  try {
    const { content } = req.body;
    if (!content) return res.status(400).json({ error: 'content is required' });

    const { data: existing } = await supabase.from('positioning').select('id').limit(1).maybeSingle();

    const payload = { content, updated_at: new Date().toISOString() };
    let result;
    if (existing) {
      result = await supabase.from('positioning').update(payload).eq('id', existing.id).select().single();
    } else {
      result = await supabase.from('positioning').insert(payload).select().single();
    }

    if (result.error) { logError('upsertPositioning', result.error); return res.status(400).json({ error: result.error.message }); }
    res.json(result.data);
  } catch (err) {
    logError('upsertPositioning (thrown)', err);
    res.status(500).json({ error: err.message });
  }
}

// ─── Settings ────────────────────────────────────────────────────────────────

async function getSettings(req, res) {
  try {
    const { data, error } = await supabase.from('positioning').select('lemlist_campaign_id').limit(1).maybeSingle();
    if (error) { logError('getSettings', error); return res.status(500).json({ error: error.message }); }
    res.json({ lemlist_campaign_id: data?.lemlist_campaign_id ?? '' });
  } catch (err) {
    logError('getSettings (thrown)', err);
    res.status(500).json({ error: err.message });
  }
}

async function upsertCampaignId(req, res) {
  try {
    console.log('[upsertCampaignId] body:', JSON.stringify(req.body));
    const { lemlist_campaign_id } = req.body;
    if (lemlist_campaign_id === undefined) return res.status(400).json({ error: 'lemlist_campaign_id is required' });

    const { data: existing, error: fetchErr } = await supabase.from('positioning').select('id').limit(1).maybeSingle();
    if (fetchErr) {
      logError('upsertCampaignId fetch existing', fetchErr);
      return res.status(500).json({ error: fetchErr.message });
    }
    console.log('[upsertCampaignId] existing row:', existing);

    let result;
    if (existing) {
      console.log('[upsertCampaignId] updating row', existing.id);
      result = await supabase.from('positioning')
        .update({ lemlist_campaign_id, updated_at: new Date().toISOString() })
        .eq('id', existing.id).select('lemlist_campaign_id').single();
    } else {
      console.log('[upsertCampaignId] no existing row — inserting');
      result = await supabase.from('positioning')
        .insert({ lemlist_campaign_id, content: '', updated_at: new Date().toISOString() })
        .select('lemlist_campaign_id').single();
    }

    if (result.error) {
      logError('upsertCampaignId db write', result.error);
      return res.status(500).json({ error: result.error.message });
    }
    console.log('[upsertCampaignId] success:', JSON.stringify(result.data));
    res.json(result.data);
  } catch (err) {
    logError('upsertCampaignId (thrown)', err);
    res.status(500).json({ error: err.message });
  }
}

// ─── Drafts ──────────────────────────────────────────────────────────────────

async function draftEmail(req, res) {
  try {
    const { lead_id } = req.body;
    if (!lead_id) return res.status(400).json({ error: 'lead_id is required' });

    const [{ data: lead, error: leadError }, { data: positioning, error: posError }] = await Promise.all([
      supabase.from('leads').select('*').eq('id', lead_id).single(),
      supabase.from('positioning').select('*').limit(1).maybeSingle(),
    ]);

    if (leadError) { logError('draftEmail fetch lead', leadError); return res.status(404).json({ error: 'Lead not found' }); }
    if (posError) { logError('draftEmail fetch positioning', posError); return res.status(500).json({ error: posError.message }); }
    if (!positioning) return res.status(400).json({ error: 'No positioning file found. Upload one in Settings first.' });

    const draft = await claudeService.draftOutreachEmail(lead, positioning.content);

    const { data, error } = await supabase
      .from('outreach_drafts')
      .insert({ lead_id, subject: draft.subject, body: draft.body, status: 'draft' })
      .select()
      .single();

    if (error) { logError('draftEmail insert', error); return res.status(500).json({ error: error.message }); }
    res.status(201).json(data);
  } catch (err) {
    logError('draftEmail (thrown)', err);
    res.status(500).json({ error: err.message });
  }
}

async function listDrafts(req, res) {
  try {
    const { status, page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;

    let query = supabase
      .from('outreach_drafts')
      .select('*, leads(name, company, email)', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (status) query = query.eq('status', status);

    const { data, error, count } = await query;
    if (error) { logError('listDrafts', error); return res.status(500).json({ error: error.message }); }
    res.json({ data, total: count });
  } catch (err) {
    logError('listDrafts (thrown)', err);
    res.status(500).json({ error: err.message });
  }
}

async function getDraft(req, res) {
  try {
    const { data, error } = await supabase
      .from('outreach_drafts').select('*, leads(*)').eq('id', req.params.id).single();
    if (error) { logError('getDraft', error); return res.status(404).json({ error: 'Draft not found' }); }
    res.json(data);
  } catch (err) {
    logError('getDraft (thrown)', err);
    res.status(500).json({ error: err.message });
  }
}

async function updateDraft(req, res) {
  try {
    const { data, error } = await supabase
      .from('outreach_drafts').update(req.body).eq('id', req.params.id).select().single();
    if (error) { logError('updateDraft', error); return res.status(400).json({ error: error.message }); }
    res.json(data);
  } catch (err) {
    logError('updateDraft (thrown)', err);
    res.status(500).json({ error: err.message });
  }
}

async function deleteDraft(req, res) {
  try {
    const { error } = await supabase.from('outreach_drafts').delete().eq('id', req.params.id);
    if (error) { logError('deleteDraft', error); return res.status(400).json({ error: error.message }); }
    res.status(204).send();
  } catch (err) {
    logError('deleteDraft (thrown)', err);
    res.status(500).json({ error: err.message });
  }
}

async function approveAndSend(req, res) {
  try {
    const { data: draft, error } = await supabase
      .from('outreach_drafts').select('id, lead_id, status').eq('id', req.params.draftId).single();

    if (error) { logError('approveAndSend fetch', error); return res.status(404).json({ error: 'Draft not found' }); }
    if (draft.status !== 'draft') return res.status(400).json({ error: 'Draft already approved or sent' });

    // Dismiss sibling drafts for the same lead, then approve this one
    await Promise.all([
      supabase.from('outreach_drafts').delete().eq('lead_id', draft.lead_id).neq('id', draft.id),
      supabase.from('outreach_drafts').update({ status: 'approved' }).eq('id', draft.id),
    ]);

    res.json({ success: true });
  } catch (err) {
    logError('approveAndSend (thrown)', err);
    res.status(500).json({ error: err.message });
  }
}

module.exports = {
  uploadPositioning, getPositioning, upsertPositioning,
  getSettings, upsertCampaignId,
  draftEmail, listDrafts, getDraft, updateDraft, deleteDraft, approveAndSend,
};
