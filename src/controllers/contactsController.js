const supabase = require('../config/supabase');
const phantombusterService = require('../services/phantombusterService');
const apolloService = require('../services/apolloService');
const claudeService = require('../services/claudeService');
const logError = require('../utils/logError');
const { normalizeProfileUrl, isMemberIdUrl, canonicalProfileUrl, nameFromSlug } = require('../utils/linkedinUrl');
const { friendlyPhantomError } = require('../utils/phantomError');

// Sends the failure to the client as { error, code } with a plain-language message.
function sendPhantomError(res, context, err) {
  logError(context, err);
  const f = friendlyPhantomError(err);
  res.status(f.status).json({ error: f.message, code: f.code });
}

// yes | no | unknown. "unknown" whenever we can't tell — no connections export
// available, or the URL is an opaque member-id URL — so we never claim "no" wrongly.
function connectionFor(url, connectionSet) {
  if (!url || !connectionSet || isMemberIdUrl(url)) return 'unknown';
  return connectionSet.has(normalizeProfileUrl(url)) ? 'yes' : 'no';
}

// Re-computes the connection status for the given person contacts and saves changes.
async function applyConnections(contacts, { force = false, cachedOnly = false } = {}) {
  let connectionSet = null;
  try {
    connectionSet = await phantombusterService.getConnectionSet({ force, cachedOnly });
  } catch (err) {
    logError('applyConnections getConnectionSet', err);
  }

  // Without a connections list, leave existing statuses alone rather than wiping known ones.
  if (!connectionSet) return { contacts, connectionsAvailable: false };

  const now = new Date().toISOString();
  const out = [];
  for (const c of contacts) {
    if (c.kind !== 'person') { out.push(c); continue; }
    const connection = connectionFor(c.linkedin_url, connectionSet);
    // Never replace a known answer with "unknown", and don't downgrade a "yes" (learned from
    // the search result's connection degree): the export is capped and may use another URL form.
    if (connection === 'unknown' || connection === c.connection || (connection === 'no' && c.connection === 'yes')) {
      out.push(c);
      continue;
    }
    const { data, error } = await supabase
      .from('lead_contacts')
      .update({ connection, connection_checked_at: now })
      .eq('id', c.id)
      .select()
      .single();
    if (error) { logError('applyConnections update', error); out.push(c); } else out.push(data);
  }
  return { contacts: out, connectionsAvailable: !!connectionSet };
}

async function listContacts(req, res) {
  try {
    const { selected, lead_id, requested } = req.query;
    let query = supabase
      .from('lead_contacts')
      .select('*, leads(id, company, name, status)')
      .order('created_at', { ascending: true })
      .limit(2000);
    if (selected === 'true') query = query.eq('selected', true);
    if (lead_id) query = query.eq('lead_id', lead_id);
    // Everyone a connection request was attempted for (sent or failed), for the status list.
    if (requested === 'true') query = query.neq('request_status', 'none');

    const { data, error } = await query;
    if (error) { logError('listContacts', error); return res.status(500).json({ error: error.message }); }
    res.json({ data });
  } catch (err) {
    logError('listContacts (thrown)', err);
    res.status(500).json({ error: err.message });
  }
}

