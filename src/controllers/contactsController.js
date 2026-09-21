const supabase = require('../config/supabase');
const phantombusterService = require('../services/phantombusterService');
const claudeService = require('../services/claudeService');
const logError = require('../utils/logError');
const { normalizeProfileUrl, isMemberIdUrl } = require('../utils/linkedinUrl');

// yes | no | unknown. "unknown" whenever we can't tell — no connections export
// available, or the URL is an opaque member-id URL — so we never claim "no" wrongly.
function connectionFor(url, connectionSet) {
  if (!url || !connectionSet || isMemberIdUrl(url)) return 'unknown';
  return connectionSet.has(normalizeProfileUrl(url)) ? 'yes' : 'no';
}

// Re-computes the connection status for the given person contacts and saves changes.
async function applyConnections(contacts, { force = false } = {}) {
  let connectionSet = null;
  try {
    connectionSet = await phantombusterService.getConnectionSet({ force });
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
    if (connection === c.connection) { out.push(c); continue; }
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

// Finds the founders and executive team of a lead's company on LinkedIn, saves them as
// contacts, and checks which ones we're already connected to.
async function findTeam(req, res) {
  try {
    const { lead_id } = req.body;
    if (!lead_id) return res.status(400).json({ error: 'lead_id is required' });

    const { data: lead, error } = await supabase
      .from('leads')
      .select('id, company, name, role, linkedin_url')
      .eq('id', lead_id)
      .single();
    if (error) { logError('findTeam fetch lead', error); return res.status(404).json({ error: 'Lead not found' }); }
    if (!lead.company) return res.status(400).json({ error: 'Lead has no company name to search for' });

    const people = await phantombusterService.searchTeam(lead.company);

    // Keep the founder already found for this lead, even if the team search missed them.
    if (lead.linkedin_url && lead.name && lead.name !== lead.company) {
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
      const rows = people.map((p) => ({ ...p, lead_id: lead.id, kind: 'person' }));
      const { error: upsertErr } = await supabase
        .from('lead_contacts')
        .upsert(rows, { onConflict: 'lead_id,linkedin_url' });
      if (upsertErr) { logError('findTeam upsert', upsertErr); return res.status(500).json({ error: upsertErr.message }); }
    }

    const { data: contacts, error: listErr } = await supabase
      .from('lead_contacts')
      .select('*')
      .eq('lead_id', lead.id)
      .eq('kind', 'person');
    if (listErr) { logError('findTeam list', listErr); return res.status(500).json({ error: listErr.message }); }

    const { contacts: checked, connectionsAvailable } = await applyConnections(contacts);
    res.json({ found: people.length, connections_available: connectionsAvailable, contacts: checked });
  } catch (err) {
    logError('findTeam (thrown)', err);
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
    logError('checkConnections (thrown)', err);
    res.status(500).json({ error: err.message });
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
        await supabase
          .from('lead_contacts')
          .update({ request_status: 'failed', request_error: sendErr.message })
          .eq('id', contact.id);
        request = { sent: false, error: sendErr.message };
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
    logError('refreshPosts (thrown)', err);
    res.status(500).json({ error: err.message });
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

// Posts the user's final comment on LinkedIn. Only ever called from an explicit "Post comment" click.
async function postComment(req, res) {
  try {
    const { post_url, body } = req.body;
    if (!post_url || !body || !String(body).trim()) {
      return res.status(400).json({ error: 'post_url and a non-empty body are required' });
    }
    await phantombusterService.postLinkedInComment(post_url, String(body).trim());

    const { data, error } = await supabase
      .from('lead_contacts')
      .update({ last_comment: String(body).trim(), commented_at: new Date().toISOString(), comment_suggestions: null })
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) { logError('postComment update', error); return res.status(500).json({ error: error.message }); }
    res.json(data);
  } catch (err) {
    logError('postComment (thrown)', err);
    res.status(500).json({ error: err.message });
  }
}

module.exports = {
  listContacts, findTeam, checkConnections,
  selectContact, deselectContact,
  refreshPosts, draftComments, postComment,
};
