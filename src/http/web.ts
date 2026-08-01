/**
 * The server-rendered web UI.
 *
 * Three pages, no SPA, no client-side build step and — by design — not one byte
 * of JavaScript shipped to the browser. Everything interactive is a plain HTML
 * form whose state round-trips through the query string, so every view is a
 * bookmarkable URL and the whole thing works with scripting disabled.
 *
 * ## Why these handlers call the service directly
 *
 * `/api/*` is authenticated end to end, reads included (see `http/api.ts`).
 * A page that fetched its own API would therefore need the bearer token in the
 * browser, which would put a credential that can rewrite the knowledge base
 * into every rendered response. Instead these handlers call `KnowledgeService`
 * in-process: no round trip, no serialisation, no token anywhere near the
 * client. The token is never written into a page, a cookie, a form field or a
 * header the browser can see.
 *
 * ## Rendering untrusted content
 *
 * Everything on these pages — chunk text, titles, tags, URIs, metadata — is
 * content somebody's AI client uploaded, stored verbatim on purpose and never
 * sanitised on the way in. The templates therefore use `<%= %>` for all of it.
 * The single exception is the highlighted snippet, which is HTML because it
 * carries `<mark>` tags, and which is produced *only* by `renderFragmentsHtml`
 * in `services/highlight.ts` — the module that escapes the text and then emits
 * the tags itself. No template hand-rolls highlighting, and no other value is
 * ever interpolated with `<%- %>` except the `include()` of a sibling template.
 *
 * A strict Content-Security-Policy backs that up rather than replacing it:
 * `default-src 'none'` means an injected `<script>`, image beacon or form post
 * has nowhere to go even if an escaping bug ever slips through.
 *
 * ## Error and empty states are real states
 *
 * A failed search still renders the search page — query box, filters and an
 * explanation — with the failure's HTTP status on the response. Handing a user
 * who mistyped a filter a bare stack-trace page, or a blank page when the
 * vector index is still building, is how a search UI becomes untrustworthy.
 */
import { Router } from 'express';
import type { Request, RequestHandler, Response } from 'express';

import type { AppConfig } from '../config/env.js';
import type { SearchMode } from '../domain/types.js';
import { listDocumentsSchema, parseInput, searchKnowledgeSchema } from '../domain/schemas.js';
import { NotFoundError, toAppError } from '../errors.js';
import { logAppError, type Logger } from '../logger.js';
import { buildHighlightFragments, renderFragmentsHtml } from '../services/highlight.js';
import type { KnowledgeService } from '../services/types.js';

import { createRequestContext, getRequestId } from './request-id.js';

/**
 * No scripts, no frames, no outbound connections, and styles only from this
 * origin. `style-src` is NOT `'unsafe-inline'`: there is no inline `style`
 * attribute or `<style>` block anywhere in the templates, which is also why the
 * relevance bars are `<meter>` elements rather than a div with a width.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "style-src 'self'",
  "img-src 'self' data:",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

/** Page sizes offered in the UI. Kept small; the service clamps anything larger. */
const SEARCH_LIMITS = [10, 25, 50] as const;
const DOCUMENTS_PAGE_SIZE = 20;

const SEARCH_MODES: ReadonlyArray<{ value: '' | SearchMode; label: string }> = [
  { value: '', label: 'Automatic (server default)' },
  { value: 'hybrid', label: 'Hybrid — vector + keyword, rank-fused' },
  { value: 'vector', label: 'Vector — semantic only' },
  { value: 'text', label: 'Text — keyword only' },
];

const MODE_DESCRIPTION: Record<SearchMode, string> = {
  hybrid: 'semantic and keyword results fused with reciprocal rank fusion',
  vector: 'semantic similarity only',
  text: 'MongoDB Search keyword matching only',
};

/** Snippet geometry. Two windows of ~260 chars reads as a paragraph, not a grep. */
const SNIPPET_OPTIONS = { maxFragments: 2, fragmentChars: 260 } as const;

export interface WebDeps {
  config: AppConfig;
  logger: Logger;
  service: KnowledgeService;
}

