/**
 * Zod schemas for every externally-supplied payload.
 *
 * Content arriving from an AI client is UNTRUSTED. Nothing in this file may be
 * bypassed: MCP tools, the REST API and the web forms all validate through here
 * before a single byte reaches MongoDB or the embedding provider.
 *
 * Each entry exports three things:
 *   - `xxxShape`  — a raw zod shape, handed straight to `McpServer.registerTool`
 *                   as `inputSchema` / `outputSchema` (the SDK wants a shape,
 *                   not a ZodObject).
 *   - `xxxSchema` — `z.object(shape)` plus any cross-field refinements.
 *   - the inferred TypeScript type.
 *
 * Because the SDK validates against `z.object(shape)` it cannot see cross-field
 * refinements, so handlers re-validate with `xxxSchema` via {@link parseInput}.
 */
import { z } from 'zod';

import { ValidationError } from '../errors.js';
import { CONTENT_TYPES } from './types.js';

/** Largest single document we accept, in characters (~5MB of UTF-8 text). */
export const MAX_CONTENT_CHARS = 5_000_000;
export const MAX_METADATA_JSON_CHARS = 32_768;

const PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const contentTypeSchema = z.enum(CONTENT_TYPES);

/**
 * A caller-supplied identifier. Deliberately narrow: this value ends up in
 * Mongo queries, index filters and URLs.
 */
const sourceIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:@\-/]*$/,
    'must start alphanumeric and contain only letters, digits, and . _ : @ - /',
  );

const objectIdHexSchema = z
  .string()
  .trim()
  .regex(/^[0-9a-fA-F]{24}$/, 'must be a 24-character hex ObjectId');

/** Tags are normalised (trim + lowercase + dedupe) so filters behave predictably. */
const tagsSchema = z
  .array(z.string().trim().min(1).max(64))
  .max(50, 'at most 50 tags')
  .default([])
  .transform((tags) => [...new Set(tags.map((tag) => tag.toLowerCase()))]);

/**
 * Deepest nesting metadata may carry.
 *
 * A limit is needed independently of the key rules: a deeply nested object is a
 * denial-of-service vector against every recursive consumer downstream — this
 * validator, `JSON.stringify`, BSON serialisation (which has its own 100-level
 * ceiling and errors far less legibly), and any future walk of the value.
 */
const MAX_METADATA_DEPTH = 16;

/**
 * Reject `__proto__`/`constructor`/`prototype` and `$`-prefixed keys at EVERY
 * level, not just the top one.
 *
 * The original check only walked `Object.keys(value)`, so `{ a: { $ne: 1 } }`
 * and `{ a: { __proto__: … } }` both sailed through. Neither is exploitable
 * today — `JSON.parse` makes `__proto__` an ordinary own property rather than
 * a setter call, and metadata is only ever stored, never spread into a filter
 * or an update document — so this is closing the gap between what the guard
 * claimed and what it did, before some later caller makes the assumption real.
 *
 * Issues are accumulated rather than thrown, so one call reports every bad key.
 */
function checkMetadataValue(
  value: unknown,
  ctx: z.RefinementCtx,
  path: string,
  depth: number,
): void {
  if (depth > MAX_METADATA_DEPTH) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `"${path}" nests deeper than the ${MAX_METADATA_DEPTH} level limit`,
    });
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      checkMetadataValue(entry, ctx, `${path}[${index}]`, depth + 1);
    });
    return;
  }

  if (typeof value !== 'object' || value === null) return;

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const where = path.length > 0 ? `${path}.${key}` : key;

    if (PROTO_KEYS.has(key)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `disallowed key "${where}"` });
    }
    if (key.startsWith('$')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `key "${where}" may not start with $` });
    }

    checkMetadataValue(entry, ctx, where, depth + 1);
  }
}

/**
 * Free-form metadata. Guarded against prototype pollution and unbounded size —
 * this object is persisted verbatim.
 */
const metadataSchema = z
  .record(z.unknown())
  .default({})
  .superRefine((value, ctx) => {
    checkMetadataValue(value, ctx, '', 0);

    let serialized: string;
    try {
      serialized = JSON.stringify(value) ?? '';
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be JSON-serialisable' });
      return;
    }
    if (serialized.length > MAX_METADATA_JSON_CHARS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `serialised metadata must be <= ${MAX_METADATA_JSON_CHARS} characters`,
      });
    }
  });

const uriSchema = z.string().trim().min(1).max(2048).optional();

// ---------------------------------------------------------------------------
// store_content
// ---------------------------------------------------------------------------

