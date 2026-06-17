const axios = require('axios');

function isConfigured() {
  const key = process.env.APOLLO_API_KEY;
  return !!(key && key !== 'your-apollo-api-key' && key.length > 10);
}

/**
 * Look up a person's email via Apollo People Match.
 * Returns the email string on success, null if not found or key not configured.
 * Never throws — failures are logged and swallowed so the caller flow continues.
 */
async function findEmail(name, company, linkedin_url) {
  if (!isConfigured()) {
    console.log('[Apollo] API key not configured — skipping email lookup');
    return null;
  }
  if (!name || !company) return null;

  const parts = name.trim().split(/\s+/);
  const firstName = parts[0];
  const lastName = parts.slice(1).join(' ') || undefined;

  const endpoint = 'https://api.apollo.io/api/v1/people/match';
  const payload = {
    first_name: firstName,
    last_name: lastName,
    organization_name: company,
    reveal_personal_emails: false,
  };
  if (linkedin_url) payload.linkedin_url = linkedin_url;
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache',
    'X-Api-Key': process.env.APOLLO_API_KEY,
  };

  console.log('[Apollo] Request →', {
    endpoint,
    headers: { ...headers, 'X-Api-Key': '[redacted]' },
    body: payload,
  });

  try {
    const { data } = await axios.post(endpoint, payload, { headers, timeout: 10000 });

    console.log('[Apollo] Full response:', JSON.stringify(data, null, 2));

    const email = data?.person?.email;
    if (email) {
      console.log(`[Apollo] Found email for ${name} @ ${company}: ${email}`);
    } else {
      console.log(`[Apollo] No email found for ${name} @ ${company}`);
    }
    return email || null;
  } catch (err) {
    const status = err?.response?.status;
    console.error('[Apollo] Error response:', JSON.stringify(err?.response?.data, null, 2));
    if (status === 401 || status === 403) {
      console.error('[Apollo] Authentication failed — check APOLLO_API_KEY');
    } else if (status === 429) {
      console.error('[Apollo] Rate limit hit');
    } else {
      console.error('[Apollo] findEmail error:', err.message);
    }
    return null;
  }
}

/**
 * Look up a company's employee count via Apollo Organization Enrich.
 * Returns the estimated_num_employees integer, or null if not found.
 * Never throws.
 */
async function getCompanyEmployeeCount(domain) {
  if (!isConfigured() || !domain) return null;
  // Strip protocol/path to get bare domain
  const bare = domain.replace(/^https?:\/\//i, '').split('/')[0].trim();
  if (!bare) return null;
  try {
    const { data } = await axios.get(
      'https://api.apollo.io/api/v1/organizations/enrich',
      {
        params: { domain: bare },
        headers: { 'X-Api-Key': process.env.APOLLO_API_KEY, 'Cache-Control': 'no-cache' },
        timeout: 8000,
      }
    );
    const count = data?.organization?.estimated_num_employees ?? null;
    console.log(`[Apollo] ${bare} employee count: ${count}`);
    return count;
  } catch (err) {
    console.error(`[Apollo] getCompanyEmployeeCount failed for ${bare}:`, err?.response?.status ?? err.message);
    return null;
  }
}

module.exports = { isConfigured, findEmail, getCompanyEmployeeCount };
