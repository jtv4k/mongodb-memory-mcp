/**
 * Shared plumbing for the four MCP tool modules.
 *
 * Every tool needs the same three things and none of them are business logic:
 * a {@link RequestContext} built from the MCP request, a uniform failure path
 * that never lets an exception reach the transport, and a handful of text
 * formatters. Putting them here keeps `server.ts` a pure composition root and
 * stops four near-identical copies of the try/catch from drifting apart.
 *
 * The failure path is the security-relevant part. An `AppError.message` can
 * legitimately quote an upstream response, and a driver error can quote the
 * connection string, so every message handed back to a client goes through
 * {@link redactSecrets} first. Stack traces are structurally impossible to leak
 * because only `.message` is ever read.
 */
import { randomUUID } from 'node:crypto';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from '@modelcontextprotocol/sdk/types.js';

import type { AppConfig } from '../../config/env.js';
import { toAppError, type AppError, type ErrorKind } from '../../errors.js';
import { logAppError, requestLogger, type Logger } from '../../logger.js';
import type { KnowledgeService, RequestContext } from '../../services/types.js';

/** Everything a tool module needs. Identical for all four tools by design. */
export interface ToolDeps {
  service: KnowledgeService;
  config: AppConfig;
  logger: Logger;
}

/** Second argument the SDK hands every tool callback. */
export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** Longest error message we will echo back to a client. */
const MAX_ERROR_CHARS = 1200;

/**
 * What the caller should actually *do* about each class of failure. These are
 * read by a model, so they are instructions, not diagnoses.
 */
const REMEDIATION: Record<ErrorKind, string> = {
  config: 'The server is misconfigured. A human operator has to fix it; retrying will not help.',
  validation: 'Correct the arguments listed above and call the tool again.',
  auth: 'The credentials presented to this server were rejected.',
  not_found: 'Nothing matched the selector you supplied. Use list_sources to see what exists.',
  chunking:
    'The content could not be split into chunks. Check it is real text and not empty or binary.',
  embedding:
    'The embedding provider is unavailable or rate-limited. This is retryable — wait a few seconds and call the tool again with the same arguments.',
  storage: 'The knowledge base is temporarily unavailable. Retry shortly.',
  search: 'The search backend is temporarily unavailable. Retry shortly.',
  index:
    'A required Atlas Search / Vector Search index is missing or still building. A server operator must run `npm run db:indexes`.',
  internal: 'This is a server-side bug. Report the request id below rather than retrying blindly.',
};

/**
 * Strip anything credential-shaped out of text bound for a client.
 *
 * Exact-substring replacement first (cheap, no regex escaping hazards), then a
 * catch-all for connection strings assembled by the driver rather than copied
 * from our config.
 */
export function redactSecrets(text: string, config: AppConfig): string {
  let out = text;
  const secrets = [config.mongo.uri, config.embedding.voyage.apiKey, config.mcp.authToken];
  for (const secret of secrets) {
    if (secret && secret.length >= 8) out = out.split(secret).join('[redacted]');
  }
  return out.replace(/mongodb(\+srv)?:\/\/\S+/gi, '[redacted-mongodb-uri]');
}

/** A successful tool result: prose for the model, structured data for the host. */
export function toolResult(
  text: string,
  structuredContent: Record<string, unknown>,
): CallToolResult {
  return { content: [{ type: 'text', text }], structuredContent };
}

/**
 * A failed tool result. Deliberately `isError` rather than a thrown exception:
 * a tool failure is a normal outcome the model can react to, whereas a throw
 * becomes a protocol-level error the model cannot see the detail of.
 */
export function toolErrorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/** Render an AppError as the message a client sees. Never includes a stack. */
export function formatToolError(
  toolName: string,
  error: AppError,
  requestId: string,
  config: AppConfig,
): string {
  const message = redactSecrets(error.message, config).slice(0, MAX_ERROR_CHARS);
  const lines = [`${toolName} failed [${error.code}]: ${message}`, REMEDIATION[error.kind]];
  if (error.kind !== 'validation') lines.push(`Request id: ${requestId}`);
  return lines.join('\n');
}

/**
 * Wrap a tool body with context creation, timing, logging and the error path.
 *
 * `server` is passed in (rather than just `deps`) purely so client identity can
 * be read at call time — `getClientVersion()` is only populated after the
 * initialize handshake, which happens long after registration.
 */
export async function runTool(
  server: McpServer,
  deps: ToolDeps,
  toolName: string,
  extra: ToolExtra,
  run: (ctx: RequestContext) => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const requestId = randomUUID();
  const client = server.server.getClientVersion();
  const logger = requestLogger(deps.logger, requestId, {
    channel: 'mcp',
    tool: toolName,
    mcpSessionId: extra.sessionId,
    clientName: client?.name,
  });

  const ctx: RequestContext = {
    channel: 'mcp',
    requestId,
    logger,
    clientName: client?.name,
    clientVersion: client?.version,
    sessionId: extra.sessionId,
    signal: extra.signal,
  };

  const startedAt = Date.now();
  try {
    const result = await run(ctx);
    logger.info({ event: 'mcp.tool_succeeded', tookMs: Date.now() - startedAt }, `${toolName} ok`);
    return result;
  } catch (error) {
    const appError = toAppError(error, `${toolName} failed`);
    logAppError(logger, appError, `MCP tool ${toolName} failed`, {
      event: 'mcp.tool_failed',
      tool: toolName,
      tookMs: Date.now() - startedAt,
    });
    return toolErrorResult(formatToolError(toolName, appError, requestId, deps.config));
  }
}

// ---------------------------------------------------------------------------
// Text formatting
// ---------------------------------------------------------------------------

/** Collapse whitespace and clip, so a snippet stays one readable paragraph. */
export function condense(value: string, maxChars: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length <= maxChars ? flat : `${flat.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

/** Clip without collapsing whitespace — for single-line values such as ids. */
export function clip(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

/** `1 chunk` / `4 chunks`, so generated prose does not read like a stack trace. */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** Minute-precision UTC. Seconds add noise a model will never use. */
export function formatTimestamp(value: Date): string {
  return `${value.toISOString().slice(0, 16).replace('T', ' ')}Z`;
}

/**
 * Fixed-width table. Models parse aligned columns far more reliably than they
 * parse a JSON dump, and it costs a fraction of the tokens.
 */
export function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, column) =>
    rows.reduce((widest, row) => Math.max(widest, (row[column] ?? '').length), header.length),
  );

  const renderRow = (cells: string[]): string =>
    cells
      .map((cell, column) => cell.padEnd(widths[column] ?? cell.length))
      .join('  ')
      .trimEnd();

  return [renderRow(headers), ...rows.map(renderRow)].join('\n');
}
