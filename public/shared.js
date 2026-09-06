// Κάθε επισκέπτης διαλέγει ρητά, στη landing page, "Developer" (με κωδικό,
// πάει στο πραγματικό demo workspace) ή "Επισκέπτης/Guest" (παίρνει ένα
// τυχαίο, δικό του, απομονωμένο workspace). Η επιλογή αποθηκεύεται εδώ
// (localStorage) ώστε να μη ρωτάει ξανά στο ίδιο browser. Αν δεν έχει γίνει
// ακόμα καμία επιλογή, στέλνουμε στη landing page πριν φορτώσει οτιδήποτε
// άλλο -- δεν έχει νόημα να καλέσουμε το backend χωρίς workspace.
function resolveWorkspaceId() {
  const stored = localStorage.getItem("workspaceId");
  if (stored) return stored;
  window.location.href = "/landing.html";
  return null;
}

const WORKSPACE_ID = resolveWorkspaceId();
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

// Πλήρης μετατροπή markdown -> HTML για το κείμενο ενός εγγράφου. Χρησιμοποιεί
// το marked.js (πλήρες markdown: επικεφαλίδες, links, πίνακες, code, quotes,
// λίστες, **bold**, *πλάγια* κ.λπ.) και το DOMPurify για καθαρισμό του HTML
// πριν μπει στη σελίδα -- το marked ΔΕΝ καθαρίζει μόνο του το output του.
// Ίδια συνάρτηση χρησιμοποιείται στο live preview του editor, στο read-only
// preview, και στη δημόσια σελίδα άρθρου -- μία πηγή αλήθειας για το πώς
// φαίνεται το κείμενο.
function renderMarkdown(text) {
  if (!text) return "";
  const html = marked.parse(text);
  return typeof DOMPurify !== "undefined" ? DOMPurify.sanitize(html) : html;
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

// "Λήγει σε 3 ημέρες" -- μόνο για έγγραφα επισκεπτών (workspaces εκτός του
// προστατευμένου), όπου κάθε ανενεργό έγγραφο έχει αυτόματη λήξη. Επιστρέφει
// null όταν δεν υπάρχει expiresAt, ώστε το frontend να μη δείξει τίποτα.
function expiryLabel(expiresAt) {
  if (!expiresAt) return null;
  const diffMs = new Date(expiresAt).getTime() - Date.now();
  const days = Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
  if (days === 0) return "Λήγει σήμερα";
  return `Λήγει σε ${days} ${days === 1 ? "ημέρα" : "ημέρες"}`;
}