// What an Apollo lookup tells us beyond the people themselves:
//  - the company's LinkedIn page, saved so LinkedIn Engagement doesn't need a separate search for it
//  - the most senior person with an email becomes the lead's own contact (name, role, LinkedIn,
//    email) when the lead has none yet — that is what Email Outreach and the older LinkedIn
//    message funnel read. Never overwrites anything already set.
async function applyApolloFindings(lead, people, org) {
  try {
    if (org?.linkedin_url) {
      const { data: existing } = await supabase
        .from('lead_contacts')
        .select('id, linkedin_url')
        .eq('lead_id', lead.id)
        .eq('kind', 'company')
        .maybeSingle();
      if (!existing) {
        await supabase.from('lead_contacts').insert({
          lead_id: lead.id, kind: 'company', name: org.name || lead.company, linkedin_url: org.linkedin_url, selected: false,
        });
      } else if (!existing.linkedin_url) {
        await supabase.from('lead_contacts').update({ linkedin_url: org.linkedin_url }).eq('id', existing.id);
      }
    }

    if (people.length) {
      const primary = people.find((p) => p.email) || people[0];
      const patch = {};
      if (!lead.linkedin_url) {
        patch.name = primary.name;
        patch.role = primary.role;
        patch.linkedin_url = primary.linkedin_url;
      }
      // only set the email alongside the person it belongs to
      if (!lead.email && primary.email && (patch.linkedin_url || normalizeProfileUrl(lead.linkedin_url) === normalizeProfileUrl(primary.linkedin_url))) {
        patch.email = primary.email;
      }
      if (Object.keys(patch).length) await supabase.from('leads').update(patch).eq('id', lead.id);
    }
  } catch (err) {
    // Nice-to-have enrichment: never fail the team lookup over it.
    logError('applyApolloFindings', err);
  }
}

// Where founders / executives come from: Apollo when it's configured (precise, takes seconds, no
// LinkedIn session involved), otherwise PhantomBuster's LinkedIn search. PEOPLE_SOURCE=apollo or
// =phantombuster forces one.
function peopleSource() {
  const forced = (process.env.PEOPLE_SOURCE || '').trim().toLowerCase();
  if (forced === 'apollo' || forced === 'phantombuster') return forced;
  return apolloService.isConfigured() ? 'apollo' : 'phantombuster';
}

// Only the columns that exist on lead_contacts (a person from Apollo also carries an email).
const contactFields = (p) => ({ name: p.name, role: p.role, linkedin_url: p.linkedin_url, is_founder: !!p.is_founder });

// Finds the founders and executive team of a lead's company, saves them as contacts, and checks
// which ones we're already connected to.
async function findTeam(req, res) {
  try {
    const { lead_id } = req.body;
    if (!lead_id) return res.status(400).json({ error: 'lead_id is required' });

    const { data: lead, error } = await supabase
      .from('leads')
      .select('id, company, name, role, email, linkedin_url')
      .eq('id', lead_id)
      .single();
    if (error) { logError('findTeam fetch lead', error); return res.status(404).json({ error: 'Lead not found' }); }
    if (!lead.company) return res.status(400).json({ error: 'Lead has no company name to search for' });

    const source = peopleSource();
    let people;
    let stats;
    let org = null;
    if (source === 'apollo') {
      const found = await apolloService.findTeamAtCompany(lead.company);
      people = [...found.people]; // a copy: the Apollo result may be cached
      stats = found.stats;
      org = found.org;
    } else {
      const found = await phantombusterService.searchTeam(lead.company);
      people = found.people;
      stats = { source: 'phantombuster', ...found.stats };
    }

    // Keep the founder already found for this lead by the LinkedIn search, even if this search missed them.
    if (source === 'phantombuster' && lead.linkedin_url && lead.name && lead.name !== lead.company) {
      const key = normalizeProfileUrl(lead.linkedin_url);
      if (!people.some((p) => normalizeProfileUrl(p.linkedin_url) === key)) {
        people.push({
          name: lead.name,
          role: lead.role || null,
          linkedin_url: lead.linkedin_url,
          is_founder: /founder|owner/i.test(lead.role || ''),
        });
      }
    }

    if (people.length) {
      // People whose connection degree was in the search result are saved with it; the rest are
      // saved without a "connection" key so an existing value isn't overwritten. Two batches,
      // because a bulk upsert fills missing keys with null and the column is NOT NULL.
      const now = new Date().toISOString();
      const withDegree = people
        .filter((p) => p.connection)
        .map((p) => ({ ...contactFields(p), connection: p.connection, connection_checked_at: now, lead_id: lead.id, kind: 'person' }));
      const withoutDegree = people
        .filter((p) => !p.connection)
        .map((p) => ({ ...contactFields(p), lead_id: lead.id, kind: 'person' }));
      for (const rows of [withDegree, withoutDegree]) {
        if (!rows.length) continue;
        const { error: upsertErr } = await supabase
          .from('lead_contacts')
          .upsert(rows, { onConflict: 'lead_id,linkedin_url' });
        if (upsertErr) { logError('findTeam upsert', upsertErr); return res.status(500).json({ error: upsertErr.message }); }
      }
    }

    if (source === 'apollo') await applyApolloFindings(lead, people, org);

    const { data: contacts, error: listErr } = await supabase
      .from('lead_contacts')
      .select('*')
      .eq('lead_id', lead.id)
      .eq('kind', 'person');
    if (listErr) { logError('findTeam list', listErr); return res.status(500).json({ error: listErr.message }); }

    // cachedOnly: don't start a second multi-minute Phantom run inside this request. Whatever the
    // search result's connection degree couldn't answer stays "unknown" until "Refresh connections".
    const { contacts: checked, connectionsAvailable } = await applyConnections(contacts, { cachedOnly: true });
    res.json({
      found: people.length,
      source,
      connections_available: connectionsAvailable,
      unknown_count: checked.filter((c) => c.connection === 'unknown').length,
      search: stats, // how many raw results LinkedIn returned and why any were dropped
      contacts: checked,
    });
  } catch (err) {
    sendPhantomError(res, 'findTeam (thrown)', err);
  }
}

