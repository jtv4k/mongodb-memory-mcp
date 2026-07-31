/**
 * The MCP tools driven the way a real client drives them: over the real
 * Streamable HTTP transport, through the real Express app, against Atlas Local.
 *
 * The unit suite already exercises tool registration against a fake service with
 * an in-memory transport. What only this file can prove is the whole column
 * standing up together — Express, the bearer-token middleware, session
 * management in `src/mcp/http.ts`, the SDK's own wire format, schema validation,
 * and a `store_content` → `search_knowledge` round trip that really goes through
 * `$vectorSearch`.
 *
 * The client is the SDK's own `Client` + `StreamableHTTPClientTransport`, with
 * the token supplied via `requestInit.headers`. That matters: it means the
 * assertions below cover the SDK's client-side validation of `structuredContent`
 * against each tool's declared `outputSchema` as well (the SDK compiles the
 * schema with Ajv and throws if a payload does not conform), so a tool returning
 * a shape it did not promise fails here without any assertion of ours.
 *
 * Raw `fetch` is used for exactly two things the SDK client cannot express: a
 * request with no credentials at all, and a request that reuses a session id
 * after that session has been deleted.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createApp, type AppBundle } from '../../src/app.js';
import {
  listSourcesOutputShape,
  searchKnowledgeOutputShape,
  storeContentOutputShape,
} from '../../src/domain/schemas.js';
import { TOOL_NAMES } from '../../src/mcp/server.js';
import {
  ATLAS_GUIDE,
  FIXTURE_CHUNK_OVERLAP_TOKENS,
  FIXTURE_CHUNK_SIZE_TOKENS,
  QUERIES,
} from './helpers/fixtures.js';
import { createHarness, type Harness } from './helpers/harness.js';

/** The wire shape of a `tools/call` result, narrowed to what these tests read. */
interface ToolResult {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

const storeContentOutput = z.object(storeContentOutputShape);
const searchKnowledgeOutput = z.object(searchKnowledgeOutputShape);
const listSourcesOutput = z.object(listSourcesOutputShape);

const INITIALIZE_BODY = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'raw-fetch-probe', version: '0.0.0' },
  },
};

let h: Harness;
let bundle: AppBundle;
let server: Server;
let endpoint: string;
let token: string;
let client: Client;

interface ClientSession {
  client: Client;
  transport: StreamableHTTPClientTransport;
}

async function connectClient(name = 'ragkb-integration-client'): Promise<ClientSession> {
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const connected = new Client({ name, version: '1.0.0' });
  await connected.connect(transport);
  return { client: connected, transport };
}

