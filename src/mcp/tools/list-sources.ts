/**
 * `list_sources` — the inventory tool.
 *
 * Two things make this module less trivial than it looks.
 *
 * First, serialisation. `SourceSummary` carries real `Date` objects, but
 * `listSourcesOutputShape` declares `createdAt`/`updatedAt` as `z.string()`, and
 * the SDK *validates* `structuredContent` against that shape. A `Date` would
 * fail validation, so the dates are converted to ISO strings explicitly rather
 * than left to `JSON.stringify` to do implicitly at the wire.
 *
 * Second, the text rendering is a fixed-width table on purpose. A model needs to
 * scan an inventory for one row, and aligned columns are both cheaper in tokens
 * and more reliably parsed than the equivalent JSON array.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import {
  listSourcesOutputShape,
  listSourcesSchema,
  listSourcesShape,
  parseInput,
} from '../../domain/schemas.js';
import type { ListSourcesResult, SourceSummary } from '../../domain/types.js';
import {
  clip,
  formatTimestamp,
  plural,
  renderTable,
  runTool,
  toolResult,
  type ToolDeps,
} from './shared.js';

/** Title column budget. Wide enough to disambiguate, narrow enough to align. */
const TITLE_CHARS = 48;
const TAGS_CHARS = 32;

const DESCRIPTION = `List the documents currently in the knowledge base, newest first by default.

Use it to orient yourself before searching or storing: to find out whether a topic has been ingested at all, to recover the exact sourceId you need for a filtered search or for delete_content, and to check how stale a document is.

What you get back is one row per DOCUMENT (not per chunk): its sourceId, title, content type, tag set, chunk count and last-updated time.

When to prefer search_knowledge instead: this tool does substring matching on title, sourceId and uri only — it does NOT look inside the content. "What do we know about retries?" is a search_knowledge question. "Is the retry runbook in here, and what is its sourceId?" is a list_sources question.

Gotchas:
- Paging is offset-based. total tells you how many exist; ask again with a larger offset to walk the rest.
- tag matches exactly against the stored, lowercased tags — it is not a substring match.
- A source showing more than one embedding model is mid-backfill; its search recall will be uneven until a re-embed finishes.`;

export function registerListSourcesTool(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'list_sources',
    {
      title: 'List knowledge base sources',
      description: DESCRIPTION,
      inputSchema: listSourcesShape,
      outputSchema: listSourcesOutputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args, extra) =>
      runTool(server, deps, 'list_sources', extra, async (ctx) => {
        const input = parseInput(listSourcesSchema, args, 'list_sources');
        const result = await deps.service.listSources(input, ctx);
        return toolResult(renderSourcesText(result), toStructured(result));
      }),
  );
}

/** Dates → ISO strings, because the declared output shape says `z.string()`. */
function toStructured(result: ListSourcesResult): Record<string, unknown> {
  return {
    sources: result.sources.map((source) => ({
      ...source,
      createdAt: source.createdAt.toISOString(),
      updatedAt: source.updatedAt.toISOString(),
    })),
    total: result.total,
    limit: result.limit,
    offset: result.offset,
  };
}

function renderSourcesText(result: ListSourcesResult): string {
  if (result.sources.length === 0) {
    return result.total === 0
      ? 'The knowledge base has no documents matching that query. If you expected content here, drop the tag/search filters — or store some with store_content.'
      : `No documents on this page: offset ${result.offset} is past the end of ${plural(result.total, 'match', 'matches')}. Retry with a smaller offset.`;
  }

  const rows = result.sources.map((source) => [
    source.sourceId,
    clip(source.title, TITLE_CHARS),
    source.contentType,
    String(source.chunkCount),
    `v${source.version}`,
    clip(source.tags.join(','), TAGS_CHARS),
    formatTimestamp(source.updatedAt),
  ]);

  const table = renderTable(
    ['SOURCE ID', 'TITLE', 'TYPE', 'CHUNKS', 'VER', 'TAGS', 'UPDATED (UTC)'],
    rows,
  );

  const first = result.offset + 1;
  const last = result.offset + result.sources.length;
  const lines = [`Showing ${first}-${last} of ${plural(result.total, 'source')}.`, '', table];

  if (last < result.total) {
    lines.push('', `More available — call again with offset=${last} for the next page.`);
  }

  const backfilling = result.sources.filter((source) => isMidBackfill(source));
  if (backfilling.length > 0) {
    lines.push(
      '',
      `Note: ${backfilling.map((source) => source.sourceId).join(', ')} carry chunks from more than one embedding model, so their search recall is uneven until a re-embed completes.`,
    );
  }

  return lines.join('\n');
}

function isMidBackfill(source: SourceSummary): boolean {
  return source.embeddingModels.length > 1;
}
