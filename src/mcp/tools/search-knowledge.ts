/**
 * `search_knowledge` — retrieval over the chunk collection.
 *
 * The interesting decision here is the *text* rendering. A model reads the
 * `content` block, not `structuredContent`, and a JSON dump of ten hits costs
 * several thousand tokens of punctuation while burying the passage that
 * actually answers the question. So the text is a ranked, numbered brief: score
 * and provenance on one line, the passage underneath. `structuredContent`
 * carries the exact same hits losslessly for hosts that want to render them.
 *
 * Every hit's provenance is printed — sourceId, chunk index, heading path —
 * because those are precisely the handles the model needs for a follow-up call
 * (a filtered re-search, or `delete_content`). A hit the model cannot cite is
 * a hit it cannot use.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import {
  parseInput,
  searchKnowledgeOutputShape,
  searchKnowledgeSchema,
  searchKnowledgeShape,
} from '../../domain/schemas.js';
import type { SearchHit, SearchKnowledgeResult } from '../../domain/types.js';
import {
  clip,
  condense,
  formatDuration,
  inline,
  plural,
  runTool,
  toolResult,
  type ToolDeps,
} from './shared.js';

/** Passage budget per hit. Ten hits then cost roughly 1k tokens of prose. */
const SNIPPET_CHARS = 360;

const DESCRIPTION = `Search the MongoDB knowledge base for passages relevant to a question, and get back ranked excerpts with their source attribution.

Reach for this BEFORE answering from memory whenever the question touches project-specific material: internal documentation, prior design decisions, API contracts, runbooks, past debugging sessions. It is also the right first move when you are about to store something, to check whether it is already there.

How to phrase the query:
- Write a natural-language question or a description of the concept, not keywords. The default hybrid mode embeds the query, so "how do we rotate the Voyage API key" retrieves far better than "voyage key rotate".
- Include the distinguishing nouns. Semantic search rewards specificity; a three-word query matches everything and ranks nothing.
- If a first search returns weak hits, rephrase rather than paginate — a different phrasing changes the embedding, a bigger limit does not.

Modes:
- hybrid (default) runs semantic and keyword search and fuses them with reciprocal rank fusion. Best for almost everything.
- vector is semantic only. Use it for conceptual or paraphrased questions where the corpus will not share vocabulary with the query.
- text is MongoDB Search keyword only. Use it when you need an exact identifier — an error code, a function name, a ticket id — that must match literally.

Gotchas:
- Results are CHUNKS, not whole documents. Several hits may come from the same sourceId at different chunk indexes; that usually means the document is highly relevant.
- Hybrid scores come from rank fusion, so they are small (around 0.01-0.03) and are only meaningful relative to each other in the same response. Do not compare them across calls, and do not set minScore against them without looking at a real response first.
- filters are AND-ed, and tag matching is exact against lowercased tags. Over-filtering silently returns nothing; drop filters before concluding the knowledge base is empty.
- Set includeText=false to get ranking and attribution without the passage bodies.`;

export function registerSearchKnowledgeTool(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'search_knowledge',
    {
      title: 'Search the knowledge base',
      description: DESCRIPTION,
      inputSchema: searchKnowledgeShape,
      outputSchema: searchKnowledgeOutputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        // Everything it can reach lives in this deployment's own collections.
        openWorldHint: false,
      },
    },
    async (args, extra) =>
      runTool(server, deps, 'search_knowledge', extra, async (ctx) => {
        const input = parseInput(searchKnowledgeSchema, args, 'search_knowledge');
        const result = await deps.service.searchKnowledge(input, ctx);
        return toolResult(renderSearchText(result), { ...result });
      }),
  );
}

function renderSearchText(result: SearchKnowledgeResult): string {
  const header = renderHeader(result);
  if (result.hits.length === 0) {
    return [
      header,
      '',
      'No passages matched. Before concluding the knowledge base has nothing on this:',
      '  - drop or loosen any filters (they are AND-ed, and tags must match exactly),',
      '  - rephrase the query — a different wording produces a different embedding,',
      '  - or call list_sources to see what has actually been ingested.',
    ].join('\n');
  }

  const blocks = result.hits.map((hit, index) => renderHit(hit, index + 1));
  return [header, '', blocks.join('\n\n')].join('\n');
}

function renderHeader(result: SearchKnowledgeResult): string {
  const parts = [
    `${plural(result.totalHits, 'result')} for "${clip(result.query, 200)}"`,
    `mode: ${describeMode(result)}`,
    `embedding: ${result.embedding.model} @ ${result.embedding.dimensions}d`,
    formatDuration(result.tookMs),
  ];
  return parts.join(' · ');
}

/** Surfaces a silent downgrade — e.g. hybrid falling back when no text index exists. */
function describeMode(result: SearchKnowledgeResult): string {
  return result.effectiveMode === result.mode
    ? result.mode
    : `${result.effectiveMode} (requested ${result.mode}, downgraded — the index for that mode is unavailable)`;
}

function renderHit(hit: SearchHit, position: number): string {
  const lines = [
    `${position}. [score ${formatScore(hit.score)}] ${clip(hit.title, 140)}`,
    `   sourceId: ${hit.sourceId} · chunk ${hit.chunkIndex} · ${hit.contentType}${renderRanks(hit)}`,
  ];

  // Each of these is ingested content joined into a line the model reads
  // structurally, so the join result is flattened rather than trusted: only
  // `sourceId` and `contentType` above are charset-restricted by their schemas.
  if (hit.headingPath.length > 0) {
    lines.push(`   section: ${inline(hit.headingPath.join(' > '))}`);
  }
  if (hit.uri !== null) lines.push(`   uri: ${clip(hit.uri, 200)}`);
  if (hit.tags.length > 0) lines.push(`   tags: ${inline(hit.tags.join(', '))}`);

  const passage = renderPassage(hit);
  if (passage.length > 0) lines.push(`   ${passage}`);

  return lines.join('\n');
}

/**
 * `includeText: false` still leaves the highlight fragments, which are short by
 * construction — so a lightweight response is not a contentless one.
 */
function renderPassage(hit: SearchHit): string {
  if (hit.text.length > 0) return condense(hit.text, SNIPPET_CHARS);
  if (hit.highlights.length > 0) return condense(hit.highlights.join(' … '), SNIPPET_CHARS);
  return '';
}

/** Per-leg ranks make a hybrid result explicable: "found by both" is a strong signal. */
function renderRanks(hit: SearchHit): string {
  const legs: string[] = [];
  if (hit.vectorRank !== null) legs.push(`vector #${hit.vectorRank}`);
  if (hit.textRank !== null) legs.push(`text #${hit.textRank}`);
  return legs.length > 0 ? ` · ${legs.join(', ')}` : '';
}

/**
 * Four decimals: RRF scores cluster around 0.01-0.03, so two would collapse
 * distinct ranks onto the same printed value.
 */
function formatScore(score: number): string {
  return score.toFixed(4);
}