/** Raw JSON-RPC POST, so credentials and session headers can be controlled exactly. */
function rpc(headers: Record<string, string> = {}, body: unknown = INITIALIZE_BODY) {
  return fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // Both are mandatory for Streamable HTTP: the server may answer with JSON
      // or with an SSE stream and picks based on this header.
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function textOf(result: ToolResult): string {
  return (result.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n');
}

async function callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as unknown as ToolResult;
}

/**
 * Call a tool that must be refused. Returns the message the caller was given,
 * whether the SDK surfaced it as an error result or threw a protocol error.
 */
async function callExpectingRejection(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  try {
    const result = await callTool(name, args);
    expect(result.isError, `${name} should have been rejected but succeeded`).toBe(true);
    return textOf(result);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

beforeAll(async () => {
  h = await createHarness();
  token = h.config.mcp.authToken;

  bundle = createApp({
    config: h.config,
    logger: h.logger,
    connection: h.connection,
    embeddings: h.embeddings,
    service: h.service,
  });

  server = await new Promise<Server>((resolve, reject) => {
    const listening = bundle.app.listen(0, '127.0.0.1', () => resolve(listening));
    listening.on('error', reject);
  });

  const address = server.address() as AddressInfo;
  endpoint = `http://127.0.0.1:${address.port}${h.config.mcp.path}`;

  ({ client } = await connectClient());
});

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await bundle?.shutdown().catch(() => undefined);
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await h?.teardown();
});

describe('authentication', () => {
  it('rejects an unauthenticated request with 401 and a challenge', async () => {
    const response = await rpc();
    const body = await response.text();

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toMatch(/^Bearer realm="/u);

    const parsed = JSON.parse(body);
    expect(parsed.jsonrpc).toBe('2.0');
    expect(parsed.error.code).toBeLessThan(0);
    expect(parsed.error.message).toMatch(/authentication required/iu);
    // The rejection must never echo the secret it was comparing against.
    expect(body).not.toContain(token);
  });

  it('rejects a wrong bearer token and a wrong api key', async () => {
    const wrongBearer = await rpc({ authorization: 'Bearer 0000000000000000000000000000000f' });
    expect(wrongBearer.status).toBe(401);
    expect(wrongBearer.headers.get('www-authenticate')).toContain('invalid_token');
    expect(await wrongBearer.text()).not.toContain(token);

    const wrongKey = await rpc({ 'x-api-key': 'nope' });
    expect(wrongKey.status).toBe(401);

    // A valid token under the wrong scheme is still no token.
    const wrongScheme = await rpc({ authorization: `Basic ${token}` });
    expect(wrongScheme.status).toBe(401);
  });

  it('accepts the api-key header as well as the bearer header', async () => {
    const response = await rpc({ 'x-api-key': token });
    expect(response.status).toBe(200);
    // Session established, so clean it up rather than leaking it into shutdown.
    const sessionId = response.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();
    await fetch(endpoint, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}`, 'mcp-session-id': sessionId ?? '' },
    });
  });
});

describe('tools over the real Streamable HTTP transport', () => {
  it('lists exactly the four tools, each with an input schema', async () => {
    const result = await client.listTools();
    const names = result.tools.map((tool) => tool.name).sort();

    expect(names).toEqual([...TOOL_NAMES].sort());

    for (const tool of result.tools) {
      expect(tool.description ?? '').not.toHaveLength(0);
      expect(tool.inputSchema.type).toBe('object');
      expect(Object.keys(tool.inputSchema.properties ?? {}).length).toBeGreaterThan(0);
      expect(tool.outputSchema).toBeDefined();
    }

    const search = result.tools.find((tool) => tool.name === 'search_knowledge');
    expect(Object.keys(search?.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(['query', 'limit', 'mode', 'filters', 'minScore', 'includeText']),
    );
  });

  it('round-trips store_content into search_knowledge against the real index', async () => {
    const stored = await callTool('store_content', {
      content: ATLAS_GUIDE.content,
      title: ATLAS_GUIDE.title,
      sourceId: ATLAS_GUIDE.sourceId,
      uri: ATLAS_GUIDE.uri,
      contentType: 'markdown',
      // Deliberately mixed case and duplicated: the schema must normalise.
      tags: ['MongoDB', 'mongodb', 'Atlas'],
      chunkSizeTokens: FIXTURE_CHUNK_SIZE_TOKENS,
      chunkOverlapTokens: FIXTURE_CHUNK_OVERLAP_TOKENS,
      agent: 'integration-suite',
    });

    expect(stored.isError).toBeFalsy();
    const storedOutput = storeContentOutput.parse(stored.structuredContent);
    expect(storedOutput.sourceId).toBe(ATLAS_GUIDE.sourceId);
    expect(storedOutput.outcome).toBe('created');
    expect(storedOutput.version).toBe(1);
    expect(storedOutput.chunkCount).toBeGreaterThan(1);
    expect(storedOutput.embedding.dimensions).toBe(h.config.embedding.dimensions);
    // The text block is what a model actually reads.
    expect(textOf(stored)).toContain(ATLAS_GUIDE.sourceId);

    const persisted = await h.documents.findOne({ sourceId: ATLAS_GUIDE.sourceId });
    expect(persisted?.tags).toEqual(['mongodb', 'atlas']);
    expect(persisted?.ingest.channel).toBe('mcp');
    expect(persisted?.ingest.agent).toBe('integration-suite');
    // Attribution from the initialize handshake, which stateless mode would lose.
    expect(persisted?.ingest.clientName).toBe('ragkb-integration-client');

    await h.waitForIndexedChunks(ATLAS_GUIDE.sourceId, storedOutput.chunkCount);

    const searched = await callTool('search_knowledge', {
      query: QUERIES.oplog,
      mode: 'vector',
      limit: 5,
    });

    expect(searched.isError).toBeFalsy();
    const searchOutput = searchKnowledgeOutput.parse(searched.structuredContent);
    expect(searchOutput.effectiveMode).toBe('vector');
    expect(searchOutput.hits.length).toBeGreaterThan(0);
    expect(searchOutput.hits.every((hit) => hit.sourceId === ATLAS_GUIDE.sourceId)).toBe(true);
    expect(searchOutput.hits[0]?.vectorScore).not.toBeNull();
    expect(
      searchOutput.hits.some((hit) => hit.headingPath.includes('Replica sets and the oplog')),
    ).toBe(true);

    const rendered = textOf(searched);
    expect(rendered).toContain(ATLAS_GUIDE.sourceId);
    expect(rendered.length).toBeGreaterThan(0);
  });

  it('list_sources returns structured content that matches its declared schema', async () => {
    const result = await callTool('list_sources', { limit: 10 });

    expect(result.isError).toBeFalsy();
    const output = listSourcesOutput.parse(result.structuredContent);
    expect(output.total).toBe(1);
    expect(output.sources[0]?.sourceId).toBe(ATLAS_GUIDE.sourceId);
    // Dates are serialised for the wire, per the declared output shape.
    expect(() => new Date(output.sources[0]?.updatedAt ?? '')).not.toThrow();
    expect(Number.isNaN(Date.parse(output.sources[0]?.updatedAt ?? ''))).toBe(false);
    expect(output.sources[0]?.embeddingModels).toEqual([h.config.embedding.model]);
  });

  it('rejects malformed input before anything reaches the database', async () => {
    const documentsBefore = await h.documents.countDocuments({});
    const chunksBefore = await h.chunks.countDocuments({});

    const messages = [
      // Empty content — caught by the raw shape the SDK itself validates.
      await callExpectingRejection('store_content', { content: '   ', sourceId: 'bad/blank' }),
      // Not a member of the contentType enum.
      await callExpectingRejection('store_content', {
        content: '# ok\n\nsome body text',
        sourceId: 'bad/content-type',
        contentType: 'pdf',
      }),
      // A cross-field rule the SDK cannot see: only the handler's own
      // parseInput(storeContentSchema, ...) catches this one.
      await callExpectingRejection('store_content', {
        content: '# ok\n\nsome body text',
        sourceId: 'bad/overlap',
        chunkSizeTokens: 64,
        chunkOverlapTokens: 64,
      }),
      // Prototype-pollution and operator-injection guard on metadata.
      await callExpectingRejection('store_content', {
        content: '# ok\n\nsome body text',
        sourceId: 'bad/metadata',
        metadata: { $where: 'sleep(1000)' },
      }),
      // delete_content requires exactly one selector: zero and two both fail.
      await callExpectingRejection('delete_content', {}),
      await callExpectingRejection('delete_content', {
        sourceId: ATLAS_GUIDE.sourceId,
        tags: ['mongodb'],
      }),
    ];

    for (const message of messages) {
      expect(message.length).toBeGreaterThan(0);
      // Helpful, but never a stack trace or an internal path.
      expect(message).not.toMatch(/\n\s+at\s/u);
      expect(message).not.toContain('/app/src/');
      expect(message).not.toContain(h.config.mongo.uri);
    }

    expect(await h.documents.countDocuments({})).toBe(documentsBefore);
    expect(await h.chunks.countDocuments({})).toBe(chunksBefore);
    expect(await h.documents.countDocuments({ sourceId: /^bad\// })).toBe(0);
  });

  it('delete_content removes the document and all of its chunks', async () => {
    const result = await callTool('delete_content', { sourceId: ATLAS_GUIDE.sourceId });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      deletedDocuments: 1,
      sourceIds: [ATLAS_GUIDE.sourceId],
    });

    expect(await h.documents.countDocuments({ sourceId: ATLAS_GUIDE.sourceId })).toBe(0);
    expect(await h.chunks.countDocuments({ sourceId: ATLAS_GUIDE.sourceId })).toBe(0);
  });
});

describe('session lifecycle', () => {
  it('rejects an unknown session id with a JSON-RPC 404', async () => {
    const response = await rpc({
      authorization: `Bearer ${token}`,
      'mcp-session-id': '00000000-0000-4000-8000-000000000000',
    });

    expect(response.status).toBe(404);
    const parsed = (await response.json()) as { error: { code: number; message: string } };
    expect(parsed.error.message).toMatch(/unknown or expired/iu);
  });

  it('terminates a session on DELETE and forgets it', async () => {
    const scoped = await connectClient('ragkb-session-probe');
    const sessionId = scoped.transport.sessionId;
    expect(sessionId).toBeTruthy();

    await scoped.transport.terminateSession();

    const afterDelete = await rpc({
      authorization: `Bearer ${token}`,
      'mcp-session-id': sessionId ?? '',
    });
    expect(afterDelete.status).toBe(404);

    await scoped.client.close().catch(() => undefined);
  });
});
