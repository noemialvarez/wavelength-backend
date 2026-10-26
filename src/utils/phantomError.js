// Turns a raw Phantombuster / LinkedIn failure into a message the UI can show as-is,
// instead of the generic "check backend connection". Returns { status, code, message }.
function friendlyPhantomError(err) {
  // Errors that already carry their own plain-language message (e.g. from the Apollo lookup).
  if (err?.friendly) return err.friendly;
  let raw = String(err?.message || err || 'Unknown error');
  if (err?.response?.data) {
    try { raw += `: ${JSON.stringify(err.response.data)}`; } catch { /* ignore */ }
  }

  if (/api key (not found|invalid)|missing session cookie or api key/i.test(raw)) {
    return {
      status: 502,
      code: 'phantombuster_key',
      message: 'PhantomBuster rejected the API key. Check PHANTOMBUSTER_API_KEY in Railway.',
    };
  }
  if (/cookie|credentials|log in to linkedin|session/i.test(raw)) {
    return {
      status: 502,
      code: 'linkedin_session',
      message:
        'LinkedIn session expired or invalid. Copy a fresh li_at cookie, update PHANTOMBUSTER_LINKEDIN_SESSION in Railway, then retry.',
    };
  }
  if (/execution time|out of (time|credit)|no slots|upgrade your plan/i.test(raw)) {
    return {
      status: 502,
      code: 'phantombuster_plan',
      message: 'PhantomBuster has no execution time or slots left on your plan. Check usage there, then retry.',
    };
  }
  return { status: 500, code: 'phantombuster', message: raw.slice(0, 400) };
}

module.exports = { friendlyPhantomError };
