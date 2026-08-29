/**
 * The external path prefix a reverse proxy mounts this app under.
 *
 * Every self-referential URL the app renders — template hrefs, the `/`
 * redirect, pagination and tab links built in `http/web.ts` — is built by
 * routes mounted at the app's own root (`/search`, `/documents`, …). That is
 * correct only when the app is reachable at the domain root. Behind a reverse
 * proxy that mounts it under a path prefix and strips that prefix before
 * forwarding (e.g. `https://host/kb/` → this process only ever sees
 * `/search`), those links have to be prefixed with `/kb` for the browser's
 * next request to reach the proxy at all. Routing itself never changes: the
 * proxy already removed the prefix, so Express keeps matching `/search` as
 * today. Only the strings this app hands back to the browser need it added.
 *
 * `X-Forwarded-Prefix` is the conventional header a stripping proxy sets to
 * say what it stripped. It is exactly as attacker-controlled as
 * `X-Forwarded-For` when there is no proxy in the way, so it is trusted under
 * the same condition Express's own `trust proxy` setting already encodes:
 * `config.runtime.trustProxy` is `false` (the default) unless an operator has
 * said there is a trusted proxy in front of this process. Reusing that
 * setting means one operator decision governs both headers instead of two.
 *
 * ## Why `res.locals`, not a WeakMap like `request-id.ts`
 *
 * `res.locals` is merged into every `res.render()` automatically, so a
 * template reads `<%= basePath %>` with no route handler having to thread it
 * into the render payload. Server-side string building (the `/` redirect,
 * `hrefFor` calls) reads the same value back through {@link getBasePath}.
 */
import type { RequestHandler, Response } from 'express';

const FORWARDED_PREFIX_HEADER = 'x-forwarded-prefix';

/**
 * `/`, then one or more `/segment` groups of unreserved URL characters, or
 * empty. No trailing slash, no `..`, no scheme or host. This is deliberately
 * strict: the value is interpolated into an `href`/`action` attribute and
 * into a redirect `Location`, so anything looser is a header-driven HTML
 * injection or open-redirect primitive (`X-Forwarded-Prefix: //evil.com`
 * would otherwise turn every relative link into one pointing off-site).
 */
const SAFE_BASE_PATH = /^(\/(?!\.{1,2}(?:\/|$))[A-Za-z0-9._~-]+)*$/u;

/**
 * Resolves `res.locals.basePath` for every request, trusted or not, so it is
 * always a string by the time any handler or template reads it.
 *
 * Mounted globally (not scoped to the web router) because the terminal error
 * handler can render `error.ejs` for a request that never reached the web
 * router at all — a mistyped path with no matching route anywhere.
 */
export function basePathMiddleware(trustProxy: boolean | number | string): RequestHandler {
  const trusted = trustProxy !== false;

  return (req, res, next) => {
    res.locals.basePath = trusted ? resolveBasePath(req.get(FORWARDED_PREFIX_HEADER)) : '';
    next();
  };
}

/** `''` for anything absent, disabled, or malformed — the same fail-safe posture as `isSafeRequestId`. */
function resolveBasePath(value: string | undefined): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim().replace(/\/+$/u, '');
  return SAFE_BASE_PATH.test(trimmed) ? trimmed : '';
}

/** The resolved base path for this request, or `''` if `basePathMiddleware` never ran. */
export function getBasePath(res: Response): string {
  return typeof res.locals.basePath === 'string' ? res.locals.basePath : '';
}
