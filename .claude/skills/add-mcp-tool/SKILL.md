---
name: add-mcp-tool
description: Add a new MCP tool to this server - input and output zod shapes in src/domain/schemas.ts, a module under src/mcp/tools/, registration in src/mcp/server.ts and TOOL_NAMES, the KnowledgeService method, annotations, tests. Use whenever a new capability must be exposed over MCP, or when changing an existing tool's schema or registration.
---

# Adding an MCP tool

A tool is five files, always in this order. Doing them out of order produces a
tool the SDK will not register or, worse, one that skips cross-field validation.

Read `src/mcp/tools/store-content.ts` and `src/mcp/tools/shared.ts` first — they
are the reference implementation, and everything below matches them.

---

## Step 1 — Decide whether the service needs a new method

Transports hold **no** business logic (`src/services/types.ts` says so and means
it). A tool validates input, calls exactly one `KnowledgeService` method, and
formats the result.

If the capability does not already exist on `KnowledgeService`:

1. Add the method to the `KnowledgeService` interface in `src/services/types.ts`,
   signature `(input: XInput, ctx: RequestContext) => Promise<XResult>`.
2. Add `XResult` to `src/domain/types.ts`.
3. Implement it inside `createKnowledgeService()` in
   `src/services/knowledge-service.ts` and add it to the returned object at the
   bottom of the factory.
4. Wrap every MongoDB call in `guarded(logger, 'collection.operation', () => …)` so
   a raw `MongoServerError` never escapes as an unclassified failure.

If the capability _is_ already on the service (`listDocuments`, `getDocument`,
`reembed`, `embeddingCoverage` all exist and are currently only reachable over
REST), skip to step 2.

---

## Step 2 — Add the schemas to `src/domain/schemas.ts`

Three exports per tool, following the file's existing convention exactly:

```ts
// ---------------------------------------------------------------------------
// summarize_source
// ---------------------------------------------------------------------------

export const summarizeSourceShape = {
  sourceId: sourceIdSchema.describe('Source to summarise.'),
  maxChunks: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe('How many leading chunks to include.'),
} satisfies z.ZodRawShape;

export const summarizeSourceSchema = z.object(summarizeSourceShape).superRefine(/* … */);
export type SummarizeSourceInput = z.infer<typeof summarizeSourceSchema>;

export const summarizeSourceOutputShape = {
  sourceId: z.string(),
  title: z.string(),
  chunkCount: z.number().int(),
  updatedAt: z.string(),
} satisfies z.ZodRawShape;
```

Rules that are not optional here:

- **A raw shape, not a `ZodObject`.** `registerTool` takes
  `Record<string, AnySchema>`. `z.object(...)` will not work as `inputSchema`.
- `satisfies z.ZodRawShape` on both shapes, so a typo is a compile error.
- **`.describe()` every field.** Those strings are the entire documentation an
  AI client sees for the argument.
- Reuse the private helpers already in the file (`sourceIdSchema`,
  `objectIdHexSchema`, `tagsSchema`, `metadataSchema`, `contentTypeSchema`)
  rather than re-deriving a regex. They exist because these values end up in
  MongoDB queries, index filters and URLs.
- zod is **v3**. `import { z } from 'zod'`, never `zod/v4`.

### The cross-field validation trap — read this even if you are in a hurry

The SDK validates arguments against `z.object(inputSchema)`. It **cannot see
`.superRefine()`**, because that lives on the schema you built, not on the raw
shape you handed over. So any rule that spans two fields — "overlap must be less
than size", "exactly one selector", "content must contain a non-whitespace
character" — is **not enforced by the SDK at all**.

The handler must therefore re-parse:

```ts
const input = parseInput(summarizeSourceSchema, args, 'summarize_source');
```

Do this in every tool, even ones with no cross-field rules, so the pattern never
has an exception someone can copy from. `parseInput` converts a zod failure into
a `ValidationError`, which is what makes it log at `warn` as a caller fault
instead of `error` as an ingestion fault.

### Output shapes are validated too

Declaring `outputSchema` makes the SDK validate `structuredContent` against it on
every call. A `Date` in your result object against a `z.string()` in the shape is
a runtime failure, not a type error — serialise explicitly
(`value.toISOString()`), the way `listSourcesOutputShape` expects
`createdAt: z.string()`.

---

## Step 3 — Write the tool module

One file per tool: `src/mcp/tools/<kebab-name>.ts`, exporting a single
`register<PascalName>Tool(server, deps)`. Worked skeleton, complete and
compilable:

```ts
/**
 * `summarize_source` — a compact overview of one stored document.
 *
 * Exists so a model can decide whether a source is worth searching in detail
 * without pulling every chunk over the wire. Re-validates with the full schema
 * before touching the service: the SDK cannot see cross-field refinements.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import {
  parseInput,
  summarizeSourceOutputShape,
  summarizeSourceSchema,
  summarizeSourceShape,
} from '../../domain/schemas.js';
import { NotFoundError } from '../../errors.js';
import { clip, plural, renderTable, runTool, toolResult, type ToolDeps } from './shared.js';

const DESCRIPTION = `Summarise one stored source: title, size, tags and its leading chunks.

Use this after list_sources or search_knowledge tells you a source exists and you need to judge
its scope before searching inside it. Do NOT use it to read a whole document — search_knowledge
returns the relevant passage directly and costs far fewer tokens.

