const CHUNK_SIZE = 300;
const CHUNK_OVERLAP = 30;
const TOP_K = 4;
const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };
const MAX_UPLOAD_WORDS = 8000;
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

function chunkText(text) {
  const words = text.trim().split(/\s+/);
  const chunks = [];
  let start = 0;

  while (start < words.length) {
    const end = Math.min(start + CHUNK_SIZE, words.length);
    chunks.push(words.slice(start, end).join(" "));
    if (end === words.length) break;
    start += CHUNK_SIZE - CHUNK_OVERLAP;
  }

  return chunks;
}

async function getEmbedding(text, apiKey) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "models/gemini-embedding-001",
        content: { parts: [{ text }] },
        outputDimensionality: 768,
      }),
    }
  );

  const data = await response.json();

  if (!data.embedding || !data.embedding.values) {
    throw new Error("Embedding failed: " + JSON.stringify(data));
  }

  return data.embedding.values;
}

async function askGemini(context, question, apiKey) {
  const prompt = `Απάντησε στην ερώτηση χρησιμοποιώντας ΜΟΝΟ τις παρακάτω πληροφορίες. Αν η απάντηση δεν βρίσκεται στις πληροφορίες, πες ότι δεν γνωρίζεις.

Πληροφορίες:
${context}

Ερώτηση: ${question}`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
    }
  );

  const data = await response.json();

  const answer = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!answer) {
    throw new Error("Gemini generation failed: " + JSON.stringify(data));
  }

  return answer;
}

function makePreview(text, maxWords = 18) {
  const words = text.trim().split(/\s+/);
  const preview = words.slice(0, maxWords).join(" ");
  return words.length > maxWords ? preview + "…" : preview;
}

async function handleUpload(request, env) {
  const workspaceId = request.headers.get("X-Workspace-Id");
  if (!workspaceId) {
    return new Response(
      JSON.stringify({ error: "Missing X-Workspace-Id header" }),
      { status: 400, headers: JSON_HEADERS }
    );
  }

  const body = await request.json();
  const { documentId, text, title, volatility, sourceUrl } = body;

  if (!documentId || !text) {
    return new Response(
      JSON.stringify({ error: "documentId and text are required" }),
      { status: 400, headers: JSON_HEADERS }
    );
  }

  // Όριο μεγέθους -- προστασία δημόσιου demo από ακραία/κατά λάθος μεγάλα
  // uploads. Ελέγχεται ΠΡΙΝ το chunking/embedding, ώστε να μη σπαταλάμε
  // κλήσεις στο Gemini για κείμενο που θα απορριφθεί ούτως ή άλλως.
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
  const byteSize = new TextEncoder().encode(text).length;

  if (wordCount > MAX_UPLOAD_WORDS || byteSize > MAX_UPLOAD_BYTES) {
    return new Response(
      JSON.stringify({
        error: `Το κείμενο ξεπερνά το επιτρεπτό όριο (μέγιστο ${MAX_UPLOAD_WORDS} λέξεις ή 2MB). Το έγγραφο έχει ${wordCount} λέξεις (${(byteSize / 1024 / 1024).toFixed(2)}MB).`,
      }),
      { status: 400, headers: JSON_HEADERS }
    );
  }

  const kvKey = `session:${workspaceId}:doc:${documentId}`;

  const existingRaw = await env.DOCUMENT_REGISTRY.get(kvKey);
  if (existingRaw) {
    const existing = JSON.parse(existingRaw);
    const idsToDelete = [];
    for (let i = 0; i < existing.chunkCount; i++) {
      idsToDelete.push(`${documentId}-chunk-${i}`);
    }
    await env.VECTORIZE.deleteByIds(idsToDelete);
  }

  const chunks = chunkText(text);

  const vectors = [];
  for (let i = 0; i < chunks.length; i++) {
    const embedding = await getEmbedding(chunks[i], env.GEMINI_API_KEY);
    vectors.push({
      id: `${documentId}-chunk-${i}`,
      values: embedding,
      namespace: workspaceId,
      metadata: {
        documentId,
        chunkIndex: i,
        text: chunks[i],
      },
    });
  }

  await env.VECTORIZE.upsert(vectors);

  // Αποθηκεύουμε το κείμενο όπως ακριβώς το έστειλε ο editor (παράγραφοι,
  // κενές γραμμές, τίτλοι -- ό,τι δομή είχε ήδη) μία φορά, αυτούσιο.
  // Το chunking παραπάνω παραμένει ξεχωριστό και χρησιμεύει ΜΟΝΟ για
  // embeddings/αναζήτηση -- ποτέ πια δεν το χρησιμοποιούμε για να δείξουμε
  // κείμενο σε άνθρωπο.
  await env.DOCUMENT_REGISTRY.put(
    kvKey,
    JSON.stringify({
      title: title || null,
      chunkCount: chunks.length,
      updatedAt: new Date().toISOString(),
      volatility: volatility || null,
      sourceUrl: sourceUrl || null,
      fullText: text,
    })
  );

  return new Response(
    JSON.stringify({ documentId, chunksCreated: chunks.length }),
    { headers: JSON_HEADERS }
  );
}

