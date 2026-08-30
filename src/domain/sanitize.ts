/**
 * The invisible/control character class stripped from anything that becomes
 * `DocumentDoc.content` (see `schemas.ts`'s `storeContentShape.content`) and,
 * for values that were never routed through that boundary, from any
 * single-line field an MCP tool interpolates into its rendered text
 * (`mcp/tools/shared.ts`'s `inline()`).
 *
 * This is a domain-level ingestion concern, not a presentation concern, so it
 * lives here rather than under `mcp/tools/`: content is normalised once, at
 * the boundary where it is written, so everything downstream (chunking,
 * embedding, search results, `get_content`) reads an already-clean value
 * instead of every read path needing to remember to defend itself.
 *
 * Two distinct hazards, both prompt-injection primitives rather than display
 * bugs:
 *  - C0/C1 controls and DEL, which can emit terminal escapes or NUL.
 *  - Zero-width and bidirectional formatting characters (ZWSP/ZWNJ/ZWJ,
 *    LRM/RLM, the embedding, override and isolate controls, the
 *    invisible-operator block, and BOM) — the classic "invisible
 *    instructions" trick: a human reviewing ingested content sees innocuous
 *    prose while a model reads smuggled directives.
 *
 * TAB/LF/CR are deliberately absent, and no other whitespace is touched:
 * `stripInvisible` never changes a string's line structure or visible length,
 * which is what makes it safe to run once at ingestion rather than
 * defensively on every read.
 */
function isInvisibleOrControl(codePoint: number): boolean {
  return (
    (codePoint >= 0x00 && codePoint <= 0x08) ||
    (codePoint >= 0x0b && codePoint <= 0x0c) ||
    (codePoint >= 0x0e && codePoint <= 0x1f) ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2060 && codePoint <= 0x2064) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069) ||
    codePoint === 0xfeff
  );
}

/**
 * Remove the invisible/control character class, preserving every other
 * character exactly — including all whitespace (space, tab, newline).
 */
export function stripInvisible(value: string): string {
  let stripped = '';
  // `for...of` iterates by code point, so an astral character is never split
  // into surrogate halves that could each survive the filter independently.
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && isInvisibleOrControl(codePoint)) continue;
    stripped += character;
  }
  return stripped;
}
