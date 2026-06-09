const supabase = require('../config/supabase');
const claudeService = require('../services/claudeService');
const lemlistService = require('../services/lemlistService');

async function getPositioning(req, res) {
  const { data, error } = await supabase
    .from('positioning')
    .select('*')
    .limit(1)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'No positioning file found' });
  res.json(data);
}

async function upsertPositioning(req, res) {
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: 'content is required' });

  // Single-user: replace the one positioning row
  const { data: existing } = await supabase.from('positioning').select('id').limit(1).maybeSingle();

  let result;
  if (existing) {
    result = await supabase
      .from('positioning')
      .update({ content, updated_at: new Date().toISOString() })
      .eq('id', existing.id)
      .select()
      .single();
  } else {
    result = await supabase
      .from('positioning')
      .insert({ content, updated_at: new Date().toISOString() })
      .select()
      .single();
  }

  if (result.error) return res.status(400).json({ error: result.error.message });
  res.json(result.data);
}

async function draftEmail(req, res) {
  const { lead_id } = req.body;
  if (!lead_id) return res.status(400).json({ error: 'lead_id is required' });

  const [{ data: lead, error: leadError }, { data: positioning, error: posError }] = await Promise.all([
    supabase.from('leads').select('*').eq('id', lead_id).single(),
    supabase.from('positioning').select('*').limit(1).maybeSingle(),
  ]);

  if (leadError) return res.status(404).json({ error: 'Lead not found' });
  if (posError || !positioning) return res.status(400).json({ error: 'No positioning file found. Add one first.' });

  const draft = await claudeService.draftOutreachEmail(lead, positioning.content);

  const { data, error } = await supabase
    .from('outreach_drafts')
    .insert({
      lead_id,
      subject: draft.subject,
      body: draft.body,
      status: 'draft',
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
}

async function listDrafts(req, res) {
  const { status, page = 1, limit = 50 } = req.query;
  const offset = (page - 1) * limit;

  let query = supabase
    .from('outreach_drafts')
    .select('*, leads(name, company, email)', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) query = query.eq('status', status);

  const { data, error, count } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data, total: count });
}

async function getDraft(req, res) {
  const { data, error } = await supabase
    .from('outreach_drafts')
    .select('*, leads(*)')
    .eq('id', req.params.id)
    .single();

  if (error) return res.status(404).json({ error: 'Draft not found' });
  res.json(data);
}

async function updateDraft(req, res) {
  const { data, error } = await supabase
    .from('outreach_drafts')
    .update(req.body)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
}

async function deleteDraft(req, res) {
  const { error } = await supabase.from('outreach_drafts').delete().eq('id', req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.status(204).send();
}

async function approveAndSend(req, res) {
  const { data: draft, error } = await supabase
    .from('outreach_drafts')
    .select('*, leads(*)')
    .eq('id', req.params.draftId)
    .single();

  if (error) return res.status(404).json({ error: 'Draft not found' });
  if (draft.status !== 'draft') {
    return res.status(400).json({ error: 'Draft already sent or rejected' });
  }

  const lemlistResult = await lemlistService.addLeadToSequence(draft.leads, draft);

  await Promise.all([
    supabase
      .from('outreach_drafts')
      .update({ status: 'sent', sent_at: new Date().toISOString(), lemlist_id: lemlistResult.id })
      .eq('id', draft.id),
    supabase
      .from('leads')
      .update({ status: 'contacted' })
      .eq('id', draft.lead_id),
  ]);

  res.json({ success: true, lemlist: lemlistResult });
}

module.exports = {
  getPositioning, upsertPositioning,
  draftEmail, listDrafts, getDraft, updateDraft, deleteDraft, approveAndSend,
};