async function handleGetDocument(request, env, documentId) {
  const workspaceId = request.headers.get("X-Workspace-Id");
  if (!workspaceId) {
    return new Response(
      JSON.stringify({ error: "Missing X-Workspace-Id header" }),
      { status: 400, headers: JSON_HEADERS }
    );
  }

  const kvKey = `session:${workspaceId}:doc:${documentId}`;
  const existingRaw = await env.DOCUMENT_REGISTRY.get(kvKey);

  if (!existingRaw) {
    return new Response(
      JSON.stringify({ error: "Document not found" }),
      { status: 404, headers: JSON_HEADERS }
    );
  }

  const existing = JSON.parse(existingRaw);

  // Διαβάζουμε απευθείας το αυτούσιο κείμενο από το KV -- καμία ανακατασκευή
  // από chunks πλέον, άρα καμία απώλεια δομής (παράγραφοι, κενές γραμμές κ.λπ.).
  //
  // Fallback: έγγραφα που ανέβηκαν ΠΡΙΝ αυτή την αλλαγή δεν έχουν ακόμα
  // αποθηκευμένο fullText. Γι' αυτά κάνουμε την παλιά ανακατασκευή από τα
  // chunks, ώστε να μη σπάσουν -- μέχρι να ξανα-ανέβουν και να αποκτήσουν
  // κανονικό fullText.
  let fullText = existing.fullText;

  if (!fullText) {
    const ids = [];
    for (let i = 0; i < existing.chunkCount; i++) {
      ids.push(`${documentId}-chunk-${i}`);
    }
    const result = await env.VECTORIZE.getByIds(ids);
    const sorted = result.sort((a, b) => a.metadata.chunkIndex - b.metadata.chunkIndex);
    fullText = sorted.map((v) => v.metadata.text).join(" ");
  }

  return new Response(
    JSON.stringify({
      documentId,
      title: existing.title || null,
      chunkCount: existing.chunkCount,
      updatedAt: existing.updatedAt,
      sourceUrl: existing.sourceUrl || null,
      text: fullText,
    }),
    { headers: JSON_HEADERS }
  );
}

async function handleListDocuments(request, env) {
  const workspaceId = request.headers.get("X-Workspace-Id");
  if (!workspaceId) {
    return new Response(
      JSON.stringify({ error: "Missing X-Workspace-Id header" }),
      { status: 400, headers: JSON_HEADERS }
    );
  }

  const prefix = `session:${workspaceId}:doc:`;
  const list = await env.DOCUMENT_REGISTRY.list({ prefix });

  const documents = await Promise.all(
    list.keys.map(async (key) => {
      const documentId = key.name.slice(prefix.length);
      const raw = await env.DOCUMENT_REGISTRY.get(key.name);
      const meta = raw ? JSON.parse(raw) : {};
      return {
        documentId,
        title: meta.title || null,
        chunkCount: meta.chunkCount,
        updatedAt: meta.updatedAt,
        sourceUrl: meta.sourceUrl || null,
        // ΝΕΟ: μικρό απόσπασμα του περιεχομένου, ώστε ο editor να αναγνωρίζει
        // το έγγραφο "με το μάτι" στη λίστα, όχι μόνο από τον τίτλο/documentId.
        // Reuse του ήδη υπάρχοντος makePreview() -- τίποτα καινούριο.
        preview: meta.fullText ? makePreview(meta.fullText) : "",
      };
    })
  );

  // Πιο πρόσφατα ενημερωμένα πρώτα -- προεπιλεγμένη ταξινόμηση για το
  // editor dashboard (αυτό που άγγιξες τελευταία είναι το πιο πιθανό
  // να ψάχνεις τώρα).
  documents.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));

  return new Response(
    JSON.stringify({ documents }),
    { headers: JSON_HEADERS }
  );
}

