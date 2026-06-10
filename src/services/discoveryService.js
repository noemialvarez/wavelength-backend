const supabase = require('../config/supabase');
const apolloService = require('./apolloService');
const scanner = require('./scannerService');

async function runDiscovery(runId, sources) {
  console.log(`[discovery] run=${runId} starting — sources: ${sources.join(', ')}`);
  await supabase.from('discovery_runs').update({ status: 'running' }).eq('id', runId);

  const signals = [];
  for (const source of sources) {
    if (!scanner.hasAdapter(source)) {
      console.log(`[discovery] run=${runId} source=${source} — no adapter registered, skipping`);
      continue;
    }
    try {
      const results = await scanner.runAdapter(source);
      console.log(`[discovery] run=${runId} source=${source} — extracted ${results.length} companies`);
      signals.push(...results.map(r => ({ ...r, source, run_id: runId, status: 'new' })));
    } catch (err) {
      console.error(`[discovery] run=${runId} source=${source} — fetch/parse error: ${err.message}`);
    }
  }

  if (apolloService.isConfigured()) {
    for (const signal of signals) {
      if (signal.founder_name && !signal.founder_email) {
        signal.founder_email = await apolloService.findEmail(signal.founder_name, signal.company_name);
      }
    }
  }

  if (signals.length > 0) {
    console.log(`[discovery] run=${runId} — inserting ${signals.length} signal(s) into database`);
    const { error: insertError } = await supabase.from('discovery_signals').insert(signals);
    if (insertError) {
      console.error(`[discovery] run=${runId} — Supabase insert error: ${insertError.message}`);
    } else {
      console.log(`[discovery] run=${runId} — insert successful`);
    }
  } else {
    console.log(`[discovery] run=${runId} — no signals to insert`);
  }

  await supabase
    .from('discovery_runs')
    .update({ status: 'completed', signal_count: signals.length, completed_at: new Date().toISOString() })
    .eq('id', runId);

  console.log(`[discovery] run=${runId} — completed, total signals: ${signals.length}`);
}

module.exports = { runDiscovery };