Gotchas:
- sourceId must be exact. It is the id returned by store_content and list_sources, not the title.
- maxChunks caps the preview at 50; a large document is not returned in full by design.`;

export function registerSummarizeSourceTool(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'summarize_source',
    {
      title: 'Summarise a stored source',
      description: DESCRIPTION,
      inputSchema: summarizeSourceShape,
      outputSchema: summarizeSourceOutputShape,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (args, extra) =>
      runTool(server, deps, 'summarize_source', extra, async (ctx) => {
        const input = parseInput(summarizeSourceSchema, args, 'summarize_source');

        const detail = await deps.service.getDocument(input.sourceId, ctx);
        if (!detail) throw new NotFoundError(`No source with sourceId "${input.sourceId}"`);

        const structured = {
          sourceId: detail.document.sourceId,
          title: detail.document.title,
          chunkCount: detail.chunks.length,
          // The output shape says z.string(); a Date here fails SDK validation.
          updatedAt: detail.document.updatedAt.toISOString(),
        };

        return toolResult(renderText(detail, input.maxChunks), structured);
      }),
  );
}
```

`runTool` is doing real work for you and must not be bypassed: it mints the
request id, builds the `RequestContext` (channel `'mcp'`, child logger, MCP
client name/version, session id, and `extra.signal` as `ctx.signal` so a
cancelled call cancels the in-flight embedding HTTP request), times the call,
logs success and failure with the right event names, and converts any throw into
an `isError` result whose message has been through `redactSecrets`. A thrown
exception would become a protocol-level error the model cannot inspect; an
`isError` result is something it can react to.

### Annotations, honestly

They are hints to the host about what the tool does. Getting them wrong is worse
than omitting them — a host may auto-approve on the strength of `readOnlyHint`.

| Hint              | Set true when                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| `readOnlyHint`    | The tool cannot modify the knowledge base at all.                                                     |
| `idempotentHint`  | Calling twice with identical arguments has the same effect as once.                                   |
| `destructiveHint` | The tool can remove or overwrite data the caller did not supply in this call.                         |
| `openWorldHint`   | The tool reaches an unbounded external system. False for all tools here — the world is this database. |

The four shipped tools resolve to: `search_knowledge` / `list_sources` read-only
and idempotent; `store_content` idempotent (same hash ⇒ genuine no-op) and
non-destructive (it only ever replaces an older generation of the same logical
document); `delete_content` destructive and idempotent.

### Text plus `structuredContent`, always both

The `text` block is what the model actually reads, so write it for a model, not
for a debugger: a numbered ranked list, an aligned table, a one-line
confirmation. `shared.ts` has `renderTable`, `condense`, `clip`, `plural`,
`formatDuration` and `formatTimestamp` for exactly this. A JSON dump in the text
block wastes tokens and reads worse. `structuredContent` carries the machine-
readable copy and must match `outputSchema` exactly.

### Descriptions are written for a model

Say what the tool does, _when to reach for it_, when **not** to, and the gotchas
that will otherwise cause a failed call. Look at the `DESCRIPTION` constant in
`store-content.ts` for the length and tone that works.

---

## Step 4 — Register it

In `src/mcp/server.ts`:

1. Add the tool name to `TOOL_NAMES` (it is `as const`; the array is the
   canonical list and tests assert against it).
2. Import the register function and call it inside `createMcpServer()` alongside
   the others.

`server.ts` is a composition root. No logic goes in it.

If the capability should also be reachable over REST, add a route to
`src/http/api.ts` using the **same** schema and `parseInput` call, remembering
that query-string values arrive as strings and are coerced by the helpers at the
bottom of that file (`text`, `list`, `integer`, `decimal`, `boolean`, `compact`).

---

## Step 5 — Tests

**Unit — `tests/unit/mcp-tools.test.ts`.** No database, no network. The
`KnowledgeService` is a plain object of `vi.fn()`. Drive the real registration
path through `InMemoryTransport` from
`@modelcontextprotocol/sdk/inMemory.js` plus `Client` from
`@modelcontextprotocol/sdk/client/index.js`, so schema registration, SDK
validation and result shaping are all genuinely exercised.

Cover, at minimum:

- `tools/list` includes the new tool with its input schema.
- A valid call reaches the service with **normalised** arguments (defaults
  applied, tags lowercased and deduped).
- Every invalid call is rejected **before the service is touched** — assert the
  mock was never invoked. Include at least one violation that only the
  `superRefine` catches, which is the whole point of the re-parse.
- A service that throws (`EmbeddingError`, `NotFoundError`) yields
  `isError: true`, a useful message, and no stack trace.
- `structuredContent` validates against the declared `outputSchema` (the SDK
  does this for you — a mis-serialised `Date` will fail the test here).

**Integration — `tests/integration/`.** Real Atlas Local, real indexes, the
deterministic fake embedder, wired up by `helpers/harness.ts`. Add coverage that
the tool works end-to-end against actual stored data, not a mock.

---

## Step 6 — Verify

```bash
./scripts/ndocker.sh npx tsc --noEmit
./scripts/ndocker.sh npx eslint src/mcp/tools/<your-file>.ts src/domain/schemas.ts src/mcp/server.ts
./scripts/ndocker.sh npx vitest run --project unit tests/unit/mcp-tools.test.ts
./scripts/ndocker.sh npm test
```

Then, with Atlas Local up, the integration suite (see `CLAUDE.md` §13 for the
exact `docker run --network host` invocation).

Finally, exercise it through a real client: bring up the dev stack and point an
MCP client at `http://localhost:3000/mcp` with the bearer header. A tool that
passes its unit test but reads badly to a model is not finished.
