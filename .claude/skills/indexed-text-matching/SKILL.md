---
name: indexed-text-matching
description: How to match strings case-insensitively or by substring without leaving the index — why a case-insensitive $regex can never use one, the keywordLowercase wildcard recipe behind browse search, token vs string mappings, sorting and counting inside $search, and what eventual consistency does to tests. Use whenever adding or changing any text filter, substring search, case-insensitive comparison or lookup over string fields, whenever a $regex appears in a query or a review, and whenever a list or browse query is suspected of scanning.
---

# Indexed text matching

Every text-matching decision in this repository is downstream of three facts
about MongoDB indexes. Get these wrong and the query works — correctly, even —
while silently scanning the collection on every call.

## The three disqualifying facts

1. **A case-insensitive `$regex` can never use an index.** Case folding
   defeats b-tree bounds even when the pattern is anchored: `/^abc/i` scans.
   The index stores `Abc` and `abc` in different places, and the regex engine
   cannot ask for both ranges.
2. **An unanchored `$regex` cannot use index bounds either**, case-sensitive
   or not. `/abc/` reads every key (a full index scan at best, a collection
   scan when the filtered fields are not covered).
3. **A collation index does not rescue a regex.** `$regex` only uses an index
   whose collation is _simple_; a strength-2 (case-insensitive) collation
   helps equality and range queries, never regex.

The consequence: substring or case-insensitive matching belongs to MongoDB
Search, or to a value normalised at write time. There is no third road. This
repository learned that concretely — browse search originally shipped as an
unanchored `'i'` regex over `title`/`sourceId`/`uri` and was a collection scan
on every keystroke until it moved onto the documents text index.

## Choosing the mechanism

| You need                                | Use                                                                     | Notes                                                                         |
| --------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Exact match, case fixed at write time   | b-tree equality on a normalised value                                   | `tags` are lowercased on ingest for exactly this reason                       |
| Exact match, arbitrary case, in $search | `equals` on a `token` field with the `lowercase` normalizer             | `tokenEquals()` in `knowledge-service.ts`; also how the text-leg filters work |
| Prefix, case-insensitive                | `wildcard` `abc*` on a keywordLowercase `string` field                  | no leading-wildcard cost                                                      |
| Substring, case-insensitive             | `wildcard` `*abc*` on a keywordLowercase `string` field                 | the browse-search recipe below                                                |
| Words / relevance ranking               | `text` on a `lucene.standard` `string` field                            | the chunks text index; this is search, not matching                           |
| Sorting inside `$search`                | `token` (strings), `date`, `number` mappings on every field you sort by | unmapped fields cannot be sorted; `_id` cannot serve as a tie-break           |

Normalise-at-write beats everything when you control the data and the case
rules are fixed — it is one b-tree and zero moving parts. Reach for MongoDB
Search when the caller supplies the case, the match is partial, or you need
relevance.

## The keywordLowercase recipe

The live example is `src/db/index-definitions/documents.text.json`. The custom
analyzer indexes each field's **whole value as a single lowercased term**:

```json
"analyzers": [
  {
    "name": "keywordLowercase",
    "tokenizer": { "type": "keyword" },
    "tokenFilters": [{ "type": "lowercase" }]
  }
]
```

with fields mapped as `{ "type": "string", "analyzer": "keywordLowercase" }`.
A `wildcard` query against such a field is a true case-insensitive substring
match, served by the index:

```js
{ wildcard: { query: `*${escaped}*`, path: ['title', 'sourceId', 'uri'], allowAnalyzedField: true } }
```

Two things the query side must do, because **wildcard queries are never
analyzed** — the index side was lowercased, the query side is your job:

1. Lowercase the term in code before building the query.
2. Escape `*`, `?` and `\` — they are Lucene wildcard operators, and a caller
   searching for a literal `*` must not match everything.

`buildDocumentSearchStage()` and `escapeWildcard()` in
`src/services/knowledge-service.ts` are the reference implementation.

**Cost model.** A leading-wildcard query walks the field's term dictionary.
With keyword-analyzed fields there is one term per document value — titles,
ids, uris — so this is fine at browse scale and stays fine as documents grow,
because the term count tracks document count, not content length. It is the
wrong tool for matching inside large bodies of text; that is what the `text`
operator over analyzed content (the chunks text index) is for.

## Sorting, counting and paging inside $search

- **Sort in the `$search` stage** (`sort: { updatedAt: -1 }`), not in a later
  `$sort` — a pipeline `$sort` after `$search` buys an in-memory sort of every
  matched document. Every sort field must be mapped: `token` for strings,
  `date`, `number`. `_id` is not mapped and cannot break ties; give often-tied
  fields (counts, titles) a secondary indexed sort field instead.
- **Count in the `$search` stage** (`count: { type: 'total' }` — the exact
  figure, not the default `lowerBound` estimate) and read it back through
  `$$SEARCH_META` in a `$facet`. `SEARCH_TOTAL_FACET` in
  `knowledge-service.ts` is the reshaping that keeps the search and non-search
  paths returning identical `{ total, page }` shapes.
- `$skip` / `$limit` after `$search` preserve mongot's order, so offset
  pagination composes with an in-search sort.

## The two operational traps

**A missing index reads as zero hits, not as an error, on Atlas Local.**
"Empty result" is therefore ambiguous between "nothing matched" and "nothing
is indexed". Resolve it the way the service does: only when a query comes back
empty, probe with `searchIndexIsQueryable()` and cache the first success (the
`confirmIndex` pattern). Then decide _deliberately_ whether a missing index is
fatal or degradable — browse search and the vector leg are fatal (silently
listing nothing sends an operator hunting for content that is sitting right
there); the hybrid text leg degrades to vector-only because a fresh knowledge
base routinely has the text index still building.

**MongoDB Search is eventually consistent.** A write is searchable after a beat,
not immediately. Integration tests poll (`h.waitFor` in the test harness) and
never sleep-and-hope; anything user-facing that mixes a write with an indexed
read must tolerate the gap — which is why the browse `search` parameter's
description warns that a just-stored document can take a moment to appear.

## Where this lives

| File                                           | What                                                                                                          |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `src/db/index-definitions/documents.text.json` | keywordLowercase analyzer + substring/sort mappings                                                           |
| `src/db/index-definitions/chunks.text.json`    | word-level relevance mappings for the hybrid text leg                                                         |
| `src/services/knowledge-service.ts`            | `buildDocumentSearchStage`, `escapeWildcard`, `SEARCH_TOTAL_FACET`, `assertBrowseSearchServed`, `tokenEquals` |
| `tests/integration/management.test.ts`         | polling browse-search assertions                                                                              |

Changing an analyzer or a mapping rebuilds the index — apply through
`npm run db:indexes` and see `.claude/skills/vector-index-management` for
drift detection, readiness and the update path.
