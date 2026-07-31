/**
 * REST mirror of the MCP tools.
 *
 * Same service, same schemas, same validation as the MCP surface — this exists
 * so the knowledge base is usable from `curl`, a cron job or a future client
 * that does not speak MCP, without any of them reimplementing chunking rules.
 * Transports hold no business logic (see `services/types.ts`): each handler
 * coerces, validates, calls one service method, and serialises the result.
 *
 * ## Authentication: every route, reads included
 *
 * `createMcpAuthMiddleware` is mounted on the whole router, not just the
 * mutating verbs. This is a deliberate product decision: the process is
 * network-reachable, and an unauthenticated read surface would hand the entire
 * knowledge base — every ingested document, verbatim — to anyone who can reach
 * the port. Search is not a public endpoint.
 *
 * The consequence is load-bearing for the rest of the app: the server-rendered
 * pages in `web.ts` CANNOT call these routes, because that would require
 * shipping the API token to the browser. They call the `KnowledgeService`
 * in-process instead, which is faster and leaks nothing.
 *
 * ## Query-string coercion
 *
 * Everything in `req.query` is a string (or an array of strings, or a nested
 * object if the client sends `a[b]=c`). The zod schemas are the *domain*
 * contract and are correctly typed as numbers/booleans/arrays, so the coercion
 * happens here, at the edge, and stays out of the schemas. A value that cannot
 * be coerced is passed through unchanged so zod produces the error message
 * rather than this module inventing one.
 */
import { Router } from 'express';
import type { Request, RequestHandler, Response } from 'express';

import type { AppConfig } from '../config/env.js';
import { NotFoundError } from '../errors.js';
import {
  deleteContentSchema,
  listDocumentsSchema,
  listSourcesSchema,
  parseInput,
  searchKnowledgeSchema,
  storeContentSchema,
} from '../domain/schemas.js';
import type { Logger } from '../logger.js';
import { createMcpAuthMiddleware } from '../mcp/auth.js';
import type { KnowledgeService } from '../services/types.js';
import { createRequestContext } from './request-id.js';

export interface ApiDeps {
  config: AppConfig;
  logger: Logger;
  service: KnowledgeService;
}

