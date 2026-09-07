# Operations Portal RAG

An AI-powered document Q&A system for internal operations teams. Upload SOPs, call-center procedures, and internal policies; get a searchable knowledge base with a conversational assistant that answers questions and cites the source document, plus a full CMS for non-technical staff to keep that knowledge current.

**Live demo:** https://operations-portal-rag.giamarigkos.workers.dev

Built as a self-contained portfolio project, but designed to be genuinely usable inside a real ops team, not just a tech demo.

## Why this exists

Internal operations documentation (verification steps, exception handling, compliance notes) usually lives in scattered PDFs, wikis, or tribal knowledge. Agents either can't find the right procedure fast enough, or nobody keeps the docs updated because editing them requires going through IT. This project explores a different shape: a RAG-powered assistant *and* a CMS built for the same non-technical staff who own the content, so the knowledge base can realistically stay current.

## Features

**Public portal**
- Conversational Q&A widget: ask a question in plain language, get an answer grounded in the uploaded documents, with a source reference
- Answers respond in whichever language the question was asked in (Greek or English), independent of the UI language
- Full bilingual UI (English / Greek) with a persistent language toggle
- Anonymous "guest" access with an isolated sandbox workspace, no login required to try it

**Content management (`/editor`)**
- WYSIWYG document editor (TOAST UI Editor): no markdown syntax required from editors
- Draft → Published → Deleted lifecycle: new documents start as private drafts with no embeddings generated until explicitly published
- Soft delete with restore (deleted documents are hidden from the public portal but recoverable)
- Word-level diff view between the current live text and the version being edited
- Auto-generated URL slugs (with Greek-to-Latin transliteration): editors never see or manage IDs
- Instant local filtering across all documents, plus semantic search ("find by description") for locating a document by what it's about rather than its title
- Fallback question log: every question the assistant couldn't answer is captured, surfaced in the editor, and can be dismissed once addressed. This is the feedback loop that tells editors what's missing from the knowledge base

**Multi-tenant workspace isolation**
- Every request is scoped by an `X-Workspace-Id` header, both in the KV document registry and the Vectorize index namespace
- One protected, permanent workspace (used for the demo dataset) with no data expiry
- Any other workspace (anonymous visitors trying the tool) gets a 7-day rolling TTL on every write: automatic cleanup, no cron jobs or background processes involved

## Architecture

```
                 ┌────────────────────┐
  Browser  ───▶  │  Cloudflare Worker  │
 (index /        │  (src/index.js)     │
  editor /       └─────────┬──────────┘
  article)                 │
                            ├──▶ KV (DOCUMENT_REGISTRY)      full document text + metadata (source of truth)
                            ├──▶ Vectorize (operations-portal-rag-index)   embeddings for semantic search, per workspace
                            └──▶ Gemini API                  gemini-embedding-001 for embeddings, gemini-3.6-flash for answer generation
```

Two design decisions worth calling out:

- **Chunking is only ever used to build embeddings.** The full, original document text is stored as-is in KV and is what gets rendered back to a human; chunk boundaries never touch the reconstructed text. Reconstructing prose from chunks destroys paragraph and heading structure, so keeping a single unchunked source of truth avoids that entirely.
- **No background jobs.** Fallback-question logs and visitor-workspace documents both expire via native KV TTL (`expirationTtl`), not a cron job or scheduled worker. Anything that needs cleanup expires itself.

## Tech stack

| Layer | Choice |
|---|---|
| Compute | Cloudflare Workers |
| Vector search | Cloudflare Vectorize (768 dimensions, cosine similarity) |
| Document storage | Cloudflare KV |
| Embeddings | Gemini `gemini-embedding-001` |
| Answer generation | Gemini `gemini-3.6-flash` |
| Editor | TOAST UI Editor (WYSIWYG, markdown output) |
| Markdown rendering | marked.js + DOMPurify |
| Frontend | Vanilla HTML/CSS/JS, no build step |

## API reference

All endpoints except `/health` and `/developer-login` require an `X-Workspace-Id` header.

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Liveness check |
| `POST` | `/developer-login` | Exchange a password for the protected demo workspace ID |
| `POST` | `/upload` | Create a new document (starts as a draft, no embeddings yet) |
| `GET` | `/documents` | List all documents for the current workspace |
| `GET` | `/document/{id}` | Fetch a single document's full text and metadata |
| `POST` | `/document/{id}/publish` | Chunk, embed, and publish a draft |
| `POST` | `/document/{id}/delete` | Soft-delete: removes vectors, keeps the KV record, hides from the public portal |
| `POST` | `/document/{id}/restore` | Restore a deleted document back to draft status |
| `POST` | `/search-documents` | Semantic search across documents by description |
| `POST` | `/query` | Ask a question; returns an answer grounded in the workspace's published documents |
| `GET` | `/fallback-questions` | List questions the assistant couldn't answer |
| `DELETE` | `/fallback-questions/{id}` | Dismiss a fallback question once addressed |

## Getting started locally

**Prerequisites:** a Cloudflare account, [Wrangler](https://developers.cloudflare.com/workers/wrangler/) installed, and a Gemini API key.

```bash
git clone https://github.com/giamarigkos-del/rag-demo-tool.git
cd rag-demo-tool
```

Create the required Cloudflare resources (or reuse existing ones and update `wrangler.toml`):

```bash
npx wrangler kv namespace create DOCUMENT_REGISTRY
npx wrangler vectorize create operations-portal-rag-index --dimensions=768 --metric=cosine
```

Set the required secrets:

```bash
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put DEVELOPER_PASSWORD
```

Run locally or deploy:

```bash
npx wrangler dev          # local development
npx wrangler deploy       # deploy to Cloudflare
```

> Wrangler's KV/Vectorize commands default to a local emulated store. Pass `--remote` to any `wrangler kv` / `wrangler vectorize` command that should touch production data.

## Project structure

```
rag-demo-tool/
├── src/
│   └── index.js          # Worker entry point: all API routes and business logic
├── public/
│   ├── landing.html       # Entry point: developer login or anonymous guest access
│   ├── index.html         # Public document portal + Q&A widget
│   ├── editor.html        # Content management dashboard (CMS)
│   ├── article.html       # Single published document, read-only view
│   ├── shared.css         # Design tokens, shared component styles, i18n toggle
│   └── shared.js          # Shared frontend logic: workspace resolution, i18n, markdown rendering, slugs
└── wrangler.toml
```

## Known limitations

- Single embedding/generation provider (Gemini), no fallback if the API is unavailable
- No user accounts or authentication beyond a single shared developer password for the protected workspace
- No version history: publishing overwrites the previous embedded version (the full text itself is always preserved in KV, but there's no diff-able revision log yet)

## License

No license file is currently published with this repository.