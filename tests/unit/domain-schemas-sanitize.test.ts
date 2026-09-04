import { describe, it, expect } from 'vitest';
import { storeContentSchema } from '../../src/domain/schemas.js';

// -----------------------------------------------------------------------
// Ingestion-time invisible-character normalisation
//
// `content` is the path that writes into `DocumentDoc.content`, so this is
// the point where the invisible/control/bidi class gets stripped — see
// `domain/sanitize.ts` and `get_content`'s design notes. Whitespace,
// including newlines, must never be touched: real prose/code depends on it.
// -----------------------------------------------------------------------

describe('Domain Schema Validation Tests', () => {
  const ZWSP = String.fromCodePoint(0x200b);
  const BOM = String.fromCodePoint(0xfeff);

  it('strips invisible/control characters from store_content content at parse time', () => {
    const result = storeContentSchema.safeParse({
      content: `${BOM}Line one${ZWSP}\nLine two`,
      title: 'Test',
      contentType: 'markdown',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.content).toBe('Line one\nLine two');
    }
  });
});
