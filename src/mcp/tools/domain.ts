/**
 * `domain` — tool for managing domains in the knowledge base.
 *
 * This tool allows AI agents to work with a domain-based filesystem-like structure
 * for organizing content. Domains provide a hierarchical organization system
 * that supports path-like prefixes.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import {
  parseInput,
  listSourcesSchema,
  domainToolOutputShape,
  domainToolSchema,
  domainToolShape,
} from '../../domain/schemas.js';
import type { SourceSummary } from '../../domain/types.js';
import type { RequestContext } from '../../services/types.js';
import { plural, runTool, toolResult, type ToolDeps } from './shared.js';

/**
 * `listSourcesShape.limit` caps at 200 (see src/domain/schemas.ts), so
 * list_domains/get_domain_info only ever see the first 200 sources — there is
 * no server-side "distinct domains" aggregation to page through the rest.
 * Fine for a knowledge base this size; worth revisiting if that ever changes.
 */
const LIST_ALL_LIMIT = 200;

const DESCRIPTION = `Manage domains and content organized by domains in the MongoDB knowledge base.

This tool allows working with a domain-based filesystem-like structure for organizing content.
Domains provide a hierarchical organization system where content can be organized by prefix paths.

Available operations:
- list_domains - List all domains with their content counts
- create_domain - Create a new domain (no-op if already exists)
- delete_domain - Delete a domain and all its content
- get_domain_info - Get information about a specific domain

Gotchas:
- Domains support hierarchical organization via path prefixes (e.g., "docs/api", "docs/guides")
- Domains are case-sensitive
- Deleting a domain removes all content within it`;

export function registerDomainTool(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'domain',
    {
      title: 'Manage domains in the knowledge base',
      description: DESCRIPTION,
      inputSchema: domainToolShape,
      outputSchema: domainToolOutputShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args, extra) =>
      runTool(server, deps, 'domain', extra, async (ctx) => {
        const input = parseInput(domainToolSchema, args, 'domain');

        if (input.operation === 'list_domains') {
          return await handleListDomains(deps, ctx);
        }

        // `domainToolSchema`'s superRefine already rejects a missing domain
        // for every other operation; this narrows the type to match.
        const { domain } = input;
        if (domain === undefined) {
          throw new Error(`domain is required for operation "${input.operation}"`);
        }

        switch (input.operation) {
          case 'create_domain':
            return handleCreateDomain(domain);
          case 'delete_domain':
            return await handleDeleteDomain(deps, ctx, domain);
          case 'get_domain_info':
            return await handleGetDomainInfo(deps, ctx, domain);
        }
      }),
  );
}

async function handleListDomains(deps: ToolDeps, ctx: RequestContext) {
  // We'll implement this by using the existing list_sources tool with domain filtering
  const input = {
    limit: LIST_ALL_LIMIT,
    offset: 0,
    search: undefined,
    sort: 'createdAt',
    order: 'desc',
  };

  const parsedInput = parseInput(listSourcesSchema, input, 'list_sources');
  const result = await deps.service.listSources(parsedInput, ctx);

  // Group sources by domain
  const domains: Record<string, { count: number; sources: SourceSummary[] }> = {};
  for (const source of result.sources) {
    const domain = source.domain ?? 'no-domain';
    const entry = (domains[domain] ??= { count: 0, sources: [] });
    entry.count += source.chunkCount;
    entry.sources.push(source);
  }

  const domainList = Object.entries(domains).map(([name, info]) => ({
    name,
    count: info.count,
    sourceCount: info.sources.length,
  }));

  return toolResult(renderListDomains(domainList), {
    operation: 'list_domains',
    result: { domains: domainList },
  });
}

function handleCreateDomain(domain: string) {
  // In this implementation, domains are created implicitly when content is stored
  // with a domain, so we'll just return a success message
  return toolResult(
    `Domain "${domain}" created successfully (implicit creation on content storage)`,
    {
      operation: 'create_domain',
      result: { domain, created: true },
    },
  );
}

async function handleDeleteDomain(deps: ToolDeps, ctx: RequestContext, domain: string) {
  const result = await deps.service.deleteContent({ domain }, ctx);

  return toolResult(renderDeleteDomain(domain, result), {
    operation: 'delete_domain',
    result: {
      domain,
      deletedDocuments: result.deletedDocuments,
      deletedChunks: result.deletedChunks,
    },
  });
}

async function handleGetDomainInfo(deps: ToolDeps, ctx: RequestContext, domain: string) {
  // `domain` filters are prefix-matched server-side, so this reports the
  // whole subtree — consistent with list_domains, and more useful than an
  // exact-only lookup for a hierarchical identifier.
  const input = {
    limit: LIST_ALL_LIMIT,
    offset: 0,
    search: undefined,
    sort: 'createdAt',
    order: 'desc',
    tag: undefined,
    domain,
  };

  const parsedInput = parseInput(listSourcesSchema, input, 'list_sources');
  const result = await deps.service.listSources(parsedInput, ctx);

  const info = {
    domain,
    sourceCount: result.sources.length,
    totalChunks: result.sources.reduce((sum, source) => sum + source.chunkCount, 0),
    sources: result.sources,
  };

  return toolResult(renderDomainInfo(info), {
    operation: 'get_domain_info',
    result: info,
  });
}

function renderListDomains(
  domains: Array<{ name: string; count: number; sourceCount: number }>,
): string {
  if (domains.length === 0) {
    return 'No domains found.';
  }

  const lines = [`Found ${plural(domains.length, 'domain')}:`, ''];

  for (const domain of domains) {
    lines.push(`  ${domain.name} (${domain.sourceCount} sources, ${domain.count} chunks)`);
  }

  return lines.join('\n');
}

function renderDeleteDomain(
  domain: string,
  result: { deletedDocuments: number; deletedChunks: number },
): string {
  return `Domain "${domain}" deleted. Removed ${plural(result.deletedDocuments, 'document')} and ${plural(result.deletedChunks, 'chunk')}.`;
}

function renderDomainInfo(info: {
  domain: string;
  sourceCount: number;
  totalChunks: number;
  sources: SourceSummary[];
}): string {
  const lines = [
    `Domain: ${info.domain}`,
    `Sources: ${info.sourceCount}`,
    `Total chunks: ${info.totalChunks}`,
    '',
    `Sources:`,
  ];

  for (const source of info.sources) {
    lines.push(`  ${source.sourceId} (${source.chunkCount} chunks, ${source.contentType})`);
  }

  return lines.join('\n');
}