export function createWebRouter(deps: WebDeps): Router {
  const { config, logger, service } = deps;
  const router = Router();

  const context = (req: Request, res: Response) => createRequestContext(req, res, logger, 'web');

  // Applies to everything that reaches the router, HTML or not — including the
  // error page the 404 handler renders for a mistyped URL.
  router.use((_req, res, next) => {
    res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    // The query string can contain what someone searched for; do not hand it to
    // an external site if a result link is ever clicked.
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  // The knowledge base is a search tool first, so "/" is the search page.
  router.get('/', (_req, res) => {
    res.redirect(302, '/search');
  });

  router.get(
    '/search',
    page(async (req, res) => {
      const form: SearchForm = {
        q: firstString(req.query.q) ?? '',
        mode: asMode(firstString(req.query.mode)),
        tags: firstString(req.query.tags) ?? '',
        limit: clampLimit(firstString(req.query.limit)),
      };

      const base = {
        view: 'search',
        activeNav: 'search',
        form,
        modes: SEARCH_MODES,
        limits: SEARCH_LIMITS,
        hybridEnabled: config.search.hybridEnabled,
      };

      // Empty state: no query yet. Not an error, and not a blank page.
      if (form.q.trim().length === 0) {
        res.render('layout', { ...base, title: 'Search', results: null, searchError: null });
        return;
      }

      const tags = splitTags(form.tags);

      try {
        const input = parseInput(
          searchKnowledgeSchema,
          {
            query: form.q,
            limit: form.limit,
            ...(form.mode === '' ? {} : { mode: form.mode }),
            ...(tags.length > 0 ? { filters: { tags } } : {}),
          },
          'search input',
        );

        const result = await service.searchKnowledge(input, context(req, res));

        res.render('layout', {
          ...base,
          title: `${form.q} — search`,
          results: toResultsView(result),
          searchError: null,
        });
      } catch (error) {
        const appError = toAppError(error, 'search failed');
        logAppError(logger, appError, 'web search failed', {
          requestId: getRequestId(req),
          path: req.path,
        });

        // Status reflects the failure; the page stays usable so the query can be
        // corrected and retried without navigating anywhere.
        res.status(appError.httpStatus).render('layout', {
          ...base,
          title: 'Search — error',
          results: null,
          searchError: appError.toClientPayload(),
        });
      }
    }),
  );

  router.get(
    '/documents',
    page(async (req, res) => {
      const search = firstString(req.query.q) ?? '';
      const tag = firstString(req.query.tag) ?? '';

      const input = parseInput(
        listDocumentsSchema,
        {
          limit: DOCUMENTS_PAGE_SIZE,
          offset: nonNegativeInt(firstString(req.query.offset)),
          ...(search.trim().length > 0 ? { search } : {}),
          ...(tag.trim().length > 0 ? { tag } : {}),
        },
        'document list input',
      );

      const result = await service.listDocuments(input, context(req, res));
      const carry = { q: search, tag };

      res.render('layout', {
        view: 'documents',
        activeNav: 'documents',
        title: 'Documents',
        form: { q: search, tag },
        documents: result.documents.map(toDocumentRow),
        pagination: toPagination('/documents', carry, result.total, result.limit, result.offset),
      });
    }),
  );

  router.get(
    '/documents/:id',
    page(async (req, res) => {
      // Express 5 types a param as `string | string[]`; this route captures one
      // segment, so anything else cannot be a document identifier.
      const id = typeof req.params.id === 'string' ? req.params.id : '';
      if (id.length === 0 || id.length > 256) {
        throw new NotFoundError('No document matches that identifier');
      }

      const detail = await service.getDocument(id, context(req, res));
      if (!detail) throw new NotFoundError(`No document with id or sourceId "${id}"`);

      res.render('layout', {
        view: 'document',
        activeNav: 'documents',
        title: detail.document.title,
        doc: toDocumentView(detail.document),
        chunks: detail.chunks.map(toChunkView),
      });
    }),
  );

  return router;
}

// ---------------------------------------------------------------------------
// View models
//
// Templates stay dumb on purpose: every number is already formatted and every
// URL already built by the time EJS sees it, so a template can only escape and
// place values. Formatting logic in a template is logic nobody unit-tests.
// ---------------------------------------------------------------------------

interface SearchForm {
  q: string;
  mode: '' | SearchMode;
  tags: string;
  limit: number;
}

interface HitView {
  rank: number;
  title: string;
  sourceId: string;
  documentHref: string;
  uri: string | null;
  /** Non-null only for http(s) URIs; a file path or ticket ref is shown as text. */
  uriHref: string | null;
  headingPath: string[];
  contentType: string;
  tags: string[];
  chunkIndex: number;
  score: number;
  scoreLabel: string;
  /** Which search legs found this chunk, as a short human phrase. */
  foundByLabel: string;
  /** PRE-ESCAPED HTML from `renderFragmentsHtml`. The only `<%- %>` on the page. */
  fragmentsHtml: string[];
}

function toResultsView(result: {
  query: string;
  mode: SearchMode;
  effectiveMode: SearchMode;
  totalHits: number;
  tookMs: number;
  embedding: { model: string; dimensions: number };
  hits: ReadonlyArray<{
    chunkId: string;
    documentId: string;
    sourceId: string;
    title: string;
    uri: string | null;
    contentType: string;
    chunkIndex: number;
    headingPath: string[];
    tags: string[];
    text: string;
    score: number;
    vectorRank: number | null;
    textRank: number | null;
    highlights: string[];
  }>;
}) {
  const hits: HitView[] = result.hits.map((hit, index) => {
    // MongoDB Search gives real highlights on the text leg; a vector-only search
    // has none, so the snippet is cut locally from the chunk instead. Either way
    // the fragments are plain text and are escaped by `renderFragmentsHtml`.
    const fragments =
      hit.highlights.length > 0
        ? hit.highlights
        : buildHighlightFragments(hit.text, result.query, SNIPPET_OPTIONS);

    return {
      rank: index + 1,
      title: hit.title,
      sourceId: hit.sourceId,
      documentHref: `/documents/${encodeURIComponent(hit.documentId)}`,
      uri: hit.uri,
      uriHref: httpHref(hit.uri),
      headingPath: hit.headingPath,
      contentType: hit.contentType,
      tags: hit.tags,
      chunkIndex: hit.chunkIndex,
      score: hit.score,
      scoreLabel: formatScore(hit.score),
      foundByLabel: describeLegs(hit.vectorRank, hit.textRank),
      fragmentsHtml: renderFragmentsHtml(fragments, result.query),
    };
  });

  return {
    query: result.query,
    mode: result.mode,
    effectiveMode: result.effectiveMode,
    modeDescription: MODE_DESCRIPTION[result.effectiveMode],
    /** True when the requested strategy could not run and search degraded. */
    degraded: result.effectiveMode !== result.mode,
    totalHits: result.totalHits,
    totalLabel: formatCount(result.totalHits),
    tookLabel: formatDuration(result.tookMs),
    embedding: result.embedding,
    // `<meter max>` needs a scale, and fused RRF scores live around 0.03 while
    // cosine scores live around 0.8 — so the scale is the page's own best hit.
    maxScore: hits.reduce((highest, hit) => Math.max(highest, hit.score), 0) || 1,
    hits,
  };
}

function describeLegs(vectorRank: number | null, textRank: number | null): string {
  if (vectorRank !== null && textRank !== null) {
    return `vector #${vectorRank} · keyword #${textRank}`;
  }
  if (vectorRank !== null) return `vector #${vectorRank}`;
  if (textRank !== null) return `keyword #${textRank}`;
  return 'ranked';
}

function toDocumentRow(row: {
  id: string;
  title: string;
  sourceId: string;
  uri: string | null;
  contentType: string;
  tags: string[];
  contentLength: number;
  version: number;
  excerpt: string;
  chunking: { chunkCount: number };
  updatedAt: Date | string;
}) {
  return {
    id: row.id,
    href: `/documents/${encodeURIComponent(row.id)}`,
    title: row.title,
    sourceId: row.sourceId,
    uri: row.uri,
    uriHref: httpHref(row.uri),
    contentType: row.contentType,
    tags: row.tags,
    chunkCount: row.chunking.chunkCount,
    chunkLabel: `${formatCount(row.chunking.chunkCount)} ${row.chunking.chunkCount === 1 ? 'chunk' : 'chunks'}`,
    sizeLabel: formatChars(row.contentLength),
    version: row.version,
    updatedLabel: formatDateTime(row.updatedAt),
    excerpt: row.excerpt,
  };
}

function toDocumentView(document: {
  id: string;
  title: string;
  sourceId: string;
  uri: string | null;
  contentType: string;
  tags: string[];
  contentLength: number;
  contentHash: string;
  version: number;
  metadata: Record<string, unknown>;
  createdAt: Date | string;
  updatedAt: Date | string;
  chunking: {
    strategy: string;
    chunkSizeTokens: number;
    chunkOverlapTokens: number;
    chunkCount: number;
  };
  embedding: { provider: string; model: string; dimensions: number; contextual: boolean };
  ingest: {
    at: Date | string;
    channel: string;
    agent: string | null;
    sessionId: string | null;
    clientName: string | null;
    clientVersion: string | null;
  };
}) {
  return {
    id: document.id,
    title: document.title,
    sourceId: document.sourceId,
    uri: document.uri,
    uriHref: httpHref(document.uri),
    contentType: document.contentType,
    tags: document.tags,
    version: document.version,
    sizeLabel: formatChars(document.contentLength),
    // First 12 hex characters is plenty to eyeball "did this change?".
    contentHashShort: document.contentHash.slice(0, 12),
    createdLabel: formatDateTime(document.createdAt),
    updatedLabel: formatDateTime(document.updatedAt),
    chunking: document.chunking,
    embedding: document.embedding,
    ingest: {
      channel: document.ingest.channel,
      atLabel: formatDateTime(document.ingest.at),
      agent: document.ingest.agent,
      sessionId: document.ingest.sessionId,
      client: formatClient(document.ingest.clientName, document.ingest.clientVersion),
    },
    metadataJson: formatMetadata(document.metadata),
  };
}

function toChunkView(chunk: {
  id: string;
  chunkIndex: number;
  text: string;
  tokenCount: number;
  charStart: number;
  charEnd: number;
  headingPath: string[];
  embeddingProvider: string;
  embeddingModel: string;
  embeddingDimensions: number;
  embeddedAt: Date | string;
}) {
  return {
    id: chunk.id,
    index: chunk.chunkIndex,
    text: chunk.text,
    tokenLabel: `${formatCount(chunk.tokenCount)} tokens`,
    rangeLabel: `chars ${formatCount(chunk.charStart)}–${formatCount(chunk.charEnd)}`,
    headingPath: chunk.headingPath,
    embeddingLabel: `${chunk.embeddingProvider}/${chunk.embeddingModel} · ${chunk.embeddingDimensions}d`,
    embeddedLabel: formatDateTime(chunk.embeddedAt),
  };
}

function toPagination(
  path: string,
  carry: Record<string, string>,
  total: number,
  limit: number,
  offset: number,
) {
  const pageCount = Math.max(1, Math.ceil(total / limit));
  const current = Math.floor(offset / limit) + 1;

  return {
    total,
    totalLabel: formatCount(total),
    limit,
    offset,
    page: current,
    pageCount,
    from: total === 0 ? 0 : offset + 1,
    to: Math.min(offset + limit, total),
    prevHref: offset > 0 ? hrefFor(path, { ...carry, offset: Math.max(0, offset - limit) }) : null,
    nextHref: offset + limit < total ? hrefFor(path, { ...carry, offset: offset + limit }) : null,
  };
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

/**
 * Route wrapper: a rejected handler reaches the error middleware.
 *
 * Express 5 forwards rejections from a returned promise, but making it explicit
 * means a handler refactored into a non-returning arrow cannot silently start
 * hanging instead of 500ing.
 */
function page(handler: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    handler(req, res).catch(next);
  };
}

function firstString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === 'string') return entry;
    }
  }
  return undefined;
}

