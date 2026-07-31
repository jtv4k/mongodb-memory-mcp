/**
 * The authentication middleware that guards the MCP endpoint and every `/api/*`
 * route.
 *
 * No socket is opened here. The middleware is exercised against a hand-rolled
 * request/response pair that implements exactly the Express surface it touches
 * (`req.get`, `req.ip`, `res.setHeader`, `res.status().json()`), which keeps the
 * suite hermetic and lets `requestIdMiddleware` run first so the correlation id
 * in the 401 body is the real one rather than a stub.
 *
 * Two of these tests are the reason the file exists at all: the token must never
 * appear in the response body, and it must never appear in the log record. A
 * log line is not a private place — it is shipped, indexed and read by people
 * who are not supposed to hold the credential.
 */
import type { Request, RequestHandler, Response } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import { loadConfig, type McpConfig } from '../../src/config/env.js';
import type { Logger } from '../../src/logger.js';
import { createMcpAuthMiddleware } from '../../src/mcp/auth.js';
import { requestIdMiddleware } from '../../src/http/request-id.js';

const TOKEN = 'unit-test-token-0123456789-abcdef';

function mcpConfig(overrides: Record<string, string> = {}): McpConfig {
  return loadConfig({
    MONGODB_URI: 'mongodb://localhost:27017/?directConnection=true',
    MONGODB_DB_NAME: 'rag_kb_test',
    MCP_AUTH_TOKEN: TOKEN,
    EMBEDDING_PROVIDER: 'fake',
    ...overrides,
  }).mcp;
}

// ---------------------------------------------------------------------------
// Recording logger
// ---------------------------------------------------------------------------

interface LogRecord {
  level: string;
  message: string;
  /** Fully expanded, so an `Error` hiding a secret in its message is visible. */
  serialised: string;
}

function serialise(payload: unknown): string {
  return JSON.stringify(payload, (_key, value: unknown) => {
    if (value instanceof Error) {
      return { name: value.name, message: value.message, stack: value.stack };
    }
    return value;
  });
}

function createRecordingLogger(): { logger: Logger; records: LogRecord[] } {
  const records: LogRecord[] = [];
  const at =
    (level: string) =>
    (payload: unknown, message?: string): void => {
      records.push({ level, message: message ?? '', serialised: serialise(payload) ?? '' });
    };
  const logger = {
    fatal: at('fatal'),
    error: at('error'),
    warn: at('warn'),
    info: at('info'),
    debug: at('debug'),
    trace: at('trace'),
    child: () => logger,
  } as unknown as Logger;
  return { logger, records };
}

// ---------------------------------------------------------------------------
// Minimal Express doubles
// ---------------------------------------------------------------------------

interface Exchange {
  req: Request;
  res: Response;
  captured: {
    status: number | undefined;
    body: unknown;
    headers: Record<string, string>;
    nextCalls: number;
    nextError: unknown;
  };
  next: () => void;
}

function createExchange(
  headers: Record<string, string> = {},
  options: { method?: string; path?: string; ip?: string } = {},
): Exchange {
  const lowered = new Map(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );

  const captured: Exchange['captured'] = {
    status: undefined,
    body: undefined,
    headers: {},
    nextCalls: 0,
    nextError: undefined,
  };

  const req = {
    method: options.method ?? 'POST',
    path: options.path ?? '/mcp',
    ip: options.ip ?? '203.0.113.7',
    socket: { remoteAddress: options.ip ?? '203.0.113.7' },
    headers: Object.fromEntries(lowered),
    // Express's own `get` is case-insensitive; nothing else about it matters here.
    get: (name: string): string | undefined => lowered.get(name.toLowerCase()),
  } as unknown as Request;

  const res = {
    setHeader(name: string, value: unknown) {
      captured.headers[name.toLowerCase()] = String(value);
      return res;
    },
    getHeader(name: string) {
      return captured.headers[name.toLowerCase()];
    },
    status(code: number) {
      captured.status = code;
      return res;
    },
    json(payload: unknown) {
      captured.body = payload;
      return res;
    },
  } as unknown as Response;

  const next = (error?: unknown): void => {
    captured.nextCalls += 1;
    if (error !== undefined) captured.nextError = error;
  };

  return { req, res, captured, next };
}

