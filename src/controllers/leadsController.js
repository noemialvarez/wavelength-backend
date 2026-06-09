const supabase = require('../config/supabase');
const phantombusterService = require('../services/phantombusterService');

async function listLeads(req, res) {
  const { status, source, search, page = 1, limit = 50 } = req.query;
  const offset = (page - 1) * limit;

  let query = supabase
    .from('leads')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) query = query.eq('status', status);
  if (source) query = query.eq('source', source);
  if (search) query = query.ilike('name', `%${search}%`);

  const { data, error, count } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data, total: count, page: Number(page), limit: Number(limit) });
}

async function getLead(req, res) {
  const { data, error } = await supabase
    .from('leads')
    .select('*, outreach_drafts(*), sequence_leads(*)')
    .eq('id', req.params.id)
    .single();

  if (error) return res.status(404).json({ error: 'Lead not found' });
  res.json(data);
}

async function createLead(req, res) {
  const { data, error } = await supabase
    .from('leads')
    .insert({ ...req.body })
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
}

async function updateLead(req, res) {
  const { data, error } = await supabase
    .from('leads')
    .update(req.body)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
}

async function deleteLead(req, res) {
  const { error } = await supabase
    .from('leads')
    .delete()
    .eq('id', req.params.id);

  if (error) return res.status(400).json({ error: error.message });
  res.status(204).send();
}

async function enrichLead(req, res) {
  const { data: lead, error } = await supabase
    .from('leads')
    .select('*')
    .eq('id', req.params.id)
    .single();

  if (error) return res.status(404).json({ error: 'Lead not found' });

  const enriched = await phantombusterService.enrichFounder(lead);

  const { data, updateError } = await supabase
    .from('leads')
    .update({ enrichment_data: enriched, enriched_at: new Date().toISOString(), status: 'enriched' })
    .eq('id', req.params.id)
    .select()
    .single();

  if (updateError) return res.status(500).json({ error: updateError.message });
  res.json(data);
}

async function importLeads(req, res) {
  const { leads } = req.body;
  if (!Array.isArray(leads) || leads.length === 0) {
    return res.status(400).json({ error: 'leads array is required' });
  }

  const rows = leads.map(l => ({ ...l, status: 'new' }));
  const { data, error } = await supabase.from('leads').insert(rows).select();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json({ imported: data.length, data });
}

module.exports = { listLeads, getLead, createLead, updateLead, deleteLead, enrichLead, importLeads };
