const supabase = require('../config/supabase');
const phantombusterService = require('../services/phantombusterService');
const apolloService = require('../services/apolloService');
const logError = require('../utils/logError');

async function listLeads(req, res) {
  try {
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
    if (error) { logError('listLeads', error); return res.status(500).json({ error: error.message }); }
    res.json({ data, total: count, page: Number(page), limit: Number(limit) });
  } catch (err) {
    logError('listLeads (thrown)', err);
    res.status(500).json({ error: err.message });
  }
}

async function getLead(req, res) {
  try {
    const { data, error } = await supabase
      .from('leads')
      .select('*, outreach_drafts(*), sequence_leads(*)')
      .eq('id', req.params.id)
      .single();

    if (error) { logError('getLead', error); return res.status(404).json({ error: 'Lead not found' }); }
    res.json(data);
  } catch (err) {
    logError('getLead (thrown)', err);
    res.status(500).json({ error: err.message });
  }
}

async function createLead(req, res) {
  try {
    const { data, error } = await supabase
      .from('leads')
      .insert({ ...req.body })
      .select()
      .single();

    if (error) { logError('createLead', error); return res.status(400).json({ error: error.message }); }
    res.status(201).json(data);
  } catch (err) {
    logError('createLead (thrown)', err);
    res.status(500).json({ error: err.message });
  }
}

async function updateLead(req, res) {
  try {
    const { data, error } = await supabase
      .from('leads')
      .update(req.body)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) { logError('updateLead', error); return res.status(400).json({ error: error.message }); }
    res.json(data);
  } catch (err) {
    logError('updateLead (thrown)', err);
    res.status(500).json({ error: err.message });
  }
}

async function deleteLead(req, res) {
  try {
    const { error } = await supabase.from('leads').delete().eq('id', req.params.id);
    if (error) { logError('deleteLead', error); return res.status(400).json({ error: error.message }); }
    res.status(204).send();
  } catch (err) {
    logError('deleteLead (thrown)', err);
    res.status(500).json({ error: err.message });
  }
}

async function enrichLead(req, res) {
  try {
    const { data: lead, error } = await supabase.from('leads').select('*').eq('id', req.params.id).single();
    if (error) { logError('enrichLead fetch', error); return res.status(404).json({ error: 'Lead not found' }); }

    const enriched = await phantombusterService.enrichFounder(lead);

    // Try Apollo for email if lead doesn't already have one
    const updatePayload = {
      enrichment_data: enriched,
      enriched_at: new Date().toISOString(),
      status: 'enriched',
    };
    if (!lead.email) {
      // Phantombuster may return name fields in different shapes depending on agent config
      const resolvedName = enriched?.name
        || (enriched?.firstName ? `${enriched.firstName} ${enriched.lastName || ''}`.trim() : null)
        || lead.name;
      const resolvedCompany = enriched?.company || lead.company;
      const apolloEmail = await apolloService.findEmail(resolvedName, resolvedCompany);
      if (apolloEmail) updatePayload.email = apolloEmail;
    }

    const { data, error: updateError } = await supabase
      .from('leads')
      .update(updatePayload)
      .eq('id', req.params.id)
      .select()
      .single();

    if (updateError) { logError('enrichLead update', updateError); return res.status(500).json({ error: updateError.message }); }
    res.json(data);
  } catch (err) {
    logError('enrichLead (thrown)', err);
    res.status(500).json({ error: err.message });
  }
}

async function importLeads(req, res) {
  try {
    const { leads } = req.body;
    if (!Array.isArray(leads) || leads.length === 0) {
      return res.status(400).json({ error: 'leads array is required' });
    }

    const rows = leads.map(l => ({ ...l, status: 'new' }));
    const { data, error } = await supabase.from('leads').insert(rows).select();
    if (error) { logError('importLeads', error); return res.status(400).json({ error: error.message }); }
    res.status(201).json({ imported: data.length, data });
  } catch (err) {
    logError('importLeads (thrown)', err);
    res.status(500).json({ error: err.message });
  }
}

module.exports = { listLeads, getLead, createLead, updateLead, deleteLead, enrichLead, importLeads };