// Adds a person to a lead from a pasted LinkedIn profile link, for companies the automatic
// lookup has no data on. From here it behaves exactly like a found person: Connection check,
// Select (connection request), LinkedIn Engagement.
async function addPerson(req, res) {
  try {
    const { lead_id, linkedin_url, name, role } = req.body || {};
    if (!lead_id) return res.status(400).json({ error: 'lead_id is required' });

    const parsed = canonicalProfileUrl(linkedin_url);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const personName = String(name || '').trim() || nameFromSlug(parsed.slug);
    if (!personName) return res.status(400).json({ error: "Add the person's name." });

    const { data: lead, error } = await supabase
      .from('leads')
      .select('id, company, name, role, linkedin_url')
      .eq('id', lead_id)
      .single();
    if (error) { logError('addPerson fetch lead', error); return res.status(404).json({ error: 'Lead not found' }); }

    const roleText = String(role || '').trim() || null;
    const row = {
      lead_id: lead.id, kind: 'person', name: personName, role: roleText,
      linkedin_url: parsed.url, is_founder: /founder|\bowner\b/i.test(roleText || ''),
    };
    const { error: upsertErr } = await supabase.from('lead_contacts').upsert(row, { onConflict: 'lead_id,linkedin_url' });
    if (upsertErr) { logError('addPerson upsert', upsertErr); return res.status(500).json({ error: upsertErr.message }); }

    const { data: saved, error: readErr } = await supabase
      .from('lead_contacts')
      .select('*')
      .eq('lead_id', lead.id)
      .eq('linkedin_url', parsed.url)
      .single();
    if (readErr) { logError('addPerson read', readErr); return res.status(500).json({ error: readErr.message }); }

    // If the connections list is already loaded, show Yes/No now; otherwise it stays Unknown until "Refresh connections".
    const { contacts } = await applyConnections([saved], { cachedOnly: true });

    // The lead's own contact feeds Email Outreach and the older LinkedIn message funnel; fill it only when empty.
    if (!lead.linkedin_url) {
      await supabase.from('leads').update({ name: personName, role: roleText, linkedin_url: parsed.url }).eq('id', lead.id);
    }

    res.status(201).json({ contact: contacts[0] });
  } catch (err) {
    logError('addPerson (thrown)', err);
    res.status(500).json({ error: err.message });
  }
}