export function createApiRouter(deps: ApiDeps): Router {
  const { config, logger, service } = deps;
  const router = Router();

  // Applies to every method and every path below, including GETs. See the
  // module docblock — this is the whole reason web.ts talks to the service.
  router.use(createMcpAuthMiddleware(config.mcp, logger));

  const context = (req: Request, res: Response) => createRequestContext(req, res, logger, 'rest');

  router.post(
    '/content',
    route(async (req, res) => {
      const input = parseInput(storeContentSchema, req.body, 'store_content input');
      const result = await service.storeContent(input, context(req, res));
      // 201 only for a genuinely new document; a re-ingest is an update of an
      // existing resource, and 'unchanged' created nothing at all.
      res.status(result.outcome === 'created' ? 201 : 200).json(result);
    }),
  );

  router.get(
    '/search',
    route(async (req, res) => {
      const filters = compact({
        sourceIds: list(req.query.sourceIds ?? req.query.sourceId),
        documentIds: list(req.query.documentIds ?? req.query.documentId),
        tags: list(req.query.tags ?? req.query.tag),
        contentTypes: list(req.query.contentTypes ?? req.query.contentType),
      });

      const input = parseInput(
        searchKnowledgeSchema,
        compact({
          query: text(req.query.q ?? req.query.query),
          limit: integer(req.query.limit),
          mode: text(req.query.mode),
          minScore: decimal(req.query.minScore),
          includeText: boolean(req.query.includeText),
          filters: Object.keys(filters).length > 0 ? filters : undefined,
        }),
        'search_knowledge input',
      );

      res.json(await service.searchKnowledge(input, context(req, res)));
    }),
  );

  router.get(
    '/sources',
    route(async (req, res) => {
      const input = parseInput(
        listSourcesSchema,
        compact({
          limit: integer(req.query.limit),
          offset: integer(req.query.offset),
          tag: text(req.query.tag),
          search: text(req.query.search ?? req.query.q),
          sort: text(req.query.sort),
          order: text(req.query.order),
        }),
        'list_sources input',
      );

      res.json(await service.listSources(input, context(req, res)));
    }),
  );

  router.get(
    '/documents',
    route(async (req, res) => {
      const input = parseInput(
        listDocumentsSchema,
        compact({
          limit: integer(req.query.limit),
          offset: integer(req.query.offset),
          tag: text(req.query.tag),
          search: text(req.query.search ?? req.query.q),
        }),
        'list_documents input',
      );

      res.json(await service.listDocuments(input, context(req, res)));
    }),
  );

  router.get(
    '/documents/:id',
    route(async (req, res) => {
      // `getDocument` accepts an ObjectId hex *or* a sourceId, so the only thing
      // worth rejecting here is an id long enough to be an attack on the index.
      // Express 5 types a param as `string | string[]` (repeated captures); this
      // route has a single named segment, so anything else is not a document id.
      const id = typeof req.params.id === 'string' ? req.params.id : '';
      if (id.length === 0 || id.length > 256) {
        throw new NotFoundError('No document matches that identifier');
      }

      const detail = await service.getDocument(id, context(req, res));
      if (!detail) throw new NotFoundError(`No document with id or sourceId "${id}"`);

      res.json(detail);
    }),
  );

  router.delete(
    '/content',
    route(async (req, res) => {
      // `DELETE` with a body is legal but awkward for curl and for some proxies,
      // so the selector may arrive either way. The body wins when both are sent.
      const body = isRecord(req.body) ? req.body : {};
      const selector =
        Object.keys(body).length > 0
          ? body
          : compact({
              sourceId: text(req.query.sourceId),
              documentId: text(req.query.documentId),
              tags: list(req.query.tags ?? req.query.tag),
            });

      const input = parseInput(deleteContentSchema, selector, 'delete_content input');
      res.json(await service.deleteContent(input, context(req, res)));
    }),
  );

  router.get(
    '/embedding-coverage',
    route(async (req, res) => {
      const coverage = await service.embeddingCoverage(context(req, res));
      res.json({
        configured: {
          provider: config.embedding.provider,
          model: config.embedding.model,
          dimensions: config.embedding.dimensions,
        },
        coverage,
      });
    }),
  );

  return router;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Funnel an async handler's rejection into `next`.
 *
 * Express 5 already forwards rejected promises returned from a handler, but
 * relying on that means the safety of every route depends on nobody ever
 * changing a handler to a non-returning arrow function. This is explicit and
 * uniform, and it costs one closure.
 */
function route(handler: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    handler(req, res).catch(next);
  };
}

/** First usable string for a query value (Express yields arrays for `?a=1&a=2`). */
function text(value: unknown): string | undefined {
  if (typeof value === 'string') return value.length > 0 ? value : undefined;
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === 'string' && entry.length > 0) return entry;
    }
  }
  return undefined;
}

/**
 * `?tags=a,b` and `?tags=a&tags=b` both mean the same list.
 *
 * Comma splitting is safe for every list this API takes: sourceIds, ObjectId
 * hex, tags and content types all forbid commas at the schema level.
 */
function list(value: unknown): string[] | undefined {
  const raw = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const parts = raw
    .filter((entry): entry is string => typeof entry === 'string')
    .flatMap((entry) => entry.split(','))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return parts.length > 0 ? parts : undefined;
}

/** `NaN` on garbage, so zod reports "expected number" instead of us guessing. */
function integer(value: unknown): number | undefined {
  const raw = text(value);
  return raw === undefined ? undefined : Number.parseInt(raw, 10);
}

function decimal(value: unknown): number | undefined {
  const raw = text(value);
  return raw === undefined ? undefined : Number(raw);
}

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const FALSY = new Set(['0', 'false', 'no', 'off']);

/** Unrecognised spellings fall through as the raw string for zod to reject. */
function boolean(value: unknown): boolean | string | undefined {
  const raw = text(value);
  if (raw === undefined) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (TRUTHY.has(normalized)) return true;
  if (FALSY.has(normalized)) return false;
  return raw;
}

/**
 * Drop `undefined` keys before handing the object to zod.
 *
 * `{ limit: undefined }` and `{}` are the same thing to `.optional()`, but not
 * to `.default()`: a present-but-undefined key still takes the default, whereas
 * a `.strict()` object would reject unknown keys we never meant to send.
 */
function compact<T extends Record<string, unknown>>(input: T): Partial<T> {
  const output: Partial<T> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) output[key as keyof T] = value as T[keyof T];
  }
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
