const supabase = require('../config/supabase');
const discoveryService = require('../services/discoveryService');
const phantombusterService = require('../services/phantombusterService');
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

    // Auto-enrich: search LinkedIn for the founder in the background
    if (signal.company_name && process.env.PHANTOMBUSTER_LINKEDIN_SEARCH_AGENT_ID) {
      phantombusterService.launchFounderSearch(signal.company_name)
        .then(result => {
          if (!result) return;
          const name = result.name || [result.firstName, result.lastName].filter(Boolean).join(' ') || null;
          const linkedin_url = result.profileUrl || result.linkedinUrl || result.url || null;
          const patch = {};
          if (name && !signal.founder_name) patch.name = name;
          if (linkedin_url) patch.linkedin_url = linkedin_url;
          if (Object.keys(patch).length) {
            supabase.from('leads').update(patch).eq('id', lead.id)
              .then(() => console.log(`[promoteSignalToLead] auto-enriched lead ${lead.id} with founder data`))
              .catch(e => logError('promoteSignalToLead auto-enrich update', e));
          }
        })
        .catch(e => logError('promoteSignalToLead launchFounderSearch', e));
    }

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

module.exports = { listRuns, startRun, getRun, listSignals, promoteSignalToLead, dismissSignal };