// Re-checks connection status for saved contacts. { refresh: true } forces a fresh
// LinkedIn connections export instead of using the 6-hour cache.
async function checkConnections(req, res) {
  try {
    const { refresh = false, lead_ids } = req.body || {};
    let query = supabase.from('lead_contacts').select('*').eq('kind', 'person').not('linkedin_url', 'is', null);
    if (Array.isArray(lead_ids) && lead_ids.length) query = query.in('lead_id', lead_ids);
    const { data, error } = await query;
    if (error) { logError('checkConnections fetch', error); return res.status(500).json({ error: error.message }); }

    const { contacts, connectionsAvailable } = await applyConnections(data, { force: !!refresh });
    res.json({ checked: contacts.length, connections_available: connectionsAvailable });
  } catch (err) {
    sendPhantomError(res, 'checkConnections (thrown)', err);
  }
}

function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, '\\$&');
}

// Email Outreach and the LinkedIn follow-up funnel work per LEAD (one name, one email, one LinkedIn
// URL each), not per person at a company. So a person picked with "Select" needs a lead of their
// own, or they could never be drafted to, emailed or tracked as themselves.
//
//  - the company's own lead already stands for them when it holds their LinkedIn URL;
//  - a lead for the same LinkedIn profile is reused (and approved), never duplicated;
//  - otherwise a new lead is created: their name, role, LinkedIn URL and email (from the team
//    lookup if it has one, otherwise an Apollo lookup, about 1 credit, when `lookupEmail`).
// Created with source "by_name" so it's listed with the other name-based leads (Option 3) and follows
// the same connection -> message -> reminder funnel, and stays out of the company lists.
// Returns { lead, created } or null when the person has no LinkedIn URL.
async function ensurePersonLead(contact, parent, { lookupEmail = true } = {}) {
  if (contact.kind !== 'person' || !contact.linkedin_url) return null;
  const key = normalizeProfileUrl(contact.linkedin_url);

  if (parent.linkedin_url && normalizeProfileUrl(parent.linkedin_url) === key) {
    return { lead: parent, created: false };
  }

  const slug = key.split('/in/')[1]?.split('/')[0];
  if (slug) {
    const { data } = await supabase
      .from('leads')
      .select('id, status, email, linkedin_connection_status')
      .ilike('linkedin_url', `%/in/${escapeLike(slug)}%`)
      .limit(1);
    const existing = data?.[0];
    if (existing) {
      if (existing.status !== 'Approved' && existing.status !== 'Pushed') {
        await supabase.from('leads').update({ status: 'Approved' }).eq('id', existing.id);
      }
      return { lead: existing, created: false };
    }
  }

  const found = await apolloService.emailForPerson(
    { name: contact.name, company: parent.company, linkedin_url: contact.linkedin_url },
    { allowLookup: lookupEmail },
  );
  const { data: lead, error } = await supabase
    .from('leads')
    .insert({
      name: contact.name,
      company: parent.company,
      role: contact.role || null,
      linkedin_url: contact.linkedin_url,
      email: found?.email || null,
      source: 'by_name',
      status: 'Approved',
      notes: `Selected from ${parent.company || 'a company'}'s team`,
      enrichment_data: { parent_lead_id: parent.id, origin: 'team_select', ...(found ? { email_source: found.source } : {}) },
      linkedin_connection_status: 'not_sent',
    })
    .select()
    .single();
  if (error) throw error;
  return { lead, created: true };
}

