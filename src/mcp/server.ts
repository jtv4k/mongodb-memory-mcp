/**
 * MCP server composition root.
 *
 * This module wires four tool modules onto an `McpServer` and does nothing
 * else — no validation, no formatting, no service calls. Business logic lives
 * behind `KnowledgeService`; presentation lives in `./tools/*`. Keeping this
 * file inert is what makes it safe for `http.ts` to construct a fresh server
 * per session (see the note there on why sessions cannot share one instance).
 *
 * The `instructions` string is a real feature, not decoration. Hosts inject it
 * into the model's context once, up front, so it is the only place to explain
 * *policy* — when to store versus when to search, that re-storing is idempotent,
 * that deletion is irreversible. Per-tool descriptions explain a single tool in
 * isolation; instructions explain how the four fit together.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { AppConfig } from '../config/env.js';
import type { Logger } from '../logger.js';
import type { KnowledgeService } from '../services/types.js';
import { registerDeleteContentTool } from './tools/delete-content.js';
import { registerListSourcesTool } from './tools/list-sources.js';
import { installInputRejectionHandler } from './tools/rejections.js';
import { registerSearchKnowledgeTool } from './tools/search-knowledge.js';
import { registerStoreContentTool } from './tools/store-content.js';
import type { ToolDeps } from './tools/shared.js';

/** The complete tool surface. Exported so tests and docs cannot drift from it. */
export const TOOL_NAMES = [
  'store_content',
  'search_knowledge',
  'list_sources',
  'delete_content',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export interface McpServerDeps {
  service: KnowledgeService;
  config: AppConfig;
  logger: Logger;
}

const INSTRUCTIONS = `This server is a persistent, semantically searchable knowledge base backed by MongoDB Vector Search. Treat it as long-term memory that outlives this conversation and is shared with other agents and sessions.

Default workflow:
1. SEARCH FIRST. Before answering anything that touches project-specific material — internal docs, design decisions, API contracts, runbooks, prior investigations — call search_knowledge. Prefer what you retrieve over what you recall, and cite the sourceId of anything you use so a human can verify it.
2. STORE WHAT LASTS. When you produce or discover something a future session would want — a resolved bug and its cause, a decision and its rationale, fetched documentation, an interface contract — call store_content. Store the durable artefact, not the conversation around it.
3. CHECK BEFORE YOU WRITE. Search for an existing document on the topic first. If one exists, re-store it under the SAME sourceId with the improved content rather than creating a near-duplicate; duplicates split the ranking between them and make retrieval worse for everyone.

Things worth knowing:
- store_content is idempotent per sourceId. Re-storing identical content is a no-op that reports outcome "unchanged"; re-storing changed content replaces the old version and bumps the version number. Re-ingesting a whole corpus is therefore safe and cheap.
- Choose sourceIds that a human would recognise and that you could reconstruct later, e.g. "docs/api/authentication" or "adr/0007-hybrid-search". Omitting it derives one from the title or content hash, which is stable but opaque.
- Search returns CHUNKS with their heading path, not whole documents. Several hits from one sourceId means that document is strongly relevant. Use list_sources to see the document-level inventory.
- Hybrid search fuses semantic and keyword ranking, so scores are small and only comparable within a single response.
- Tags are lowercased, deduplicated, and AND-ed when filtering. Keep them broad and few, or filters will match nothing.
- delete_content is irreversible and has no undo. Never use it to update something — store_content with the same sourceId does that atomically. Confirm with a human before deleting by tag.`;

export function createMcpServer(deps: McpServerDeps): McpServer {
  const server = new McpServer(
    { name: deps.config.mcp.serverName, version: deps.config.mcp.serverVersion },
    {
      // Only tools are exposed. Declaring resources/prompts we do not implement
      // would make clients probe for capabilities that answer with an error.
      capabilities: { tools: {} },
      instructions: INSTRUCTIONS,
    },
  );

  const toolDeps: ToolDeps = deps;

  registerStoreContentTool(server, toolDeps);
  registerSearchKnowledgeTool(server, toolDeps);
  registerListSourcesTool(server, toolDeps);
  registerDeleteContentTool(server, toolDeps);

  // After the tools, because it wraps the handler their registration installed.
  installInputRejectionHandler(server, toolDeps);

  return server;
}