async function handleSearchDocuments(request, env) {
  const workspaceId = request.headers.get("X-Workspace-Id");
  if (!workspaceId) {
    return new Response(
      JSON.stringify({ error: "Missing X-Workspace-Id header" }),
      { status: 400, headers: JSON_HEADERS }
    );
  }

  const body = await request.json();
  const { query } = body;

  if (!query) {
    return new Response(
      JSON.stringify({ error: "query is required" }),
      { status: 400, headers: JSON_HEADERS }
    );
  }

  // Ίδιο search με το /query, αλλά topK μεγαλύτερο -- θέλουμε αρκετά chunks
  // ώστε να καλύψουμε πολλά διαφορετικά έγγραφα, όχι μόνο το κορυφαίο ένα.
  const queryEmbedding = await getEmbedding(query, env.GEMINI_API_KEY);
  const matches = await env.VECTORIZE.query(queryEmbedding, {
    topK: 12,
    namespace: workspaceId,
    returnMetadata: "all",
  });

  if (!matches.matches || matches.matches.length === 0) {
    return new Response(JSON.stringify({ documents: [] }), { headers: JSON_HEADERS });
  }

  // Ομαδοποίηση chunks ανά έγγραφο -- κρατάμε μόνο το καλύτερο score
  // και το καλύτερο απόσπασμα (preview) ανά documentId.
  const byDocument = new Map();
  for (const m of matches.matches) {
    const docId = m.metadata.documentId;
    const existing = byDocument.get(docId);
    if (!existing || m.score > existing.score) {
      byDocument.set(docId, { score: m.score, text: m.metadata.text });
    }
  }

  const docMetaCache = new Map();
  async function getDocMeta(documentId) {
    if (docMetaCache.has(documentId)) return docMetaCache.get(documentId);
    const docKvKey = `session:${workspaceId}:doc:${documentId}`;
    const docRaw = await env.DOCUMENT_REGISTRY.get(docKvKey);
    const meta = docRaw ? JSON.parse(docRaw) : {};
    docMetaCache.set(documentId, meta);
    return meta;
  }

  const grouped = [...byDocument.entries()].sort((a, b) => b[1].score - a[1].score);

  const documents = await Promise.all(
    grouped.slice(0, 5).map(async ([documentId, info]) => {
      const meta = await getDocMeta(documentId);
      return {
        documentId,
        title: meta.title || null,
        score: info.score,
        preview: makePreview(info.text),
      };
    })
  );

  return new Response(JSON.stringify({ documents }), { headers: JSON_HEADERS });
}