// "Select" a person: marks them selected, gives them their own lead (so they appear on Email
// Outreach and in the LinkedIn follow-up), approves the company's lead, makes sure the company page
// has an entry on the Engagement page, and sends a LinkedIn connection request unless they're
// already a connection or one is pending.
async function selectContact(req, res) {
  try {
    const { data: contact, error } = await supabase
      .from('lead_contacts')
      .select('*, leads(id, company, linkedin_url, email, linkedin_connection_status)')
      .eq('id', req.params.id)
      .single();
    if (error) { logError('selectContact fetch', error); return res.status(404).json({ error: 'Contact not found' }); }
    const lead = contact.leads;

    await supabase.from('lead_contacts').update({ selected: true }).eq('id', contact.id);
    await supabase.from('leads').update({ status: 'Approved' }).eq('id', contact.lead_id);

    // Their own lead; a problem here must never block the selection or the connection request.
    let personLead = null;
    try {
      personLead = await ensurePersonLead(contact, lead);
    } catch (leadErr) {
      logError('selectContact ensurePersonLead', leadErr);
    }

    const { data: companyEntry } = await supabase
      .from('lead_contacts')
      .select('id')
      .eq('lead_id', contact.lead_id)
      .eq('kind', 'company')
      .maybeSingle();
    if (companyEntry) {
      await supabase.from('lead_contacts').update({ selected: true }).eq('id', companyEntry.id);
    } else {
      await supabase
        .from('lead_contacts')
        .insert({ lead_id: contact.lead_id, kind: 'company', name: lead.company || contact.name, selected: true });
    }

    let request;
    if (contact.connection === 'yes') {
      request = { sent: false, reason: 'already_connected' };
    } else if (contact.request_status === 'requested') {
      request = { sent: false, reason: 'already_requested' };
    } else if (!contact.linkedin_url) {
      request = { sent: false, error: 'No LinkedIn URL for this person — cannot send a connection request' };
    } else {
      try {
        await phantombusterService.sendConnectionRequest(contact.linkedin_url);
        const now = new Date().toISOString();
        await supabase
          .from('lead_contacts')
          .update({ request_status: 'requested', request_error: null, requested_at: now })
          .eq('id', contact.id);
        // The person's lead feeds the existing accepted-connection -> message funnel (the polling job
        // watches leads whose request is pending). If their lead couldn't be created, fall back to the
        // company lead when this person is its own contact.
        const funnelLead = personLead?.lead
          || (lead.linkedin_url && normalizeProfileUrl(lead.linkedin_url) === normalizeProfileUrl(contact.linkedin_url) ? lead : null);
        const funnelId = funnelLead?.id;
        if (funnelId && funnelLead.linkedin_connection_status !== 'accepted') {
          await supabase
            .from('leads')
            .update({ linkedin_connection_status: 'requested', linkedin_connection_requested_at: now })
            .eq('id', funnelId);
        }
        request = { sent: true };
      } catch (sendErr) {
        logError('selectContact sendConnectionRequest', sendErr);
        const friendly = friendlyPhantomError(sendErr).message;
        await supabase
          .from('lead_contacts')
          .update({ request_status: 'failed', request_error: friendly })
          .eq('id', contact.id);
        request = { sent: false, error: friendly };
      }
    }

    const { data: updated } = await supabase.from('lead_contacts').select('*').eq('id', contact.id).single();
    res.json({
      contact: updated,
      request,
      // Their own lead on Email Outreach: whether it was just created and whether it has an email yet.
      lead: personLead?.lead ? { id: personLead.lead.id, created: personLead.created, has_email: !!personLead.lead.email } : null,
    });
  } catch (err) {
    logError('selectContact (thrown)', err);
    res.status(500).json({ error: err.message });
  }
}