export const storeContentShape = {
  content: z
    .string()
    .min(1, 'content must not be empty')
    .max(MAX_CONTENT_CHARS, `content must be <= ${MAX_CONTENT_CHARS} characters`)
    .describe('Raw content to ingest. Markdown structure is respected when chunking.'),
  title: z
    .string()
    .trim()
    .min(1)
    .max(512)
    .optional()
    .describe('Human-readable title. Derived from the first heading or sourceId if omitted.'),
  sourceId: sourceIdSchema
    .optional()
    .describe(
      'Stable identifier for this content. Re-storing the same sourceId replaces it and bumps its version. Derived from title/uri/content hash if omitted.',
    ),
  uri: uriSchema.describe('Origin of the content: URL, file path, ticket reference, etc.'),
  contentType: contentTypeSchema
    .default('markdown')
    .describe('Drives which structure-aware chunking strategy runs.'),
  tags: tagsSchema.describe('Lowercased, deduplicated labels used to filter searches.'),
  metadata: metadataSchema.describe('Arbitrary JSON metadata stored alongside the document.'),
  agent: z
    .string()
    .trim()
    .max(128)
    .optional()
    .describe('Name of the AI agent supplying the content.'),
  sessionId: z.string().trim().max(128).optional().describe('Ingesting session identifier.'),
  chunkSizeTokens: z
    .number()
    .int()
    .min(32)
    .max(8192)
    .optional()
    .describe('Override the configured chunk size for this document only.'),
  chunkOverlapTokens: z
    .number()
    .int()
    .min(0)
    .max(4096)
    .optional()
    .describe('Override the configured chunk overlap for this document only.'),
} satisfies z.ZodRawShape;

export const storeContentSchema = z.object(storeContentShape).superRefine((input, ctx) => {
  if (
    input.chunkOverlapTokens !== undefined &&
    input.chunkSizeTokens !== undefined &&
    input.chunkOverlapTokens >= input.chunkSizeTokens
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['chunkOverlapTokens'],
      message: 'must be less than chunkSizeTokens',
    });
  }
  if (input.content.trim().length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['content'],
      message: 'must contain at least one non-whitespace character',
    });
  }
});

export type StoreContentInput = z.infer<typeof storeContentSchema>;

export const storeContentOutputShape = {
  documentId: z.string(),
  sourceId: z.string(),
  title: z.string(),
  version: z.number().int(),
  chunkCount: z.number().int(),
  outcome: z.enum(['created', 'updated', 'unchanged']),
  chunkingStrategy: z.string(),
  embedding: z.object({
    provider: z.string(),
    model: z.string(),
    dimensions: z.number().int(),
  }),
  totalTokensEmbedded: z.number().int(),
  tookMs: z.number(),
} satisfies z.ZodRawShape;

// ---------------------------------------------------------------------------
// search_knowledge
// ---------------------------------------------------------------------------

export const searchFiltersSchema = z
  .object({
    sourceIds: z.array(sourceIdSchema).max(100).optional(),
    documentIds: z.array(objectIdHexSchema).max(100).optional(),
    tags: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
    contentTypes: z.array(contentTypeSchema).max(CONTENT_TYPES.length).optional(),
  })
  .strict()
  .optional();

export type SearchFilters = z.infer<typeof searchFiltersSchema>;