async function handleQuery(request, env) {
  const workspaceId = request.headers.get("X-Workspace-Id");
  if (!workspaceId) {
    return new Response(
      JSON.stringify({ error: "Missing X-Workspace-Id header" }),
      { status: 400, headers: JSON_HEADERS }
    );
  }

  const body = await request.json();
  const { question } = body;

  if (!question) {
    return new Response(
      JSON.stringify({ error: "question is required" }),
      { status: 400, headers: JSON_HEADERS }
    );
  }

  // Βήμα 1: embedding της ερώτησης
  const questionEmbedding = await getEmbedding(question, env.GEMINI_API_KEY);

  // Βήμα 2: semantic search στο Vectorize, μόνο μέσα στο σωστό workspace
  const matches = await env.VECTORIZE.query(questionEmbedding, {
    topK: TOP_K,
    namespace: workspaceId,
    returnMetadata: "all",
  });

  if (!matches.matches || matches.matches.length === 0) {
    return new Response(
      JSON.stringify({
        answer: "Δεν βρέθηκαν σχετικά έγγραφα σε αυτόν τον χώρο εργασίας.",
        isFallback: true,
        primarySource: null,
        relatedSections: [],
      }),
      { headers: JSON_HEADERS }
    );
  }

  // Βήμα 3: χτίσε το context από τα πιο σχετικά chunks
  const context = matches.matches
    .map((m) => m.metadata.text)
    .join("\n\n---\n\n");

  // Βήμα 4: ρώτα το Gemini
  const answer = await askGemini(context, question, env.GEMINI_API_KEY);

  // Βήμα 5: εντόπισε αν η απάντηση είναι "δεν γνωρίζω" (fallback)
  const normalizedAnswer = answer.toLowerCase();
  const isFallback =
    normalizedAnswer.includes("δεν γνωρίζω") ||
    normalizedAnswer.includes("δε γνωρίζω");

  // Βήμα 6: ταξινόμηση κατά score (το Vectorize συνήθως το κάνει ήδη, αλλά το εξασφαλίζουμε)
  const sortedMatches = [...matches.matches].sort((a, b) => b.score - a.score);

  // Μικρό cache ώστε να μη διαβάζουμε το ίδιο έγγραφο δύο φορές από το KV
  const docMetaCache = new Map();
  async function getDocMeta(documentId) {
    if (docMetaCache.has(documentId)) return docMetaCache.get(documentId);
    const docKvKey = `session:${workspaceId}:doc:${documentId}`;
    const docRaw = await env.DOCUMENT_REGISTRY.get(docKvKey);
    const meta = docRaw ? JSON.parse(docRaw) : {};
    docMetaCache.set(documentId, meta);
    return meta;
  }

  // Η πιο σχετική πηγή -- αυτή που "κουβαλάει" κυρίως την απάντηση
  const topMatch = sortedMatches[0];

  let primarySource = null;
  if (!isFallback) {
    const docMeta = await getDocMeta(topMatch.metadata.documentId);

    primarySource = {
      documentId: topMatch.metadata.documentId,
      title: docMeta.title || null,
      chunkIndex: topMatch.metadata.chunkIndex,
      score: topMatch.score,
      text: topMatch.metadata.text,
      sourceUrl: docMeta.sourceUrl || null,
    };
  }

  // Οι υπόλοιπες -- σαν "Σχετικές ενότητες" προτάσεις για τον χρήστη
  const relatedSections = isFallback
    ? []
    : await Promise.all(
        sortedMatches.slice(1).map(async (m) => {
          const docMeta = await getDocMeta(m.metadata.documentId);
          return {
            documentId: m.metadata.documentId,
            title: docMeta.title || null,
            chunkIndex: m.metadata.chunkIndex,
            score: m.score,
            preview: makePreview(m.metadata.text),
          };
        })
      );

  return new Response(
    JSON.stringify({ answer, isFallback, primarySource, relatedSections }),
    { headers: JSON_HEADERS }
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({ status: "ok", message: "Operations Portal RAG is alive" }),
        { headers: JSON_HEADERS }
      );
    }

    if (url.pathname === "/upload" && request.method === "POST") {
      return handleUpload(request, env);
    }

    if (url.pathname === "/documents" && request.method === "GET") {
      return handleListDocuments(request, env);
    }

    if (url.pathname.startsWith("/document/") && request.method === "GET") {
      // Safety net: αν το documentId περιέχει κενά ή ειδικούς χαρακτήρες
      // (π.χ. "Verification process" -> "Verification%20process" στο URL),
      // αποκωδικοποιούμε πριν το χρησιμοποιήσουμε ως KV key. Χωρίς αυτό,
      // το lookup αποτυγχάνει σιωπηλά με "Document not found" ακόμα κι όταν
      // το έγγραφο υπάρχει.
      const rawId = url.pathname.split("/document/")[1];
      let documentId = rawId;
      try {
        documentId = decodeURIComponent(rawId);
      } catch (err) {
        // Αν το decode αποτύχει (κατεστραμμένη ακολουθία), προχωράμε με το raw.
      }
      return handleGetDocument(request, env, documentId);
    }

    if (url.pathname === "/search-documents" && request.method === "POST") {
      return handleSearchDocuments(request, env);
    }

    if (url.pathname === "/query" && request.method === "POST") {
      return handleQuery(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
};