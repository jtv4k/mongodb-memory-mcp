/**
 * `delete_content` — removal of a document and every chunk that references it.
 *
 * This is the tool where the re-validation in the handler is not a formality.
 * Every field of `deleteContentShape` is optional, so `z.object(shape)` — the
 * only thing the SDK can see — happily accepts `{}` and equally happily accepts
 * all three selectors at once. The "exactly one selector" rule lives in a
 * `.superRefine` on `deleteContentSchema`, and re-parsing with that schema here
 * is the ONLY thing standing between a malformed call and either a no-op that
 * looks like a success or an ambiguous multi-selector delete.
 *
 * The result text names what was actually removed rather than echoing the
 * request, because with a tag selector the caller genuinely does not know in
 * advance which documents it was about to destroy.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import {
  deleteContentOutputShape,
  deleteContentSchema,
  deleteContentShape,
  parseInput,
} from '../../domain/schemas.js';
import type { DeleteContentResult } from '../../domain/types.js';
import type { DeleteContentInput } from '../../domain/schemas.js';
import { inline, plural, runTool, toolResult, type ToolDeps } from './shared.js';

/** Beyond this many, the list of deleted sourceIds is summarised instead. */
const MAX_LISTED_SOURCE_IDS = 25;

const DESCRIPTION = `Permanently delete a document from the knowledge base, along with every chunk and embedding derived from it.

Provide EXACTLY ONE selector:
- sourceId — the normal case. Deletes the single document with that identifier.
- documentId — the 24-character hex ObjectId, when you have it from a search hit.
- tags — deletes every document carrying ALL of the listed tags. This can remove many documents in one call.

Use it to retract content that is wrong, superseded or should never have been stored. Do NOT use it to update a document: calling store_content again with the same sourceId replaces the content and bumps the version in one step, and never leaves a window where the knowledge base has nothing.

Gotchas:
- This is irreversible. There is no undo and no tombstone; the content is gone.
- The tags selector is AND, not OR, and it is exact against lowercased tags. Run list_sources with the same tag first to see exactly what you are about to delete.
- Passing zero selectors, or more than one, is rejected — nothing is deleted.
- Deleting something that does not exist is not an error. The result reports 0 documents deleted, so check that number rather than assuming success.`;

export function registerDeleteContentTool(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'delete_content',
    {
      title: 'Delete content from the knowledge base',
      description: DESCRIPTION,
      inputSchema: deleteContentShape,
      outputSchema: deleteContentOutputShape,
      annotations: {
        readOnlyHint: false,
        // Irreversible data loss. This is the flag a host uses to decide
        // whether to ask a human first, so it must be honest.
        destructiveHint: true,
        // Repeating the call is safe: the second one deletes nothing and
        // reports zero, so a retried timeout cannot cause extra damage.
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args, extra) =>
      runTool(server, deps, 'delete_content', extra, async (ctx) => {
        const input = parseInput(deleteContentSchema, args, 'delete_content');
        const result = await deps.service.deleteContent(input, ctx);
        return toolResult(renderDeleteText(input, result), { ...result });
      }),
  );
}

function renderDeleteText(input: DeleteContentInput, result: DeleteContentResult): string {
  const selector = describeSelector(input);

  if (result.deletedDocuments === 0) {
    return [
      `Nothing deleted: no document matched ${selector}.`,
      'The knowledge base is unchanged. Use list_sources to check the identifier or tag you meant.',
    ].join('\n');
  }

  const lines = [
    `Deleted ${plural(result.deletedDocuments, 'document')} and ${plural(result.deletedChunks, 'chunk')} matching ${selector}. This cannot be undone.`,
  ];

  if (result.sourceIds.length > 0) lines.push(`Removed: ${listSourceIds(result.sourceIds)}`);

  return lines.join('\n');
}

/**
 * Exactly one of these is set — the schema guarantees it before we get here.
 *
 * Everything is flattened with {@link inline} before interpolation. `sourceId`
 * and `documentId` are charset-restricted by their schemas and cannot carry a
 * newline, but `tags` are only length-bounded, so an unneutralised tag could
 * forge extra lines into the sentence a model reads back as confirmation of
 * what it just destroyed.
 */
function describeSelector(input: DeleteContentInput): string {
  if (input.sourceId !== undefined) return `sourceId "${inline(input.sourceId)}"`;
  if (input.documentId !== undefined) return `documentId ${inline(input.documentId)}`;
  if (input.tags !== undefined) return `all of the tags [${inline(input.tags.join(', '))}]`;
  return 'that selector';
}

function listSourceIds(sourceIds: string[]): string {
  if (sourceIds.length <= MAX_LISTED_SOURCE_IDS) return sourceIds.join(', ');
  const shown = sourceIds.slice(0, MAX_LISTED_SOURCE_IDS).join(', ');
  return `${shown}, and ${sourceIds.length - MAX_LISTED_SOURCE_IDS} more`;
}