// Gives every already-selected person their own lead (people selected before this existed).
// Idempotent. Spends no Apollo credits unless { lookup_emails: true } is sent; emails already
// returned by a team lookup are reused either way.
async function syncSelectedLeads(req, res) {
  try {
    const lookupEmail = req.body?.lookup_emails === true;
    const { data: contacts, error } = await supabase
      .from('lead_contacts')
      .select('*, leads(id, company, linkedin_url, email, linkedin_connection_status)')
      .eq('kind', 'person')
      .eq('selected', true);
    if (error) { logError('syncSelectedLeads fetch', error); return res.status(500).json({ error: error.message }); }

    const out = { checked: contacts.length, created: 0, existing: 0, skipped: 0, failed: 0, leads: [] };
    for (const c of contacts) {
      try {
        const r = c.leads ? await ensurePersonLead(c, c.leads, { lookupEmail }) : null;
        if (!r) { out.skipped++; continue; }
        if (r.created) {
          out.created++;
          // A request already sent should be tracked for acceptance like one sent from now on.
          if (c.request_status === 'requested') {
            await supabase
              .from('leads')
              .update({ linkedin_connection_status: 'requested', linkedin_connection_requested_at: c.requested_at || new Date().toISOString() })
              .eq('id', r.lead.id);
          }
        } else {
          out.existing++;
        }
        out.leads.push({ name: c.name, company: c.leads.company, created: r.created, has_email: !!r.lead.email });
      } catch (err) {
        out.failed++;
        logError('syncSelectedLeads person', err);
      }
    }
    res.json(out);
  } catch (err) {
    logError('syncSelectedLeads (thrown)', err);
    res.status(500).json({ error: err.message });
  }
}

async function deselectContact(req, res) {
  try {
    const { data: contact, error } = await supabase
      .from('lead_contacts')
      .update({ selected: false })
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) { logError('deselectContact', error); return res.status(404).json({ error: 'Contact not found' }); }

    // Drop the company-page entry once none of the company's people are selected.
    const { count } = await supabase
      .from('lead_contacts')
      .select('id', { count: 'exact', head: true })
      .eq('lead_id', contact.lead_id)
      .eq('kind', 'person')
      .eq('selected', true);
    if (!count) {
      await supabase.from('lead_contacts').update({ selected: false }).eq('lead_id', contact.lead_id).eq('kind', 'company');
    }
    res.json(contact);
  } catch (err) {
    logError('deselectContact (thrown)', err);
    res.status(500).json({ error: err.message });
  }
}

