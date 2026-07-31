/**
 * Snippet extraction and — more importantly — the HTML escaping boundary.
 *
 * Chunk text is stored verbatim on purpose, so the corpus is full of angle
 * brackets, and the web UI renders it. The escaping tests below are the contract
 * the view layer relies on: no byte of ingested content can become markup.
 */
import { describe, expect, it } from 'vitest';

import {
  buildHighlightFragments,
  escapeHtml,
  extractQueryTerms,
  renderFragmentHtml,
  renderFragmentsHtml,
} from '../../src/services/highlight.js';

/** 27 characters per repeat, so offsets in the tests below are predictable. */
const filler = 'lorem ipsum dolor sit amet '.repeat(40);

describe('escapeHtml', () => {
  it('escapes every character that can break out of text or an attribute', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  it('escapes the ampersand first so entities are not double-built', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('leaves ordinary text alone', () => {
    expect(escapeHtml('plain text 123 — ok')).toBe('plain text 123 — ok');
  });
});

describe('extractQueryTerms', () => {
  it('lowercases, splits on non-word characters and de-duplicates', () => {
    expect(extractQueryTerms('Vector Search, vector!')).toEqual(['vector', 'search']);
  });

  it('drops stopwords and single characters', () => {
    expect(extractQueryTerms('how do I index a chunk')).toEqual(['index', 'chunk']);
  });

  it('falls back to the raw tokens when the query is entirely stopwords', () => {
    expect(extractQueryTerms('how to')).toEqual(['how', 'to']);
  });

  it('returns nothing for a query with no word characters', () => {
    expect(extractQueryTerms('!!! ???')).toEqual([]);
  });
});

describe('renderFragmentHtml', () => {
  it('wraps matched terms in <mark>', () => {
    expect(renderFragmentHtml('chunking chunks well', 'chunk')).toBe(
      '<mark>chunk</mark>ing <mark>chunk</mark>s well',
    );
  });

  it('only matches at a word boundary, so mid-word noise is not highlighted', () => {
    expect(renderFragmentHtml('unchunked', 'chunk')).toBe('unchunked');
  });

  it('merges overlapping terms into a single mark instead of nesting tags', () => {
    expect(renderFragmentHtml('foobar', 'foo foobar')).toBe('<mark>foobar</mark>');
  });

  it('returns escaped text unchanged when nothing matches', () => {
    expect(renderFragmentHtml('a <b> tag', 'zzz')).toBe('a &lt;b&gt; tag');
  });

  describe('escaping (security boundary)', () => {
    it('neutralises a script tag in ingested content', () => {
      const html = renderFragmentHtml('<script>alert("xss")</script>', 'alert');

      expect(html).toBe('&lt;script&gt;<mark>alert</mark>(&quot;xss&quot;)&lt;/script&gt;');
      expect(html).not.toContain('<script');
      expect(html).not.toContain('</script>');
    });

    it('neutralises an event-handler injection', () => {
      const html = renderFragmentHtml(`<img src=x onerror="alert('1')">`, 'onerror');

      expect(html).not.toContain('<img');
      expect(html).toContain('&lt;img src=x ');
      expect(html).toContain('<mark>onerror</mark>');
      expect(html).toContain('&quot;alert(&#39;1&#39;)&quot;');
    });

    it('escapes even when the query itself is the markup', () => {
      const html = renderFragmentHtml('<script>bad</script>', 'script');

      expect(html).toBe('&lt;<mark>script</mark>&gt;bad&lt;/<mark>script</mark>&gt;');
      expect(html).not.toContain('<script');
    });

    it('never emits a tag other than <mark>', () => {
      const html = renderFragmentHtml(
        '<svg/onload=alert(1)><iframe src=javascript:alert(2)></iframe>',
        'svg iframe',
      );

      const tags = [...html.matchAll(/<\/?([a-zA-Z][^\s/>]*)/gu)].map((match) => match[1]);
      expect(new Set(tags)).toEqual(new Set(['mark']));
    });

    it('does not corrupt the entities it just produced', () => {
      // The naive "escape the whole string, then replace the terms" ordering
      // turns this into `Fish &<mark>amp</mark>; chips`.
      expect(renderFragmentHtml('Fish & chips', 'amp')).toBe('Fish &amp; chips');
      expect(renderFragmentHtml('a < b', 'lt')).toBe('a &lt; b');
    });

    it('highlights a genuine occurrence next to an escaped one', () => {
      expect(renderFragmentHtml('& amps', 'amp')).toBe('&amp; <mark>amp</mark>s');
    });
  });
});

describe('renderFragmentsHtml', () => {
  it('renders every fragment', () => {
    expect(renderFragmentsHtml(['<b>one</b>', 'two'], 'one two')).toEqual([
      '&lt;b&gt;<mark>one</mark>&lt;/b&gt;',
      '<mark>two</mark>',
    ]);
  });
});

describe('buildHighlightFragments', () => {
  it('returns nothing for empty or whitespace-only text', () => {
    expect(buildHighlightFragments('', 'anything')).toEqual([]);
    expect(buildHighlightFragments('   \n\t ', 'anything')).toEqual([]);
  });

  it('returns short text whole, with no ellipses', () => {
    const text = 'The quick brown fox jumps over the lazy dog.';
    expect(buildHighlightFragments(text, 'fox')).toEqual([text]);
  });

  it('falls back to the head of the text when nothing matches', () => {
    expect(buildHighlightFragments('Hello world', 'zzzz')).toEqual(['Hello world']);
  });

  it('falls back to the head of the text for a query with no usable terms', () => {
    expect(buildHighlightFragments('Hello world', '!!!')).toEqual(['Hello world']);
  });

  it('centres the window on the match and marks the elided edges', () => {
    const [fragment] = buildHighlightFragments(`${filler}the needle is here ${filler}`, 'needle');

    expect(fragment).toBeDefined();
    expect(fragment).toContain('needle');
    expect(fragment?.startsWith('…')).toBe(true);
    expect(fragment?.endsWith('…')).toBe(true);
    // Roughly the requested width, plus the two ellipses.
    expect(fragment?.length).toBeLessThanOrEqual(242);
  });

  it('does not mark an edge that is a real end of the text', () => {
    const fragment = buildHighlightFragments(`needle at the start ${filler}`, 'needle')[0];

    expect(fragment?.startsWith('…')).toBe(false);
    expect(fragment?.endsWith('…')).toBe(true);
  });

  it('collapses newlines so a fragment is a single line', () => {
    const fragment = buildHighlightFragments('alpha\n\n\tneedle\n   beta', 'needle')[0];
    expect(fragment).toBe('alpha needle beta');
  });

  it('prefers the window covering the most distinct query terms', () => {
    const text = `${filler}alpha alone ${filler}alpha and beta together ${filler}`;
    const [fragment] = buildHighlightFragments(text, 'alpha beta', { maxFragments: 1 });

    expect(fragment).toContain('alpha and beta together');
  });

  it('returns several non-overlapping windows, capped by maxFragments', () => {
    const text = `${filler}needle one ${filler}needle two ${filler}needle three ${filler}`;
    const fragments = buildHighlightFragments(text, 'needle', { maxFragments: 2 });

    expect(fragments).toHaveLength(2);
    expect(fragments.every((fragment) => fragment.includes('needle'))).toBe(true);
    expect(fragments[0]).not.toBe(fragments[1]);
  });

  it('honours a custom fragment width', () => {
    const fragment = buildHighlightFragments(`${filler}needle ${filler}`, 'needle', {
      fragmentChars: 60,
      maxFragments: 1,
    })[0];

    expect(fragment).toContain('needle');
    expect(fragment?.length).toBeLessThanOrEqual(62);
  });

  it('does not split a word across the fragment boundary', () => {
    const fragment = buildHighlightFragments(`${filler}needle ${filler}`, 'needle', {
      fragmentChars: 60,
      maxFragments: 1,
    })[0];

    // Every word inside the window is a whole word from the filler or the needle.
    const words = (fragment ?? '').replace(/…/gu, '').trim().split(' ');
    const vocabulary = new Set(['lorem', 'ipsum', 'dolor', 'sit', 'amet', 'needle']);
    for (const word of words) {
      expect(vocabulary.has(word)).toBe(true);
    }
  });

  it('produces fragments that are still unsafe raw and safe once rendered', () => {
    const [fragment] = buildHighlightFragments('see <b>needle</b> here', 'needle');

    expect(fragment).toContain('<b>');
    expect(renderFragmentHtml(fragment ?? '', 'needle')).toBe(
      'see &lt;b&gt;<mark>needle</mark>&lt;/b&gt; here',
    );
  });
});
