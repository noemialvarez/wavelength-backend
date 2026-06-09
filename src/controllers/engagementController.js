const supabase = require('../config/supabase');
const phantombusterService = require('../services/phantombusterService');
const claudeService = require('../services/claudeService');

async function listProspects(req, res) {
  const { data, error } = await supabase
    .from('watched_prospects')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
}

async function addProspect(req, res) {
  const { linkedin_url, name, company } = req.body;
  if (!linkedin_url) return res.status(400).json({ error: 'linkedin_url is required' });

  const { data, error } = await supabase
    .from('watched_prospects')
    .insert({ linkedin_url, name, company })
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
}

async function removeProspect(req, res) {
  const { error } = await supabase
    .from('watched_prospects')
    .delete()
    .eq('id', req.params.id);

  if (error) return res.status(400).json({ error: error.message });
  res.status(204).send();
}

async function listActivity(req, res) {
  const { prospect_id, page = 1, limit = 50 } = req.query;
  const offset = (page - 1) * limit;

  let query = supabase
    .from('prospect_activity')
    .select('*, watched_prospects(name, linkedin_url)', { count: 'exact' })
    .order('activity_date', { ascending: false })
    .range(offset, offset + limit - 1);

  if (prospect_id) query = query.eq('prospect_id', prospect_id);

  const { data, error, count } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data, total: count });
}

async function syncActivity(req, res) {
  const { data: prospects, error } = await supabase
    .from('watched_prospects')
    .select('*');

  if (error) return res.status(500).json({ error: error.message });
  if (!prospects.length) return res.json({ synced: 0 });

  const activities = await phantombusterService.fetchLinkedInActivity(
    prospects.map(p => p.linkedin_url)
  );

  const rows = activities.map(a => ({
    prospect_id: prospects.find(p => p.linkedin_url === a.profileUrl)?.id,
    type: a.type,
    content: a.text,
    post_url: a.postUrl,
    activity_date: a.date,
  })).filter(r => r.prospect_id);

  const { data: inserted } = await supabase
    .from('prospect_activity')
    .upsert(rows, { onConflict: 'prospect_id,post_url' })
    .select();

  res.json({ synced: inserted?.length ?? 0 });
}

async function listComments(req, res) {
  const { status } = req.query;
  let query = supabase
    .from('engagement_comments')
    .select('*, prospect_activity(content, post_url), watched_prospects(name)')
    .order('created_at', { ascending: false });

  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
}

async function draftComment(req, res) {
  const { activity_id } = req.body;
  if (!activity_id) return res.status(400).json({ error: 'activity_id is required' });

  const { data: activity, error } = await supabase
    .from('prospect_activity')
    .select('*, watched_prospects(*)')
    .eq('id', activity_id)
    .single();

  if (error) return res.status(404).json({ error: 'Activity not found' });

  const commentText = await claudeService.draftLinkedInComment(activity);

  const { data, error: insertError } = await supabase
    .from('engagement_comments')
    .insert({
      activity_id,
      prospect_id: activity.prospect_id,
      body: commentText,
      status: 'draft',
    })
    .select()
    .single();

  if (insertError) return res.status(500).json({ error: insertError.message });
  res.status(201).json(data);
}

async function approveComment(req, res) {
  const { data: comment, error } = await supabase
    .from('engagement_comments')
    .select('*, prospect_activity(post_url)')
    .eq('id', req.params.id)
    .single();

  if (error) return res.status(404).json({ error: 'Comment not found' });

  await phantombusterService.postLinkedInComment(
    comment.prospect_activity.post_url,
    comment.body
  );

  const { data, error: updateError } = await supabase
    .from('engagement_comments')
    .update({ status: 'posted', posted_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select()
    .single();

  if (updateError) return res.status(500).json({ error: updateError.message });
  res.json(data);
}

async function deleteComment(req, res) {
  const { error } = await supabase.from('engagement_comments').delete().eq('id', req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.status(204).send();
}

module.exports = {
  listProspects, addProspect, removeProspect,
  listActivity, syncActivity,
  listComments, draftComment, approveComment, deleteComment,
};
