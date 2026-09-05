const WORKSPACE_ID = "efood-ops-demo";
const HEADERS = { "Content-Type": "application/json; charset=utf-8", "X-Workspace-Id": WORKSPACE_ID };

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Μετατρέπει **bold** και newlines σε πραγματικό HTML -- χρησιμοποιείται
// τόσο στο chat widget όσο και στο δοκιμαστικό ερώτημα του editor, ώστε
// και τα δύο να δείχνουν καθαρή, μορφοποιημένη απάντηση, ποτέ raw κείμενο.
function formatAnswer(text) {
  let safe = escapeHtml(text);
  safe = safe.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  safe = safe.replace(/\n/g, "<br>");
  return safe;
}

// Παράγει τεχνικό documentId από τον τίτλο -- ο editor δεν χρειάζεται ποτέ
// να σκεφτεί ή να πληκτρολογήσει ID χειροκίνητα. Μετατρέπει Ελληνικά σε
// Λατινικά (ίδιο στυλ με τα ήδη υπάρχοντα slugs: shop-journey,
// verification-process), αφαιρεί τόνους/κενά, κρατάει μόνο πεζά+παύλες.
const GREEK_TO_LATIN = {
  "α":"a","ά":"a","β":"v","γ":"g","δ":"d","ε":"e","έ":"e","ζ":"z","η":"i","ή":"i",
  "θ":"th","ι":"i","ί":"i","ϊ":"i","ΐ":"i","κ":"k","λ":"l","μ":"m","ν":"n","ξ":"x",
  "ο":"o","ό":"o","π":"p","ρ":"r","σ":"s","ς":"s","τ":"t","υ":"y","ύ":"y","ϋ":"y","ΰ":"y",
  "φ":"f","χ":"ch","ψ":"ps","ω":"o","ώ":"o",
};

function slugify(title) {
  const lower = String(title).trim().toLowerCase();
  let out = "";
  for (const ch of lower) {
    out += GREEK_TO_LATIN[ch] !== undefined ? GREEK_TO_LATIN[ch] : ch;
  }
  out = out
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return out || "";
}

// "πριν 3 ώρες", "πριν 2 μέρες" κ.λπ. -- για να διαβάζεται εύκολα η λίστα
// εγγράφων στο editor, χωρίς ωμές ημερομηνίες ISO.
function timeAgo(iso) {
  if (!iso) return "";
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "μόλις τώρα";
  if (mins < 60) return `πριν ${mins} ${mins === 1 ? "λεπτό" : "λεπτά"}`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `πριν ${hours} ${hours === 1 ? "ώρα" : "ώρες"}`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `πριν ${days} ${days === 1 ? "μέρα" : "μέρες"}`;
  const months = Math.floor(days / 30);
  if (months < 12) return `πριν ${months} ${months === 1 ? "μήνα" : "μήνες"}`;
  const years = Math.floor(months / 12);
  return `πριν ${years} ${years === 1 ? "χρόνο" : "χρόνια"}`;
}