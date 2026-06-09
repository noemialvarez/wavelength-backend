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
    const { sequence_id } = req.body;

    const { data: draft, error } = await supabase
      .from('outreach_drafts').select('*, leads(*)').eq('id', req.params.draftId).single();

    if (error) { logError('approveAndSend fetch', error); return res.status(404).json({ error: 'Draft not found' }); }
    if (draft.status !== 'draft') return res.status(400).json({ error: 'Draft already sent or rejected' });

    const lemlistResult = await lemlistService.addLeadToSequence(draft.leads, draft, sequence_id);

    await Promise.all([
      supabase
        .from('outreach_drafts')
        .update({ status: 'sent', sent_at: new Date().toISOString(), lemlist_id: lemlistResult._id })
        .eq('id', draft.id),
      supabase.from('leads').update({ status: 'contacted' }).eq('id', draft.lead_id),
    ]);

    res.json({ success: true, skipped: lemlistResult.skipped ?? false, lemlist: lemlistResult });
  } catch (err) {
    logError('approveAndSend (thrown)', err);
    res.status(500).json({ error: err.message });
  }
}

module.exports = {
  uploadPositioning, getPositioning, upsertPositioning,
  draftEmail, listDrafts, getDraft, updateDraft, deleteDraft, approveAndSend,
};
