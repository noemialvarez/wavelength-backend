// Rank common job titles from most senior (high) to least senior (low).
// Returns a numeric score; sortBySeniority returns titles in descending order.
const SENIORITY_BANDS = [
  { rank: 100, patterns: [/\bceo\b/i, /chief executive/i, /\bpresident\b/i, /\bfounder\b/i, /co.?founder/i, /\bowner\b/i, /managing director/i, /\bmd\b/i] },
  { rank: 90,  patterns: [/\bcoo\b/i, /chief operating/i, /\bcfo\b/i, /chief financial/i, /\bcto\b/i, /chief technology/i, /\bcmo\b/i, /chief marketing/i, /\bcro\b/i, /chief revenue/i, /\bcpo\b/i, /chief product/i, /\bcio\b/i, /chief information/i, /chief [a-z ]+ officer/i] },
  { rank: 80,  patterns: [/\bsvp\b/i, /senior vice president/i, /\bevp\b/i, /executive vice president/i] },
  { rank: 70,  patterns: [/\bvp\b/i, /vice president/i] },
  { rank: 60,  patterns: [/\bhead of\b/i] },
  { rank: 50,  patterns: [/\bdirector\b/i] },
  { rank: 40,  patterns: [/senior manager/i, /\bprincipal\b/i] },
  { rank: 30,  patterns: [/\bmanager\b/i] },
  { rank: 20,  patterns: [/\blead\b/i] },
  { rank: 10,  patterns: [/\bsenior\b/i, /\bsr\.?\b/i] },
  { rank: 0,   patterns: [/\bassociate\b/i, /\bjunior\b/i, /\bjr\.?\b/i] },
];

function seniorityRank(title) {
  if (!title) return -1;
  for (const { rank, patterns } of SENIORITY_BANDS) {
    if (patterns.some((p) => p.test(title))) return rank;
  }
  return 5;
}

function sortBySeniority(titles) {
  if (!Array.isArray(titles)) return [];
  return titles
    .filter((t) => typeof t === 'string' && t.trim().length)
    .map((t) => t.trim())
    .sort((a, b) => seniorityRank(b) - seniorityRank(a));
}

module.exports = { seniorityRank, sortBySeniority };
