/**
 * Secret scrubbing for any text that leaves this process.
 *
 * Scrubbing is a shared boundary concern, so it lives at the root next to
 * `errors.ts` and every transport calls the same implementation — the same
 * `AppError` must never be safe over MCP and leaking over REST.
 *
 * Two passes, cheapest first:
 *
 *  1. Exact-substring replacement of the three secrets we actually hold. No
 *     regex escaping hazards, and it catches a credential quoted verbatim by an
 *     upstream service or by the MongoDB driver.
 *  2. A catch-all for connection strings the driver *assembled* rather than
 *     copied from our config — a retry against a resolved `mongodb+srv` seed
 *     list quotes a URI that never appears in `config.mongo.uri`.
 *
 * The 8-character floor on pass 1 is deliberate: replacing a 3-character
 * "secret" would corrupt ordinary prose without protecting anything.
 *
 * `AppConfig` is imported as a *type only*, so this module has no runtime edge
 * back to `config/env.ts` (which imports `errors.ts`) and cannot create a cycle.
 */
import type { AppConfig } from './config/env.js';

/** Shortest secret worth substituting; below this the replacement is noise. */
const MIN_SECRET_CHARS = 8;

const MONGODB_URI_PATTERN = /mongodb(\+srv)?:\/\/\S+/gi;

/**
 * Strip anything credential-shaped out of text bound for a client or a log.
 *
 * Safe to call on any string, including one that holds no secret at all.
 */
export function redactSecrets(text: string, config: AppConfig): string {
  let out = text;

  const secrets = [config.mongo.uri, config.embedding.voyage.apiKey, config.mcp.authToken];
  for (const secret of secrets) {
    if (secret && secret.length >= MIN_SECRET_CHARS) out = out.split(secret).join('[redacted]');
  }

  return out.replace(MONGODB_URI_PATTERN, '[redacted-mongodb-uri]');
}
