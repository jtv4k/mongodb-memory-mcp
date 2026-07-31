/**
 * `store_content` — the ingestion tool.
 *
 * Two validation passes run before the service is touched. The SDK validates
 * `args` against `z.object(storeContentShape)` for us, but that object has no
 * visibility of the cross-field rules on `storeContentSchema` (overlap smaller
 * than chunk size, content that is non-empty only because of whitespace). The
 * re-parse here is therefore not belt-and-braces: it is the only thing that
 * enforces those rules, and it runs before a single byte reaches MongoDB or the
 * embedding provider.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import {
  parseInput,
  storeContentOutputShape,
  storeContentSchema,
  storeContentShape,
} from '../../domain/schemas.js';
import type { StoreContentResult } from '../../domain/types.js';
import { clip, formatDuration, plural, runTool, toolResult, type ToolDeps } from './shared.js';

const DESCRIPTION = `Store a document in the MongoDB knowledge base so it can be retrieved later with search_knowledge.

Use this when you learn something durable that a future session should be able to find: documentation you fetched, a design decision, an API contract, a debugging write-up, a code file worth remembering. Do NOT use it as a scratchpad for conversational chatter.

How it behaves:
- The content is split with a structure-aware chunker (markdown headings, code fences, JSON elements — driven by contentType), each chunk is embedded, and chunks are stored individually so search returns the relevant passage rather than the whole document.
- Re-storing the same sourceId REPLACES the previous version and bumps its version number. If the content is byte-identical to what is stored, the call is a no-op and returns outcome "unchanged" — so re-ingesting a whole corpus is safe and cheap.
- Omitting sourceId derives a stable one from the title, uri or content hash. Pass an explicit, meaningful sourceId whenever you can: it is the handle you need for delete_content and for filtered searches.

Gotchas:
- tags are lowercased and deduplicated. Search filters on tags are AND, so keep them broad and few.
- metadata must be JSON-serialisable, under 32KB, and no key may start with "$".
- chunkOverlapTokens must be strictly less than chunkSizeTokens when you override both.
- Content is capped at 5,000,000 characters. Split larger material into several documents with distinct sourceIds.`;

export function registerStoreContentTool(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'store_content',
    {
      title: 'Store content in the knowledge base',
      description: DESCRIPTION,
      inputSchema: storeContentShape,
      outputSchema: storeContentOutputShape,
      annotations: {
        readOnlyHint: false,
        // Same content hash under the same sourceId is a genuine no-op, so a
        // retried call after a timeout cannot double-ingest.
        idempotentHint: true,
        // Re-storing a sourceId replaces its chunks, but only ever with a newer
        // generation of the same logical document — nothing else is destroyed.
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (args, extra) =>
      runTool(server, deps, 'store_content', extra, async (ctx) => {
        const input = parseInput(storeContentSchema, args, 'store_content');
        const result = await deps.service.storeContent(input, ctx);
        return toolResult(renderStoreText(result), { ...result });
      }),
  );
}

function renderStoreText(result: StoreContentResult): string {
  const { embedding } = result;
  const identity = `"${clip(result.title, 120)}" (sourceId: ${result.sourceId}, version ${result.version})`;

  if (result.outcome === 'unchanged') {
    return [
      `Unchanged: ${identity}.`,
      `The content hash already matched, so the existing ${plural(result.chunkCount, 'chunk')} and their ${embedding.model} embeddings were kept and nothing was re-embedded.`,
      `documentId: ${result.documentId}`,
    ].join('\n');
  }

  const verb = result.outcome === 'created' ? 'Created' : 'Updated';
  return [
    `${verb}: ${identity}.`,
    `${plural(result.chunkCount, 'chunk')} via the "${result.chunkingStrategy}" strategy, embedded with ${embedding.provider}/${embedding.model} at ${embedding.dimensions} dimensions (${result.totalTokensEmbedded} tokens) in ${formatDuration(result.tookMs)}.`,
    `documentId: ${result.documentId}`,
  ].join('\n');
}
