/**
 * `stripInvisible` — the ingestion-time character filter shared by
 * `domain/schemas.ts` (content normalisation) and `mcp/tools/shared.ts`'s
 * `inline()`.
 *
 * Unlike `inline()`, this must NEVER touch whitespace/newlines — that is the
 * entire reason it exists as a separate export: content normalised with it
 * stays byte-for-byte comparable to what was ingested while still having the
 * invisible-character smuggling vector closed.
 */
import { describe, expect, it } from 'vitest';

import { stripInvisible } from '../../src/domain/sanitize.js';

const ZWSP = String.fromCodePoint(0x200b);
const RLO = String.fromCodePoint(0x202e);
const BOM = String.fromCodePoint(0xfeff);
const NUL = String.fromCodePoint(0x00);

describe('stripInvisible', () => {
  it('strips zero-width and bidi characters used to smuggle invisible text', () => {
    expect(stripInvisible(`safe${ZWSP}hidden${RLO}text`)).toBe('safehiddentext');
    expect(stripInvisible(`a${NUL}b`)).toBe('ab');
    expect(stripInvisible(`${BOM}leading bom`)).toBe('leading bom');
  });

  it('preserves every whitespace character exactly, unlike inline()', () => {
    expect(stripInvisible('line one\nline two')).toBe('line one\nline two');
    expect(stripInvisible('a\tb')).toBe('a\tb');
    expect(stripInvisible('crlf\r\nhere')).toBe('crlf\r\nhere');
    expect(stripInvisible('  leading and trailing  ')).toBe('  leading and trailing  ');
  });

  it('leaves ordinary prose and code untouched', () => {
    expect(stripInvisible('cafe latte 90% done')).toBe('cafe latte 90% done');
    expect(stripInvisible('function f() {\n  return 1;\n}')).toBe('function f() {\n  return 1;\n}');
  });

  it('removes invisible characters without disturbing surrounding newlines', () => {
    expect(stripInvisible(`line one${ZWSP}\nline two`)).toBe('line one\nline two');
  });
});
