/**
 * Content identity: hashing, source ids and titles.
 *
 * These three derivations are what make `store_content` idempotent, so they live
 * apart from the pipeline as pure functions: an AI client that retries the exact
 * same call must land on the exact same `sourceId` and the exact same hash, and
 * that property has to be testable without a database or an embedding provider.
 */
import { createHash } from 'node:crypto';

/**
 * Longest slug we derive. `sourceIdSchema` allows 256 characters, but a slug is
 * a fallback identifier a human will read in the UI, not a URL to round-trip.
 */
const MAX_SLUG_CHARS = 96;
const MAX_DERIVED_TITLE_CHARS = 200;

/**
 * Only the head of a document is scanned for a title. Sweeping a 5MB blob to
 * discover it has no headings is pure waste — if the title is not in the first
 * few KB, it is not a title.
 */
const TITLE_SCAN_CHARS = 8192;

/** Characters `sourceIdSchema` permits after the first one. */
const SLUG_DISALLOWED = /[^a-z0-9._:@/-]+/gu;
const SLUG_EDGE = /^[^a-z0-9]+|[^a-z0-9]+$/gu;

/** ATX heading, tolerating up to three leading spaces and a closing `###` run. */
const MARKDOWN_HEADING = /^[ \t]{0,3}#{1,6}[ \t]+(\S.*?)[ \t]*#*[ \t]*$/mu;

/**
 * Normalise content for hashing and storage.
 *
 * Line endings only — everything else is the caller's content and must survive
 * verbatim. A document that has been through a Windows editor and back must not
 * look like a new version, and a leading BOM is an encoding artefact rather than
 * a character the author typed.
 */
export function normalizeContent(content: string): string {
  return content.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n');
}

/** sha256 of the normalised content, hex encoded. Safe to call on raw input. */
export function computeContentHash(content: string): string {
  return createHash('sha256').update(normalizeContent(content), 'utf8').digest('hex');
}

/**
 * Reduce arbitrary text to something `sourceIdSchema` accepts.
 *
 * URI-ish input survives largely intact (`:`, `/`, `.`, `-`, `_` and `@` are all
 * legal in a source id), which keeps derived ids recognisable instead of turning
 * `https://example.com/docs/api` into an opaque hash.
 */
export function slugify(value: string): string {
  const slug = value
    .normalize('NFKD')
    .toLowerCase()
    .replace(SLUG_DISALLOWED, '-')
    .replace(/-{2,}/gu, '-')
    .replace(SLUG_EDGE, '')
    .slice(0, MAX_SLUG_CHARS);

  // Slicing mid-string can re-expose a separator at the tail.
  return slug.replace(/[^a-z0-9]+$/u, '');
}

export interface SourceIdInput {
  sourceId?: string | undefined;
  uri?: string | undefined;
  title?: string | undefined;
  /** Hex digest from {@link computeContentHash}; the last-resort identity. */
  contentHash: string;
}

/**
 * Resolve the stable identity for a piece of content.
 *
 * Order matters: an explicit id always wins, then the origin, then the title,
 * then the content itself. The hash fallback means two identical bodies stored
 * without any metadata collapse onto a single document instead of accumulating
 * duplicates — the same reason an explicit caller value is trusted first.
 */
export function deriveSourceId(input: SourceIdInput): string {
  const explicit = input.sourceId?.trim();
  if (explicit) return explicit;

  const fromUri = input.uri ? slugify(input.uri) : '';
  if (fromUri) return fromUri;

  const fromTitle = input.title ? slugify(input.title) : '';
  if (fromTitle) return fromTitle;

  return `sha256:${input.contentHash.slice(0, 16)}`;
}

export interface TitleInput {
  title?: string | undefined;
  content: string;
  /** Final fallback, so a title is never empty. */
  sourceId: string;
}

/** Caller title → first markdown heading → first non-empty line → sourceId. */
export function deriveTitle(input: TitleInput): string {
  const explicit = input.title?.trim();
  if (explicit) return truncateTitle(explicit);

  const head = input.content.slice(0, TITLE_SCAN_CHARS);

  const heading = head.match(MARKDOWN_HEADING)?.[1]?.trim();
  if (heading) return truncateTitle(heading);

  for (const line of head.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return truncateTitle(trimmed);
  }

  return input.sourceId;
}

function truncateTitle(value: string): string {
  const collapsed = value.replace(/\s+/gu, ' ').trim();
  if (collapsed.length <= MAX_DERIVED_TITLE_CHARS) return collapsed;
  return `${collapsed.slice(0, MAX_DERIVED_TITLE_CHARS - 1).trimEnd()}…`;
}