/** Run the request-id middleware first, exactly as the real app mounts it. */
function run(middleware: RequestHandler, exchange: Exchange): void {
  requestIdMiddleware()(exchange.req, exchange.res, () => undefined);
  middleware(exchange.req, exchange.res, exchange.next);
}

interface ErrorBody {
  jsonrpc: string;
  id: null;
  error: { code: number; message: string; data: Record<string, unknown> };
}

function errorBody(exchange: Exchange): ErrorBody {
  return exchange.captured.body as ErrorBody;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let logger: Logger;
let records: LogRecord[];
let middleware: RequestHandler;

beforeEach(() => {
  const recording = createRecordingLogger();
  logger = recording.logger;
  records = recording.records;
  middleware = createMcpAuthMiddleware(mcpConfig(), logger);
});

describe('accepted credentials', () => {
  it('passes a valid Authorization: Bearer token through', () => {
    const exchange = createExchange({ authorization: `Bearer ${TOKEN}` });
    run(middleware, exchange);

    expect(exchange.captured.nextCalls).toBe(1);
    expect(exchange.captured.nextError).toBeUndefined();
    expect(exchange.captured.status).toBeUndefined();
    expect(records).toHaveLength(0);
  });

  it('passes a valid x-api-key through', () => {
    const exchange = createExchange({ 'x-api-key': TOKEN });
    run(middleware, exchange);

    expect(exchange.captured.nextCalls).toBe(1);
    expect(exchange.captured.status).toBeUndefined();
  });

  it('treats the Bearer scheme as case-insensitive, per RFC 7235', () => {
    const exchange = createExchange({ authorization: `bEaReR ${TOKEN}` });
    run(middleware, exchange);

    expect(exchange.captured.nextCalls).toBe(1);
  });

  it('tolerates surrounding whitespace and extra space after the scheme', () => {
    const exchange = createExchange({ authorization: `  Bearer   ${TOKEN}  ` });
    run(middleware, exchange);

    expect(exchange.captured.nextCalls).toBe(1);
  });

  it('accepts a good x-api-key even when a stale Authorization header is also sent', () => {
    const exchange = createExchange({
      authorization: 'Bearer an-old-and-wrong-token-value',
      'x-api-key': TOKEN,
    });
    run(middleware, exchange);

    expect(exchange.captured.nextCalls).toBe(1);
    expect(exchange.captured.status).toBeUndefined();
  });
});

describe('rejected credentials', () => {
  const rejections: Array<[string, Record<string, string>]> = [
    ['no credentials at all', {}],
    ['a wrong bearer token', { authorization: 'Bearer completely-the-wrong-token' }],
    ['a wrong api key', { 'x-api-key': 'completely-the-wrong-token' }],
    ['a non-Bearer scheme', { authorization: `Basic ${TOKEN}` }],
    ['a scheme with no token', { authorization: 'Bearer' }],
    ['an empty bearer token', { authorization: 'Bearer    ' }],
    ['an empty api key', { 'x-api-key': '   ' }],
    ['the token as a raw Authorization value with no scheme', { authorization: TOKEN }],
  ];

  for (const [label, headers] of rejections) {
    it(`answers 401 with a WWW-Authenticate challenge for ${label}`, () => {
      const exchange = createExchange(headers);
      run(middleware, exchange);

      expect(exchange.captured.status).toBe(401);
      expect(exchange.captured.headers['www-authenticate']).toMatch(/^Bearer realm="/);
      // A rejected request must not continue down the stack.
      expect(exchange.captured.nextCalls).toBe(0);
    });
  }

  it('omits the error parameter when nothing was presented, per RFC 6750', () => {
    const exchange = createExchange({});
    run(middleware, exchange);

    expect(exchange.captured.headers['www-authenticate']).toBe('Bearer realm="mongodb-rag-kb"');
    expect(errorBody(exchange).error.data.reason).toBe('missing');
  });

  it('reports invalid_token when a token was presented but did not match', () => {
    const exchange = createExchange({ authorization: 'Bearer wrong' });
    run(middleware, exchange);

    expect(exchange.captured.headers['www-authenticate']).toBe(
      'Bearer realm="mongodb-rag-kb", error="invalid_token"',
    );
    expect(errorBody(exchange).error.data.reason).toBe('invalid');
  });

  it('returns a JSON-RPC shaped body carrying the request id', () => {
    const exchange = createExchange({}, { path: '/api/search', method: 'GET' });
    exchange.req.headers['x-request-id'] = 'req-abcdef123456';
    run(middleware, exchange);

    const body = errorBody(exchange);
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBeNull();
    expect(body.error.code).toBe(-32001);
    expect(body.error.data).toMatchObject({ code: 'E_UNAUTHORIZED', kind: 'auth' });
    // The id comes from the request-id middleware, so a 401 is traceable to a log line.
    expect(typeof body.error.data.requestId).toBe('string');
  });

  it('does not throw when the presented token is a different length from the expected one', () => {
    // A raw `timingSafeEqual` would throw here; hashing first makes both sides 32 bytes.
    for (const token of ['x', 'y'.repeat(10_000), '']) {
      const exchange = createExchange({ 'x-api-key': token });
      expect(() => run(middleware, exchange)).not.toThrow();
      expect(exchange.captured.status).toBe(401);
    }
  });
});

describe('secret hygiene', () => {
  it('never puts the expected token in the response body', () => {
    const attempts: Array<Record<string, string>> = [
      {},
      { authorization: 'Bearer nope' },
      { 'x-api-key': 'nope' },
    ];

    for (const headers of attempts) {
      const exchange = createExchange(headers);
      run(middleware, exchange);

      expect(JSON.stringify(exchange.captured.body)).not.toContain(TOKEN);
      expect(JSON.stringify(exchange.captured.headers)).not.toContain(TOKEN);
    }
  });

  it('never puts the expected or the presented token in a log record', () => {
    const presented = 'a-guess-that-must-not-be-logged';
    const exchange = createExchange({ authorization: `Bearer ${presented}` });
    run(middleware, exchange);

    expect(records).toHaveLength(1);
    for (const record of records) {
      expect(record.serialised).not.toContain(TOKEN);
      expect(record.serialised).not.toContain(presented);
      // Not even a prefix, which would still be a verifier for an offline guess.
      expect(record.serialised).not.toContain(TOKEN.slice(0, 12));
    }
  });

  it('logs the rejection at warn level with the id, source ip and which headers were present', () => {
    const exchange = createExchange(
      { 'x-api-key': 'nope' },
      { ip: '198.51.100.4', path: '/api/x' },
    );
    run(middleware, exchange);

    const record = records[0];
    expect(record?.level).toBe('warn');
    expect(record?.serialised).toContain('auth.rejected');
    expect(record?.serialised).toContain('198.51.100.4');
    expect(record?.serialised).toContain('"presentedApiKey":true');
    expect(record?.serialised).toContain('"presentedAuthorization":false');
    expect(record?.serialised).toContain('/api/x');
  });

  it('strips quotes out of the realm so a server name cannot inject a header parameter', () => {
    const hostile = createMcpAuthMiddleware(
      mcpConfig({ MCP_SERVER_NAME: 'kb", error="none' }),
      logger,
    );
    const exchange = createExchange({});
    run(hostile, exchange);

    expect(exchange.captured.headers['www-authenticate']).toBe('Bearer realm="kb errornone"');
  });
});
