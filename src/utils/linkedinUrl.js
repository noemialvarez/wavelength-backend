// Normalises a LinkedIn profile URL for comparison — strips protocol, "www.",
// trailing slash and query string so formatting differences don't cause false negatives.
function normalizeProfileUrl(url) {
  if (!url) return '';
  return String(url)
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split(/[?#]/)[0]
    .replace(/\/+$/, '')
    .toLowerCase();
}

// Search results sometimes return opaque member-id URLs (/in/ACoAAB...) instead of the
// vanity URL (/in/first-last) a connections export uses. Those can't be compared, so
// callers should treat the connection status as unknown rather than "not connected".
function isMemberIdUrl(url) {
  return /\/in\/ac[ow][a-z0-9_-]{10,}/i.test(url || '');
}

module.exports = { normalizeProfileUrl, isMemberIdUrl };