export const searchKnowledgeShape = {
  query: z
    .string()
    .trim()
    .min(1, 'query must not be empty')
    .max(4000)
    .describe('Natural-language search query.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe('Maximum hits to return. Clamped to SEARCH_MAX_LIMIT.'),
  mode: z
    .enum(['vector', 'text', 'hybrid'])
    .optional()
    .describe(
      'vector = semantic only, text = Atlas Search keyword only, hybrid = both fused with reciprocal rank fusion. Defaults to the configured mode.',
    ),
  filters: searchFiltersSchema.describe('Restrict the search to matching chunks.'),
  minScore: z
    .number()
    .min(0)
    .optional()
    .describe('Drop hits scoring below this threshold after ranking.'),
  includeText: z
    .boolean()
    .default(true)
    .describe('Include full chunk text in results. Set false for a lighter response.'),
} satisfies z.ZodRawShape;

export const searchKnowledgeSchema = z.object(searchKnowledgeShape);
export type SearchKnowledgeInput = z.infer<typeof searchKnowledgeSchema>;

export const searchHitOutputSchema = z.object({
  chunkId: z.string(),
  documentId: z.string(),
  sourceId: z.string(),
  title: z.string(),
  uri: z.string().nullable(),
  contentType: contentTypeSchema,
  chunkIndex: z.number().int(),
  headingPath: z.array(z.string()),
  tags: z.array(z.string()),
  text: z.string(),
  score: z.number(),
  vectorScore: z.number().nullable(),
  textScore: z.number().nullable(),
  vectorRank: z.number().int().nullable(),
  textRank: z.number().int().nullable(),
  highlights: z.array(z.string()),
});

export const searchKnowledgeOutputShape = {
  query: z.string(),
  mode: z.enum(['vector', 'text', 'hybrid']),
  effectiveMode: z.enum(['vector', 'text', 'hybrid']),
  totalHits: z.number().int(),
  hits: z.array(searchHitOutputSchema),
  tookMs: z.number(),
  embedding: z.object({ model: z.string(), dimensions: z.number().int() }),
} satisfies z.ZodRawShape;

// ---------------------------------------------------------------------------
// list_sources
// ---------------------------------------------------------------------------

export const listSourcesShape = {
  limit: z.number().int().min(1).max(200).default(50).describe('Page size.'),
  offset: z.number().int().min(0).default(0).describe('Number of sources to skip.'),
  tag: z.string().trim().min(1).max(64).optional().describe('Only sources carrying this tag.'),
  search: z
    .string()
    .trim()
    .min(1)
    .max(256)
    .optional()
    .describe('Case-insensitive substring match on title, sourceId or uri.'),
  sort: z
    .enum(['updatedAt', 'createdAt', 'title', 'chunkCount'])
    .default('updatedAt')
    .describe('Sort field.'),
  order: z.enum(['asc', 'desc']).default('desc').describe('Sort direction.'),
} satisfies z.ZodRawShape;

export const listSourcesSchema = z.object(listSourcesShape);
export type ListSourcesInput = z.infer<typeof listSourcesSchema>;

export const sourceSummaryOutputSchema = z.object({
  sourceId: z.string(),
  title: z.string(),
  uri: z.string().nullable(),
  contentType: contentTypeSchema,
  tags: z.array(z.string()),
  chunkCount: z.number().int(),
  contentLength: z.number().int(),
  version: z.number().int(),
  embeddingModels: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const listSourcesOutputShape = {
  sources: z.array(sourceSummaryOutputSchema),
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
} satisfies z.ZodRawShape;

// ---------------------------------------------------------------------------
// delete_content
// ---------------------------------------------------------------------------

export const deleteContentShape = {
  sourceId: sourceIdSchema.optional().describe('Delete the document with this sourceId.'),
  documentId: objectIdHexSchema.optional().describe('Delete the document with this ObjectId.'),
  tags: z
    .array(z.string().trim().min(1).max(64))
    .min(1)
    .max(50)
    .optional()
    .describe(
      'Delete EVERY document carrying ALL of these tags. This is a bulk delete with no undo — prefer sourceId or documentId unless you genuinely mean to remove a whole tagged set.',
    ),
} satisfies z.ZodRawShape;

export const deleteContentSchema = z.object(deleteContentShape).superRefine((input, ctx) => {
  const selectors = [input.sourceId, input.documentId, input.tags].filter(
    (value) => value !== undefined,
  );
  if (selectors.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'provide exactly one of sourceId, documentId or tags',
    });
  }
  if (selectors.length > 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'provide only ONE of sourceId, documentId or tags',
    });
  }
});

export type DeleteContentInput = z.infer<typeof deleteContentSchema>;

export const deleteContentOutputShape = {
  deletedDocuments: z.number().int(),
  deletedChunks: z.number().int(),
  sourceIds: z.array(z.string()),
} satisfies z.ZodRawShape;

// ---------------------------------------------------------------------------
// Internal / web + CLI payloads
// ---------------------------------------------------------------------------

export const listDocumentsSchema = z.object({
  limit: z.number().int().min(1).max(200).default(25),
  offset: z.number().int().min(0).default(0),
  tag: z.string().trim().min(1).max(64).optional(),
  search: z.string().trim().min(1).max(256).optional(),
});
export type ListDocumentsInput = z.infer<typeof listDocumentsSchema>;

export const reembedSchema = z.object({
  /** Only re-embed chunks NOT already on the target model/dimensions. */
  targetModel: z.string().trim().min(1).optional(),
  targetDimensions: z.number().int().min(1).max(4096).optional(),
  sourceIds: z.array(sourceIdSchema).max(1000).optional(),
  /** Cap the number of documents touched in one run, for incremental backfills. */
  maxDocuments: z.number().int().min(1).max(100_000).optional(),
  dryRun: z.boolean().default(false),
});
export type ReembedInput = z.infer<typeof reembedSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse untrusted input, converting any zod failure into a {@link ValidationError}
 * so it is logged as a caller fault rather than an ingestion fault.
 */
export function parseInput<T extends z.ZodTypeAny>(
  schema: T,
  input: unknown,
  label: string,
): z.infer<T> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;

  const issues = result.error.issues.map((issue) => ({
    path: issue.path.join('.') || '(root)',
    message: issue.message,
  }));

  throw new ValidationError(
    `Invalid ${label}: ${issues.map((i) => `${i.path} ${i.message}`).join('; ')}`,
    { details: { label, issues } },
  );
}
