// Helpers for turning a lead's "company" text into something that can be searched for and
// compared. A lead's company is sometimes a plain name ("Coda Labs", "Create.xyz"), sometimes
// carries a legal suffix ("Flottando AG"), and sometimes is a web address ("https://sekoia.io").

// Lowercase letters and digits only, accents ignored: "Zürich Labs" -> "zurichlabs".
function alnum(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

const LEGAL_SUFFIX_RE = /[\s,.]+(ag|gmbh|sa|sarl|sàrl|ltd|limited|inc|llc|plc|bv|nv|ab|oy|kg|co)\.?$/i;

// Only treat text as a web address when it clearly is one (scheme or "www."); a bare
// "Create.xyz" is a company name that happens to look like a domain.
function looksLikeWebAddress(s) {
  return /^(https?:\/\/|www\.)/i.test(String(s || '').trim());
}

// The host of a web address without "www." ("https://www.deepinstinct.com/about" -> "deepinstinct.com"),
// or null when the text isn't a web address.
function domainOf(name) {
  const s = String(name || '').trim();
  if (!looksLikeWebAddress(s)) return null;
  try {
    return new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`).hostname.replace(/^www\./i, '') || null;
  } catch {
    return null;
  }
}

// The name to search for. A web address becomes its domain label ("https://deepinstinct.com" ->
// "deepinstinct"); legal suffixes ("AG", "GmbH", "Inc") are dropped, since profiles rarely
// include them.
function searchableCompanyName(name) {
  let s = String(name || '').trim();
  const host = domainOf(s);
  if (host) {
    const parts = host.split('.');
    const secondLevel = ['co', 'com', 'org', 'net', 'ac', 'gov'];
    s = parts.length >= 3 && secondLevel.includes(parts[parts.length - 2])
      ? parts[parts.length - 3]
      : parts[Math.max(0, parts.length - 2)];
  }
  for (let i = 0; i < 2; i++) s = s.replace(LEGAL_SUFFIX_RE, '');
  return s.trim();
}

module.exports = { alnum, domainOf, searchableCompanyName };