// A company page's posts live under /posts/; the bare page URL only shows its overview.
function activityUrl(url, kind) {
  const m = /^(https?:\/\/(?:[a-z]+\.)?linkedin\.com\/(?:company|school)\/[^/?#]+)/i.exec(url || '');
  if (kind === 'company' && m) return `${m[1]}/posts/?feedView=all`;
  return url;
}

// Loads the latest posts for a person / company page and stores a summary of what they post about.
async function refreshPosts(req, res) {
  try {
    const { data: contact, error } = await supabase.from('lead_contacts').select('*').eq('id', req.params.id).single();
    if (error) { logError('refreshPosts fetch', error); return res.status(404).json({ error: 'Contact not found' }); }

    let url = contact.linkedin_url;
    if (!url && contact.kind === 'company') {
      url = await phantombusterService.searchCompanyPage(contact.name);
      if (url) await supabase.from('lead_contacts').update({ linkedin_url: url }).eq('id', contact.id);
    }
    if (!url) return res.status(422).json({ error: "Couldn't find a LinkedIn page for this company" });

    const { posts, debug } = await phantombusterService.fetchPostsFor(activityUrl(url, contact.kind));
    const summary = posts.length
      ? await claudeService.summarizeLinkedInPosts(contact.name, posts)
      : 'No recent public posts found.';
    // When nothing came back, say what the Phantom did return, so it's clear whether the page
    // really has no posts or the Phantom's output wasn't understood.
    const postsNote = posts.length
      ? null
      : debug.records
        ? `The Phantom returned ${debug.records} record(s) but no post text was found in them (fields: ${debug.fields.join(', ') || 'none'}).`
        : `The Phantom returned no records.${debug.phantom_output ? ` Its last messages: ${debug.phantom_output}` : ''}`;
    if (postsNote) console.log(`[refreshPosts] ${contact.name}: ${postsNote}`);

    const { data, error: updateErr } = await supabase
      .from('lead_contacts')
      .update({
        linkedin_url: url,
        recent_posts: posts,
        post_summary: summary,
        post_summary_at: new Date().toISOString(),
        comment_suggestions: null,
      })
      .eq('id', contact.id)
      .select()
      .single();
    if (updateErr) { logError('refreshPosts update', updateErr); return res.status(500).json({ error: updateErr.message }); }
    res.json({ ...data, posts_note: postsNote });
  } catch (err) {
    sendPhantomError(res, 'refreshPosts (thrown)', err);
  }
}

// Proposes comment options for their latest post. Nothing is posted here.
async function draftComments(req, res) {
  try {
    const { data: contact, error } = await supabase.from('lead_contacts').select('*').eq('id', req.params.id).single();
    if (error) { logError('draftComments fetch', error); return res.status(404).json({ error: 'Contact not found' }); }

    const posts = Array.isArray(contact.recent_posts) ? contact.recent_posts : [];
    const post = posts[Number(req.body?.post_index) || 0];
    if (!post) return res.status(422).json({ error: 'No posts loaded yet — load posts first' });

    const options = await claudeService.draftLinkedInCommentOptions(contact.name, post);
    const suggestions = { post_url: post.post_url, post_text: post.text, options };
    const { data, error: updateErr } = await supabase
      .from('lead_contacts')
      .update({ comment_suggestions: suggestions })
      .eq('id', contact.id)
      .select()
      .single();
    if (updateErr) { logError('draftComments update', updateErr); return res.status(500).json({ error: updateErr.message }); }
    res.json(data);
  } catch (err) {
    logError('draftComments (thrown)', err);
    res.status(500).json({ error: err.message });
  }
}

// The domain the Auto Commenter's spreadsheet URL is served from — same Railway service
// as the app itself. Overridable via env in case the backend ever moves.
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://wavelength-production-6609.up.railway.app';

function csvField(value) {
  // Always quote, doubling any internal quotes — simplest way to survive commas/quotes
  // in a post URL or comment text without needing to special-case them.
  return `"${String(value).replace(/"/g, '""')}"`;
}

// Serves a one-row, no-header CSV (post URL in column A, comment in column B) built from
// the query string. Public and unauthenticated on purpose — the Auto Commenter Phantom
// fetches it directly, has no way to send our app's credentials, and the content is only
// a public LinkedIn post URL plus a comment that's about to be posted publicly anyway.
async function commentCsv(req, res) {
  const { url, comment } = req.query;
  if (!url || !comment) return res.status(400).send('url and comment query params are required');
  res.type('text/csv').send(`${csvField(url)},${csvField(comment)}\n`);
}

// Posts the user's final comment on LinkedIn. Only ever called from an explicit "Post comment" click.
async function postComment(req, res) {
  try {
    const { post_url, body } = req.body;
    if (!post_url || !body || !String(body).trim()) {
      return res.status(400).json({ error: 'post_url and a non-empty body are required' });
    }
    const text = String(body).trim();
    const csvUrl = `${PUBLIC_BASE_URL}/api/contacts/comment.csv?url=${encodeURIComponent(post_url)}&comment=${encodeURIComponent(text)}`;
    await phantombusterService.postLinkedInComment(csvUrl);

    const { data, error } = await supabase
      .from('lead_contacts')
      .update({ last_comment: text, commented_at: new Date().toISOString(), comment_suggestions: null })
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) { logError('postComment update', error); return res.status(500).json({ error: error.message }); }
    res.json(data);
  } catch (err) {
    sendPhantomError(res, 'postComment (thrown)', err);
  }
}

module.exports = {
  listContacts, findTeam, addPerson, checkConnections,
  selectContact, deselectContact, syncSelectedLeads,
  refreshPosts, draftComments, postComment, commentCsv,
};
