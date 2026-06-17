const supabase = require('../config/supabase');
const discoveryService = require('../services/discoveryService');
const phantombusterService = require('../services/phantombusterService');
const apolloService = require('../services/apolloService');
const claudeService = require('../services/claudeService');
const logError = require('../utils/logError');

async function listRuns(req, res) {
  try {
    const { data, error } = await supabase
      .from('discovery_runs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) { logError('listRuns', error); return res.status(500).json({ error: error.message }); }
    res.json(data);
  } catch (err) {
    logError('listRuns (thrown)', err);
    res.status(500).json({ error: err.message });
  }
}

async function startRun(req, res) {
  try {
    const { sources = ['wellfound', 'startupticker'] } = req.body;

    const { data: run, error } = await supabase
      .from('discovery_runs')
      .insert({ sources, status: 'pending' })
      .select()
      .single();

    if (error) { logError('startRun insert', error); return res.status(500).json({ error: error.message }); }

    discoveryService.runDiscovery(run.id, sources).catch(err => logError('runDiscovery async', err));
    res.status(202).json(run);
  } catch (err) {
    logError('startRun (thrown)', err);
    res.status(500).json({ error: err.message });
  }
}

async function getRun(req, res) {
  try {
    const { data, error } = await supabase
      .from('discovery_runs')
      .select('*, discovery_signals(*)')
      .eq('id', req.params.id)
      .single();

    if (error) { logError('getRun', error); return res.status(404).json({ error: 'Run not found' }); }
    res.json(data);
  } catch (err) {
    logError('getRun (thrown)', err);
    res.status(500).json({ error: err.message });
  }
}

async function listSignals(req, res) {
  try {
    const { status, source, page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;

    let query = supabase
      .from('discovery_signals')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (status) query = query.eq('status', status);
    if (source) query = query.eq('source', source);

    const { data, error, count } = await query;
    if (error) { logError('listSignals', error); return res.status(500).json({ error: error.message }); }
    res.json({ data, total: count });
  } catch (err) {
    logError('listSignals (thrown)', err);
    res.status(500).json({ error: err.message });
  }
}

async function promoteSignalToLead(req, res) {
  try {
    const { data: signal, error: signalError } = await supabase
      .from('discovery_signals')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (signalError) { logError('promoteSignalToLead fetch', signalError); return res.status(404).json({ error: 'Signal not found' }); }

    const { data: lead, error: leadError } = await supabase
      .from('leads')
      .insert({
        // name is NOT NULL — use founder_name if available, fall back to company_name
        name: signal.founder_name || signal.company_name || 'Unknown',
        email: signal.founder_email || null,
        company: signal.company_name,
        linkedin_url: signal.linkedin_url || null,
        source: signal.source,
        signal_id: signal.id,
        status: 'enriched',
      })
      .select()
      .single();

    if (leadError) { logError('promoteSignalToLead insert', leadError); return res.status(400).json({ error: leadError.message }); }

    const { error: signalUpdateError } = await supabase
      .from('discovery_signals')
      .update({ status: 'promoted', lead_id: lead.id })
      .eq('id', signal.id);

    if (signalUpdateError) logError('promoteSignalToLead signal update', signalUpdateError);

    // Auto-enrich in background: Phantombuster first (for linkedin_url), then Apollo for email
    setImmediate(async () => {
      try {
        let resolvedName = lead.name;
        let resolvedLinkedin = lead.linkedin_url;

        // Step 1: Phantombuster — get linkedin_url before calling Apollo
        if (signal.company_name && process.env.PHANTOMBUSTER_LINKEDIN_SEARCH_AGENT_ID) {
          const result = await phantombusterService.launchFounderSearch(signal.company_name);
          if (result) {
            const pbName = result.name || [result.firstName, result.lastName].filter(Boolean).join(' ') || null;
            const pbLinkedin = result.profileUrl || result.linkedinUrl || result.url || null;
            const patch = {};
            if (pbName && !signal.founder_name) { patch.name = pbName; resolvedName = pbName; }
            if (pbLinkedin) { patch.linkedin_url = pbLinkedin; resolvedLinkedin = pbLinkedin; }
            if (Object.keys(patch).length) {
              await supabase.from('leads').update(patch).eq('id', lead.id);
              console.log(`[promoteSignalToLead] auto-enriched lead ${lead.id} with founder data`);
            }
          }
        }

        // Step 2: Apollo email enrichment — re-fetch to check current email state
        const { data: freshLead } = await supabase.from('leads').select('email').eq('id', lead.id).single();
        console.log('Apollo check - email:', freshLead?.email, 'API key set:', !!process.env.APOLLO_API_KEY);
        if (!freshLead?.email && apolloService.isConfigured()) {
          const apolloEmail = await apolloService.findEmail(resolvedName, signal.company_name, resolvedLinkedin);
          if (apolloEmail) {
            console.log(`Apollo enrichment: found email ${apolloEmail} for lead ${resolvedName}`);
            await supabase.from('leads').update({
              email: apolloEmail,
              enrichment_data: { email_source: 'apollo' },
            }).eq('id', lead.id);
          } else {
            console.log(`Apollo enrichment: no email found for lead ${resolvedName}`);
          }
        }
      } catch (e) {
        logError('promoteSignalToLead background enrichment', e);
      }
    });

    res.status(201).json(lead);
  } catch (err) {
    logError('promoteSignalToLead (thrown)', err);
    res.status(500).json({ error: err.message });
  }
}

async function dismissSignal(req, res) {
  try {
    const { error } = await supabase
      .from('discovery_signals')
      .update({ status: 'dismissed' })
      .eq('id', req.params.id);

    if (error) { logError('dismissSignal', error); return res.status(500).json({ error: error.message }); }
    res.json({ ok: true });
  } catch (err) {
    logError('dismissSignal (thrown)', err);
    res.status(500).json({ error: err.message });
  }
}

function parseSizeRange(str) {
  if (!str || str === 'any') return null;
  const m = str.match(/^(\d+)[^\d]+(\d+)$/);
  if (m) return { min: Number(m[1]), max: Number(m[2]) };
  const single = str.match(/^(\d+)\+?$/);
  if (single) return { min: Number(single[1]), max: Infinity };
  return null;
}

async function findByDescription(req, res) {
  console.log('by-description route hit:', req.body);
  try {
    const { description, geography, audience } = req.body;
    if (!description) return res.status(400).json({ error: 'description is required' });

    // Normalise array fields the frontend sends (industries/companySizes) to strings
    const industry = req.body.industry ||
      (Array.isArray(req.body.industries) ? req.body.industries.join(', ') : req.body.industries) || '';
    const companySize = req.body.companySize ||
      (Array.isArray(req.body.companySizes) ? req.body.companySizes[0] : req.body.companySizes) || '';

    console.log(`[findByDescription] resolved industry="${industry}" companySize="${companySize}"`);

    // Claude returns up to 20 candidates; size filtering is handled post-Claude via Apollo
    const companies = await claudeService.findCompaniesByDescription({ description, industry, geography, audience, companySize });

    const sizeRange = parseSizeRange(companySize);
    if (!sizeRange || !apolloService.isConfigured()) {
      console.log(`[findByDescription] skipping Apollo size filter — sizeRange=${JSON.stringify(sizeRange)} apolloConfigured=${apolloService.isConfigured()}`);
      return res.json(companies.slice(0, 10));
    }

    // Apollo-verify employee counts in parallel, then filter to requested range
    console.log(`[findByDescription] Apollo-verifying ${companies.length} companies for size ${companySize} (${sizeRange.min}-${sizeRange.max})`);
    const enriched = await Promise.all(
      companies.map(async (c) => {
        const count = await apolloService.getCompanyEmployeeCount(c.website);
        const pass = count === null || (count >= sizeRange.min && count <= sizeRange.max);
        console.log(`[size-filter] company: ${c.company_name} employees: ${count} range: ${sizeRange.min}-${sizeRange.max} pass: ${pass}`);
        return { ...c, _employee_count: count, _pass: pass };
      })
    );

    const verified = enriched.filter(c => c._pass);
    console.log(`[size-filter] kept: ${verified.length} of ${enriched.length} companies after Apollo size check`);

    const result = verified.slice(0, 10).map(({ _employee_count, _pass, ...rest }) => rest);
    res.json(result);
  } catch (err) {
    logError('findByDescription (thrown)', err);
    res.status(500).json({ error: err.message });
  }
}

module.exports = { listRuns, startRun, getRun, listSignals, promoteSignalToLead, dismissSignal, findByDescription };
