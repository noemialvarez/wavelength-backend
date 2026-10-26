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
    const { selected, lead_id } = req.query;
    let query = supabase
      .from('lead_contacts')
      .select('*, leads(id, company, name, status)')
      .order('created_at', { ascending: true })
      .limit(2000);
    if (selected === 'true') query = query.eq('selected', true);
    if (lead_id) query = query.eq('lead_id', lead_id);

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

// "Select" a person: marks them selected, approves their lead (so it flows on to Email
// Outreach), makes sure the company page has an entry on the Engagement page, and sends a
// LinkedIn connection request unless they're already a connection or one is pending.
async function selectContact(req, res) {
  try {
    const { data: contact, error } = await supabase
      .from('lead_contacts')
      .select('*, leads(id, company, linkedin_url)')
      .eq('id', req.params.id)
      .single();
    if (error) { logError('selectContact fetch', error); return res.status(404).json({ error: 'Contact not found' }); }
    const lead = contact.leads;

    await supabase.from('lead_contacts').update({ selected: true }).eq('id', contact.id);
    await supabase.from('leads').update({ status: 'Approved' }).eq('id', contact.lead_id);

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
        // The lead's own founder also feeds the existing accepted-connection → message funnel.
        if (lead.linkedin_url && normalizeProfileUrl(lead.linkedin_url) === normalizeProfileUrl(contact.linkedin_url)) {
          await supabase
            .from('leads')
            .update({ linkedin_connection_status: 'requested', linkedin_connection_requested_at: now })
            .eq('id', contact.lead_id);
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
    res.json({ contact: updated, request });
  } catch (err) {
    logError('selectContact (thrown)', err);
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

    const posts = await phantombusterService.fetchPostsFor(url);
    const summary = posts.length
      ? await claudeService.summarizeLinkedInPosts(contact.name, posts)
      : 'No recent public posts found.';

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
    res.json(data);
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
  selectContact, deselectContact,
  refreshPosts, draftComments, postComment, commentCsv,
};
