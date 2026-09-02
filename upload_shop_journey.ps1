const CHUNK_SIZE = 300;
const CHUNK_OVERLAP = 30;
const TOP_K = 4;
const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

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

async function handleUpload(request, env) {
  const workspaceId = request.headers.get("X-Workspace-Id");
  if (!workspaceId) {
    return new Response(
      JSON.stringify({ error: "Missing X-Workspace-Id header" }),
      { status: 400, headers: JSON_HEADERS }
    );
  }

  const body = await request.json();
  const { documentId, text, volatility, sourceUrl } = body;

  if (!documentId || !text) {
    return new Response(
      JSON.stringify({ error: "documentId and text are required" }),
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

  await env.DOCUMENT_REGISTRY.put(
    kvKey,
    JSON.stringify({
      chunkCount: chunks.length,
      updatedAt: new Date().toISOString(),
      volatility: volatility || null,
      sourceUrl: sourceUrl || null,
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

  const ids = [];
  for (let i = 0; i < existing.chunkCount; i++) {
    ids.push(`${documentId}-chunk-${i}`);
  }

  const result = await env.VECTORIZE.getByIds(ids);

  const sorted = result.sort((a, b) => a.metadata.chunkIndex - b.metadata.chunkIndex);
  const fullText = sorted.map((v) => v.metadata.text).join(" ");

  return new Response(
    JSON.stringify({
      documentId,
      chunkCount: existing.chunkCount,
      updatedAt: existing.updatedAt,
      sourceUrl: existing.sourceUrl || null,
      text: fullText,
    }),
    { headers: JSON_HEADERS }
  );
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

  function makePreview(text, maxWords = 18) {
    const words = text.trim().split(/\s+/);
    const preview = words.slice(0, maxWords).join(" ");
    return words.length > maxWords ? preview + "…" : preview;
  }

  // Η πιο σχετική πηγή -- αυτή που "κουβαλάει" κυρίως την απάντηση
  const topMatch = sortedMatches[0];

  let primarySource = null;
  if (!isFallback) {
    // Βρες το sourceUrl του εγγράφου από το KV registry, για link προς το πρωτότυπο portal
    const docKvKey = `session:${workspaceId}:doc:${topMatch.metadata.documentId}`;
    const docRaw = await env.DOCUMENT_REGISTRY.get(docKvKey);
    const docMeta = docRaw ? JSON.parse(docRaw) : {};

    primarySource = {
      documentId: topMatch.metadata.documentId,
      chunkIndex: topMatch.metadata.chunkIndex,
      score: topMatch.score,
      text: topMatch.metadata.text,
      sourceUrl: docMeta.sourceUrl || null,
    };
  }

  // Οι υπόλοιπες -- σαν "Σχετικές ενότητες" προτάσεις για τον χρήστη
  const relatedSections = isFallback
    ? []
    : sortedMatches.slice(1).map((m) => ({
        documentId: m.metadata.documentId,
        chunkIndex: m.metadata.chunkIndex,
        score: m.score,
        preview: makePreview(m.metadata.text),
      }));

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

    if (url.pathname.startsWith("/document/") && request.method === "GET") {
      const documentId = url.pathname.split("/document/")[1];
      return handleGetDocument(request, env, documentId);
    }

    if (url.pathname === "/query" && request.method === "POST") {
      return handleQuery(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
};