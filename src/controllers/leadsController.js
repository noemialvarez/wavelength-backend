const supabase = require('../config/supabase');
const phantombusterService = require('../services/phantombusterService');
const apolloService = require('../services/apolloService');
const claudeService = require('../services/claudeService');
const logError = require('../utils/logError');
const { sortBySeniority } = require('../utils/titleSeniority');

// Sources whose leads start with name = company and need title-based founder discovery
const TITLE_DISCOVERY_SOURCES = new Set(['company_description', 'icp_filters']);

async function listLeads(req, res) {
  try {
    const {
      status, source, search, page = 1, limit = 50,
      linkedin_message_status, no_reply_days, stage,
    } = req.query;
    const offset = (page - 1) * limit;

    let query = supabase
      .from('leads')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (status) query = query.eq('status', status);
    if (source) query = query.eq('source', source);
    if (search) query = query.ilike('name', `%${search}%`);

    // "No reply after N days" — LinkedIn message sent, no reply yet, no reminder sent yet.
    if (linkedin_message_status === 'sent' && no_reply_days) {
      const cutoff = new Date(Date.now() - Number(no_reply_days) * 24 * 60 * 60 * 1000).toISOString();
      query = query
        .eq('linkedin_message_status', 'sent')
        .is('linkedin_replied_at', null)
        .is('linkedin_reminder_sent_at', null)
        .lte('linkedin_message_sent_at', cutoff);
    } else if (linkedin_message_status) {
      query = query.eq('linkedin_message_status', linkedin_message_status);
    }

    // Escalate-to-email cohort — reminder sent 3+ days ago, still no reply.
    if (stage === 'email_escalation') {
      const cutoff = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
      query = query
        .is('linkedin_replied_at', null)
        .not('linkedin_reminder_sent_at', 'is', null)
        .lte('linkedin_reminder_sent_at', cutoff);
    }

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

// Valid writable columns in the leads table
const LEAD_COLUMNS = new Set([
  'name', 'email', 'company', 'role', 'linkedin_url', 'source', 'signal_id', 'status', 'notes',
  'enrichment_data', 'enriched_at', 'created_by',
  'purpose_of_contact',
  'linkedin_connection_status', 'linkedin_connection_requested_at', 'linkedin_connection_accepted_at',
  'linkedin_message_status', 'linkedin_message_draft', 'linkedin_message_sent_at',
  'linkedin_replied_at', 'linkedin_reminder_sent_at', 'linkedin_reminder_draft',
]);

function sanitizeLeadPayload(body) {
  const mapped = { ...body };

  // Resolve name from every possible field the frontend might send
  if (!mapped.name) {
    mapped.name =
      mapped.company_name ||
      mapped.companyName  ||
      mapped.Company      ||
      mapped.Name         ||
      mapped.title        ||
      mapped.company      ||
      null;
  }
  // Keep company in sync if still missing
  if (!mapped.company) {
    mapped.company =
      mapped.company_name ||
      mapped.companyName  ||
      mapped.Company      ||
      mapped.name         ||
      null;
  }

  // camelCase aliases
  if (mapped.signalSummary !== undefined) { if (!mapped.notes)        mapped.notes        = mapped.signalSummary; delete mapped.signalSummary; }
  if (mapped.founderName   !== undefined) { if (!mapped.name)         mapped.name         = mapped.founderName;   delete mapped.founderName;   }
  if (mapped.linkedinUrl   !== undefined) { if (!mapped.linkedin_url) mapped.linkedin_url = mapped.linkedinUrl;   delete mapped.linkedinUrl;   }

  // Capture target job titles (sent by ICP / company-description searches) into enrichment_data
  const rawTitles = mapped.titles || mapped.target_titles || mapped.targetTitles;
  if (Array.isArray(rawTitles) && rawTitles.length) {
    const cleaned = rawTitles.map((t) => (typeof t === 'string' ? t.trim() : '')).filter(Boolean);
    if (cleaned.length) {
      mapped.enrichment_data = {
        ...(mapped.enrichment_data || {}),
        target_titles: cleaned,
      };
    }
  }
  delete mapped.titles;
  delete mapped.target_titles;
  delete mapped.targetTitles;

  // fields with no DB column — drop silently
  delete mapped.company_name;
  delete mapped.companyName;
  delete mapped.Company;
  delete mapped.Name;
  delete mapped.title;
  delete mapped.signalType;
  delete mapped.first_name;
  delete mapped.last_name;
  delete mapped.why_match;
  delete mapped.website;
  delete mapped.industry;
  delete mapped.geography;

  // Keep only valid columns
  return Object.fromEntries(Object.entries(mapped).filter(([k]) => LEAD_COLUMNS.has(k)));
}

async function createLead(req, res) {
  try {
    console.log('[createLead] FULL body:', JSON.stringify(req.body, null, 2));

    const payload = sanitizeLeadPayload(req.body);

    // Final safety net — name must never be null
    if (!payload.name) payload.name = 'Unknown Company';

    const { data, error } = await supabase
      .from('leads')
      .insert(payload)
      .select()
      .single();

    if (error) { logError('createLead', error); return res.status(400).json({ error: error.message }); }

    // Skip Apollo when this lead is awaiting title-based founder discovery:
    // for ICP-filter / company-description leads, name == company at this point,
    // so Apollo's people-match needs an actual person name first (resolved by /find-founder).
    const awaitingTitleDiscovery =
      TITLE_DISCOVERY_SOURCES.has(data.source) ||
      (data.enrichment_data?.target_titles?.length > 0);

    console.log('Apollo check - email:', data.email, 'API key set:', !!process.env.APOLLO_API_KEY, 'awaitingTitleDiscovery:', awaitingTitleDiscovery);
    if (!data.email && apolloService.isConfigured() && !awaitingTitleDiscovery) {
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
  // Actual job title from the LinkedIn profile — fall back across common Phantombuster shapes.
  var role = result.title || result.occupation || result.currentJob || result.jobTitle || result.headline || null;
  var payload = {};
  if (name) payload.name = name;
  if (linkedin_url) payload.linkedin_url = linkedin_url;
  if (role) payload.role = role;
  return Object.keys(payload).length ? payload : null;
}

async function findFounder(req, res) {
  try {
    console.log('[findFounder] looking for lead id:', req.params.id);
    const { data: lead, error } = await supabase
      .from('leads')
      .select('id, company, email, linkedin_url, source, enrichment_data')
      .eq('id', req.params.id)
      .single();
    if (error) { logError('findFounder fetch', error); return res.status(404).json({ error: 'Lead not found' }); }

    // If the user supplied target job titles, search them from most-senior to least-senior
    // and stop at the first hit. Fall back to the legacy "founder" search otherwise.
    const storedTitles = Array.isArray(lead.enrichment_data?.target_titles)
      ? lead.enrichment_data.target_titles
      : [];
    const orderedTitles = sortBySeniority(storedTitles);
    const searchOrder = orderedTitles.length ? orderedTitles : [null];

    let result = null;
    let matchedTitle = null;
    for (const t of searchOrder) {
      console.log(`[findFounder] trying title "${t || 'founder'}" for ${lead.company}`);
      const r = await phantombusterService.launchFounderSearch(lead.company, t);
      if (r && (r.name || r.firstName || r.profileUrl || r.linkedinUrl || r.url)) {
        result = r;
        matchedTitle = t;
        break;
      }
    }

    const payload = founderPayload(result);
    // founderPayload already set role to the actual profile title if available.
    // Fall back to the searched title if the profile didn't expose one.
    if (payload && !payload.role && matchedTitle) payload.role = matchedTitle;
    // Always remember what we searched for, separately from the resolved role.
    if (payload && matchedTitle) {
      payload.enrichment_data = {
        ...(lead.enrichment_data || {}),
        matched_title: matchedTitle,
      };
    }

    // Once we have an actual person name, look up email + title via Apollo.
    // Apollo serves as a secondary source of truth for the title when
    // Phantombuster's profile didn't expose one.
    if (payload?.name && apolloService.isConfigured()) {
      const person = await apolloService.findPerson(
        payload.name,
        lead.company,
        payload.linkedin_url || lead.linkedin_url,
      );
      if (person) {
        if (person.email && !lead.email) {
          payload.email = person.email;
          payload.enrichment_data = {
            ...(payload.enrichment_data || lead.enrichment_data || {}),
            email_source: 'apollo',
          };
        }
        if (!payload.role && (person.title || person.headline)) {
          payload.role = person.title || person.headline;
        }
      }
    }

    if (payload) {
      const { error: updateErr } = await supabase.from('leads').update(payload).eq('id', lead.id);
      if (updateErr) { logError('findFounder update', updateErr); return res.status(500).json({ error: updateErr.message }); }
    }

    res.json({
      found: !!payload,
      matched_title: matchedTitle,
      ...(payload || {}),
    });
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

// Creates a lead from an Option 4 ("by name") search candidate and sends a
// Queues a LinkedIn connection request via Phantombuster's "LinkedIn Search
// to Lead Connection" agent. This is a Workflow, not a one-shot send: it adds
// the person to Phantombuster's own paced invite queue (throttled to ~5/hour,
// 20/day during working hours, per LinkedIn's anti-automation limits) rather
// than sending immediately — actual sending happens on the agent's own
// recurring schedule, configured in Phantombuster directly. The lead is
// always created — if queuing itself fails (e.g. agent not configured), that
// failure is reported alongside the lead rather than losing the lead too.
async function connectByName(req, res) {
  try {
    const { candidate, purpose } = req.body;
    if (!candidate?.firstName || !candidate?.lastName) {
      return res.status(400).json({ error: 'candidate.firstName and candidate.lastName are required' });
    }

    const name = candidate.name || [candidate.firstName, candidate.lastName].filter(Boolean).join(' ');
    const payload = {
      name,
      company: candidate.company || null,
      linkedin_url: candidate.linkedin_url || null,
      role: candidate.title || null,
      source: 'by_name',
      status: 'new',
      purpose_of_contact: purpose || candidate.purpose || null,
      linkedin_connection_status: 'not_sent',
    };

    const { data: lead, error } = await supabase.from('leads').insert(payload).select().single();
    if (error) { logError('connectByName insert', error); return res.status(400).json({ error: error.message }); }

    // Best-effort Apollo email lookup now (not blocking), so the lead already
    // has an email by the time it reaches "approve & push to Lemlist" later —
    // Lemlist requires an email even to push a LinkedIn-step message.
    if (apolloService.isConfigured()) {
      apolloService.findEmail(lead.name, lead.company, lead.linkedin_url)
        .then((email) => {
          if (!email) return null;
          return supabase.from('leads')
            .update({ email, enrichment_data: { ...(lead.enrichment_data || {}), email_source: 'apollo' } })
            .eq('id', lead.id);
        })
        .catch((e) => logError('connectByName apollo enrichment', e));
    }

    // search_url (not linkedin_url) drives the connect call — see
    // sendConnectionRequest's comment for why this agent needs a search URL
    // rather than a bare profile URL.
    if (!candidate.search_url) {
      return res.status(201).json({
        lead,
        connection: { queued: false, error: 'No search URL available for this candidate — cannot queue a connection request' },
      });
    }

    try {
      await phantombusterService.sendConnectionRequest(candidate.search_url);
      const { data: updated, error: updateErr } = await supabase
        .from('leads')
        .update({
          linkedin_connection_status: 'requested',
          linkedin_connection_requested_at: new Date().toISOString(),
        })
        .eq('id', lead.id)
        .select()
        .single();
      if (updateErr) { logError('connectByName status update', updateErr); return res.status(500).json({ error: updateErr.message }); }
      return res.status(201).json({ lead: updated, connection: { queued: true } });
    } catch (connectErr) {
      logError('connectByName sendConnectionRequest', connectErr);
      return res.status(201).json({ lead, connection: { queued: false, error: connectErr.message } });
    }
  } catch (err) {
    logError('connectByName (thrown)', err);
    res.status(500).json({ error: err.message });
  }
}

async function draftLinkedinMessage(req, res) {
  try {
    const { data: lead, error } = await supabase.from('leads').select('*').eq('id', req.params.id).single();
    if (error) { logError('draftLinkedinMessage fetch', error); return res.status(404).json({ error: 'Lead not found' }); }

    const body = await claudeService.draftLinkedInOutreachMessage(lead);

    const { data, error: updateErr } = await supabase
      .from('leads')
      .update({ linkedin_message_draft: body, linkedin_message_status: 'drafted' })
      .eq('id', lead.id)
      .select()
      .single();
    if (updateErr) { logError('draftLinkedinMessage update', updateErr); return res.status(500).json({ error: updateErr.message }); }
    res.json(data);
  } catch (err) {
    logError('draftLinkedinMessage (thrown)', err);
    res.status(500).json({ error: err.message });
  }
}

async function updateLinkedinMessage(req, res) {
  try {
    const { body } = req.body;
    if (body === undefined) return res.status(400).json({ error: 'body is required' });
    const { data, error } = await supabase
      .from('leads')
      .update({ linkedin_message_draft: body })
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) { logError('updateLinkedinMessage', error); return res.status(400).json({ error: error.message }); }
    res.json(data);
  } catch (err) {
    logError('updateLinkedinMessage (thrown)', err);
    res.status(500).json({ error: err.message });
  }
}

// Sends directly via Phantombuster's LinkedIn Message Sender — not Lemlist.
// LinkedIn sending on Lemlist requires their paid Multichannel tier, which the
// account isn't on; Phantombuster already covers connect + message within the
// existing plan, so Lemlist is only used for the email-escalation fallback.
async function approveLinkedinMessage(req, res) {
  try {
    const { data: lead, error } = await supabase.from('leads').select('*').eq('id', req.params.id).single();
    if (error) { logError('approveLinkedinMessage fetch', error); return res.status(404).json({ error: 'Lead not found' }); }
    if (!lead.linkedin_message_draft) return res.status(400).json({ error: 'No draft to approve — generate one first' });
    if (!lead.linkedin_url) return res.status(400).json({ error: 'Lead has no LinkedIn URL — cannot send a message' });

    await phantombusterService.sendLinkedInMessage(lead.linkedin_url, lead.linkedin_message_draft);

    const { data: updated, error: updateErr } = await supabase
      .from('leads')
      .update({ linkedin_message_status: 'sent', linkedin_message_sent_at: new Date().toISOString() })
      .eq('id', lead.id)
      .select()
      .single();
    if (updateErr) { logError('approveLinkedinMessage update', updateErr); return res.status(500).json({ error: updateErr.message }); }

    res.json({ success: true, sent: true, lead: updated });
  } catch (err) {
    logError('approveLinkedinMessage (thrown)', err);
    res.status(400).json({ error: err.message });
  }
}

async function draftLinkedinReminder(req, res) {
  try {
    const { data: lead, error } = await supabase.from('leads').select('*').eq('id', req.params.id).single();
    if (error) { logError('draftLinkedinReminder fetch', error); return res.status(404).json({ error: 'Lead not found' }); }

    const body = await claudeService.draftLinkedInReminder(lead);

    const { data, error: updateErr } = await supabase
      .from('leads')
      .update({ linkedin_reminder_draft: body })
      .eq('id', lead.id)
      .select()
      .single();
    if (updateErr) { logError('draftLinkedinReminder update', updateErr); return res.status(500).json({ error: updateErr.message }); }
    res.json(data);
  } catch (err) {
    logError('draftLinkedinReminder (thrown)', err);
    res.status(500).json({ error: err.message });
  }
}

// Same PhantomBuster-direct approach as approveLinkedinMessage — see its
// comment. Note: the reply-condition setting on the Message Sender agent
// (e.g. "only send if I was last to message them") isn't wired in yet — its
// argument key wasn't confirmed via agents/fetch (it only appears in the
// saved config once explicitly changed from default in the agent's
// "Behavior" step). Until then this relies solely on our own no-reply query
// filter (linkedin-reminders.tsx only lists leads with no reply after 3
// days), not on a second PhantomBuster-side check.
async function approveLinkedinReminder(req, res) {
  try {
    const { data: lead, error } = await supabase.from('leads').select('*').eq('id', req.params.id).single();
    if (error) { logError('approveLinkedinReminder fetch', error); return res.status(404).json({ error: 'Lead not found' }); }
    if (!lead.linkedin_url) return res.status(400).json({ error: 'Lead has no LinkedIn URL — cannot send a reminder' });

    // Draft-then-approve in one click (matches the frontend's "Send reminder" button) —
    // generate now if the frontend didn't call the draft endpoint separately first.
    const reminderText = lead.linkedin_reminder_draft || await claudeService.draftLinkedInReminder(lead);

    await phantombusterService.sendLinkedInMessage(lead.linkedin_url, reminderText);

    const { data: updated, error: updateErr } = await supabase
      .from('leads')
      .update({ linkedin_reminder_draft: reminderText, linkedin_reminder_sent_at: new Date().toISOString() })
      .eq('id', lead.id)
      .select()
      .single();
    if (updateErr) { logError('approveLinkedinReminder update', updateErr); return res.status(500).json({ error: updateErr.message }); }

    res.json({ success: true, sent: true, lead: updated });
  } catch (err) {
    logError('approveLinkedinReminder (thrown)', err);
    res.status(400).json({ error: err.message });
  }
}

module.exports = {
  listLeads, getLead, createLead, updateLead, deleteLead, findFounder, enrichLead, findLeadEmail, importLeads,
  connectByName, draftLinkedinMessage, updateLinkedinMessage, approveLinkedinMessage,
  draftLinkedinReminder, approveLinkedinReminder,
};
