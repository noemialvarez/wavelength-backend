const supabase = require('../config/supabase');
const discoveryService = require('../services/discoveryService');

async function listRuns(req, res) {
  const { data, error } = await supabase
    .from('discovery_runs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
}

async function startRun(req, res) {
  const { sources = ['wellfound', 'startupticker'] } = req.body;

  const { data: run, error } = await supabase
    .from('discovery_runs')
    .insert({ sources, status: 'pending' })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  // Kick off async — don't await
  discoveryService.runDiscovery(run.id, sources).catch(console.error);

  res.status(202).json(run);
}

async function getRun(req, res) {
  const { data, error } = await supabase
    .from('discovery_runs')
    .select('*, discovery_signals(*)')
    .eq('id', req.params.id)
    .single();

  if (error) return res.status(404).json({ error: 'Run not found' });
  res.json(data);
}

async function listSignals(req, res) {
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
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data, total: count });
}

async function promoteSignalToLead(req, res) {
  const { data: signal, error: signalError } = await supabase
    .from('discovery_signals')
    .select('*')
    .eq('id', req.params.id)
    .single();

  if (signalError) return res.status(404).json({ error: 'Signal not found' });

  const { data: lead, error: leadError } = await supabase
    .from('leads')
    .insert({
      name: signal.founder_name,
      email: signal.founder_email,
      company: signal.company_name,
      linkedin_url: signal.linkedin_url,
      source: signal.source,
      signal_id: signal.id,
      status: 'new',
    })
    .select()
    .single();

  if (leadError) return res.status(400).json({ error: leadError.message });

  await supabase
    .from('discovery_signals')
    .update({ status: 'promoted', lead_id: lead.id })
    .eq('id', signal.id);

  res.status(201).json(lead);
}

module.exports = { listRuns, startRun, getRun, listSignals, promoteSignalToLead };
