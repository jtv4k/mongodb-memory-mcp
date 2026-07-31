/**
 * Service-layer barrel.
 *
 * Transports import from here and from `./types.js`, never from the
 * implementation module directly, so the internal file layout of the service can
 * change without touching every caller.
 *
 * `search-fusion` and `highlight` are re-exported because they are pure and
 * useful outside the service: the web views render highlight fragments with
 * `renderFragmentsHtml` (which is also the HTML-escaping boundary for ingested
 * content), and the fusion helpers are exercised directly by unit tests.
 */
export { createKnowledgeService } from './knowledge-service.js';
export * from './search-fusion.js';
export * from './highlight.js';
