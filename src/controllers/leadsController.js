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
    const { signalSummary, ...rest } = req.body;
    const payload = { ...rest };
    // signalSummary is a frontend-only camelCase field; map it to the notes column
    if (signalSummary && !payload.notes) payload.notes = signalSummary;

    const { data, error } = await supabase
      .from('leads')
      .insert(payload)
      .select()
      .single();

    if (error) { logError('createLead', error); return res.status(400).json({ error: error.message }); }

    console.log('Apollo check - email:', data.email, 'API key set:', !!process.env.APOLLO_API_KEY);
    if (!data.email && apolloService.isConfigured()) {
      const email = await apolloService.findEmail(data.name, data.company, data.linkedin_url);
      if (email) {
        console.log(`Apollo enrichment: found email ${email} for lead ${data.name}`);
        const { data: updated } = await supabase
          .from('leads')
          .update({ email, enrichment_data: { ...(data.enrichment_data || {}), email_source: 'apollo' } })
          .eq('id', data.id)
          .select()
          .single();
        if (updated) return res.status(201).json(updated);
      } else {
        console.log(`Apollo enrichment: no email found for lead ${data.name}`);
      }
    }

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

function founderPayload(result) {
  if (!result) return null;
  var nameParts = [result.firstName, result.lastName].filter(Boolean);
  var name = result.name ? result.name : (nameParts.length ? nameParts.join(' ') : null);
  var linkedin_url = result.profileUrl ? result.profileUrl : (result.linkedinUrl ? result.linkedinUrl : (result.url ? result.url : null));
  var payload = {};
  if (name) payload.name = name;
  if (linkedin_url) payload.linkedin_url = linkedin_url;
  return Object.keys(payload).length ? payload : null;
}

async function findFounder(req, res) {
  try {
    console.log('[findFounder] looking for lead id:', req.params.id);
    const { data: lead, error } = await supabase.from('leads').select('id, company').eq('id', req.params.id).single();
    if (error) { logError('findFounder fetch', error); return res.status(404).json({ error: 'Lead not found' }); }

    const result = await phantombusterService.launchFounderSearch(lead.company);
    const payload = founderPayload(result);

    if (payload) {
      const { error: updateErr } = await supabase.from('leads').update(payload).eq('id', lead.id);
      if (updateErr) { logError('findFounder update', updateErr); return res.status(500).json({ error: updateErr.message }); }
    }

    res.json({ found: !!payload, ...(payload || {}) });
  } catch (err) {
    logError('findFounder (thrown)', err);
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
      const enrichedName = enriched?.firstName ? `${enriched.firstName} ${enriched.lastName || ''}`.trim() : null;
      const resolvedName = enriched?.name || enrichedName || lead.name;
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

async function findLeadEmail(req, res) {
  try {
    if (!apolloService.isConfigured()) {
      return res.status(400).json({ error: 'APOLLO_API_KEY is not configured' });
    }

    const { data: lead, error } = await supabase
      .from('leads').select('id, name, company, email').eq('id', req.params.id).single();
    if (error) { logError('findLeadEmail fetch', error); return res.status(404).json({ error: 'Lead not found' }); }

    const email = await apolloService.findEmail(lead.name, lead.company);
    if (!email) return res.json({ email: null });

    const { error: updateError } = await supabase.from('leads').update({ email }).eq('id', lead.id);
    if (updateError) { logError('findLeadEmail update', updateError); return res.status(500).json({ error: updateError.message }); }

    res.json({ email });
  } catch (err) {
    logError('findLeadEmail (thrown)', err);
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

    // Respond immediately, enrich missing emails in the background
    res.status(201).json({ imported: data.length, data });

    if (apolloService.isConfigured()) {
      const toEnrich = data.filter(l => !l.email);
      setImmediate(async () => {
        for (const lead of toEnrich) {
          try {
            const email = await apolloService.findEmail(lead.name, lead.company, lead.linkedin_url);
            if (email) {
              console.log(`Apollo enrichment: found email ${email} for lead ${lead.name}`);
              await supabase.from('leads').update({
                email,
                enrichment_data: { ...(lead.enrichment_data || {}), email_source: 'apollo' },
              }).eq('id', lead.id);
            } else {
              console.log(`Apollo enrichment: no email found for lead ${lead.name}`);
            }
          } catch (err) {
            logError(`importLeads apollo enrichment for ${lead.name}`, err);
          }
        }
      });
    }
  } catch (err) {
    logError('importLeads (thrown)', err);
    res.status(500).json({ error: err.message });
  }
}

module.exports = { listLeads, getLead, createLead, updateLead, deleteLead, findFounder, enrichLead, findLeadEmail, importLeads };
