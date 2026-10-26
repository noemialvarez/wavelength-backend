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

// Checks a pasted link is a person's LinkedIn profile and returns its canonical form
// ({ url, slug }), or { error } with a message to show the user. Company pages, other sites and
// bare text are refused: a connection request needs a person's profile.
function canonicalProfileUrl(input) {
  const s = String(input || '').trim();
  if (!s) return { error: "Paste the person's LinkedIn profile link." };
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return { error: "That doesn't look like a link." };
  }
  if (!/(^|\.)linkedin\.com$/i.test(url.hostname)) return { error: 'That is not a LinkedIn link.' };
  const m = url.pathname.match(/^\/in\/([^/]+)/i);
  if (!m) {
    return {
      error: /^\/company\//i.test(url.pathname)
        ? "That's a company page. Paste a person's profile link (linkedin.com/in/…)."
        : "Paste a person's profile link (linkedin.com/in/…).",
    };
  }
  let slug = m[1];
  try { slug = decodeURIComponent(slug); } catch { /* keep as is */ }
  return { url: `https://www.linkedin.com/in/${slug}`, slug };
}

// "daniel-kuntz-1a2b3c4d" -> "Daniel Kuntz". Null when the slug carries no readable name
// (for example an opaque member id), so the caller can ask for one.
function nameFromSlug(slug) {
  if (!slug || isMemberIdUrl(`/in/${slug}`)) return null;
  const parts = String(slug).split('-').filter(Boolean);
  // LinkedIn appends a short mixed letters-and-digits id to common names ("...-1a2b3c4d").
  const last = parts[parts.length - 1];
  if (parts.length > 1 && last && last.length >= 6 && /\d/.test(last)) parts.pop();
  const words = parts.filter((w) => /^[a-zÀ-ɏ.']+$/i.test(w));
  if (!words.length) return null;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

module.exports = { normalizeProfileUrl, isMemberIdUrl, canonicalProfileUrl, nameFromSlug };