function asMode(value: string | undefined): '' | SearchMode {
  return value === 'vector' || value === 'text' || value === 'hybrid' ? value : '';
}

/** Only the offered page sizes are honoured; anything else is the default. */
function clampLimit(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return SEARCH_LIMITS.includes(parsed as (typeof SEARCH_LIMITS)[number])
    ? parsed
    : SEARCH_LIMITS[0];
}

function nonNegativeInt(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function splitTags(value: string): string[] {
  return [
    ...new Set(
      value
        .split(',')
        .map((tag) => tag.trim().toLowerCase())
        .filter((tag) => tag.length > 0),
    ),
  ];
}

function hrefFor(path: string, params: Record<string, string | number>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    const text = String(value);
    if (text.length > 0) search.set(key, text);
  }
  const query = search.toString();
  return query.length > 0 ? `${path}?${query}` : path;
}

/**
 * A clickable href, or null.
 *
 * A `uri` is whatever the ingesting client said it was: a file path, a Jira key,
 * or a `javascript:` payload. Only http(s) becomes a link, and the parse is done
 * with `URL` rather than a regex so no exotic encoding sneaks a scheme past it.
 */
function httpHref(uri: string | null): string | null {
  if (!uri) return null;
  try {
    const parsed = new URL(uri);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function formatClient(name: string | null, version: string | null): string | null {
  if (!name) return null;
  return version ? `${name} ${version}` : name;
}

/** `null` when there is nothing worth showing, so the template can skip the block. */
function formatMetadata(metadata: Record<string, unknown>): string | null {
  if (!metadata || Object.keys(metadata).length === 0) return null;
  try {
    return JSON.stringify(metadata, null, 2);
  } catch {
    return null;
  }
}

/**
 * Four decimals: fused RRF scores cluster around 0.03 and differ in the fourth
 * place, so two decimals would render every result as "0.03".
 */
function formatScore(score: number): string {
  return score.toFixed(4);
}

function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

function formatChars(value: number): string {
  return `${value.toLocaleString('en-US')} chars`;
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

/** UTC to the minute. Timezone-free is the only honest option server-side. */
function formatDateTime(value: Date | string | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
