/**
 * The markdown renderer.
 *
 * The escaping block comes first and is the reason this module is tested at all:
 * it is the only place in the application besides `highlight.ts` that turns
 * stored, untrusted document text into HTML, so "no source text ever reaches the
 * output as markup" has to be pinned against every construct that could carry
 * it — text, code, link labels, hrefs, table cells, headings.
 *
 * The formatting tests below it are ordinary: they describe the supported subset
 * and, just as importantly, that unsupported syntax degrades to escaped text
 * rather than vanishing.
 */
import { describe, expect, it } from 'vitest';

import { escapeHtml, renderMarkdown } from '../../src/services/markdown.js';

/**
 * Every tag the renderer is allowed to emit. Anything else in the output came
 * from the source, which is the failure this whole file exists to catch.
 */
const ALLOWED_TAGS = new Set([
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'ul',
  'ol',
  'li',
  'pre',
  'code',
  'blockquote',
  'hr',
  'div',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'a',
  'strong',
  'em',
]);

/**
 * The invariant, checked structurally rather than by substring.
 *
 * A substring assertion like `not.toContain('onerror=')` is the wrong test:
 * escaped text legitimately contains those characters (`&lt;img onerror=…&gt;`
 * is inert). What matters is that no tag outside the allowlist is emitted and
 * that no tag carries an event-handler or style attribute.
 */
function expectOnlySafeMarkup(html: string, label = ''): void {
  for (const match of html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/gu)) {
    expect(ALLOWED_TAGS, `${label}: unexpected tag <${match[1]}>`).toContain(
      (match[1] ?? '').toLowerCase(),
    );
  }
  // No event handlers, no style, no src — inside any tag we emitted.
  expect(html, label).not.toMatch(/<[^>]*\son[a-z]+\s*=/iu);
  expect(html, label).not.toMatch(/<[^>]*\sstyle\s*=/iu);
  expect(html, label).not.toMatch(/<[^>]*\ssrc\s*=/iu);
}

describe('escaping untrusted content', () => {
  it('escapes raw HTML instead of passing it through', () => {
    const html = renderMarkdown('<script>alert(1)</script>');

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expectOnlySafeMarkup(html);
  });

  it('emits no markup from the source, in any construct that carries text', () => {
    const cases = [
      '# <img src=x onerror=alert(1)>',
      '- <script>x</script>',
      '> <img src=x onerror=alert(1)>',
      '**<script>x</script>**',
      '`<script>x</script>`',
      '```\n<script>x</script>\n```',
      '| <script>x</script> |\n| --- |\n| <img src=x onerror=1> |',
      '[<script>x</script>](https://example.test)',
      '<div style="position:fixed">overlay</div>',
      '<a href="https://evil.test">phish</a>',
    ];

    for (const source of cases) {
      const html = renderMarkdown(source);
      expect(html, source).not.toContain('<script');
      expect(html, source).not.toContain('<img');
      expectOnlySafeMarkup(html, source);
    }
  });

  it('refuses a javascript: link, rendering the label as text', () => {
    const html = renderMarkdown('[click me](javascript:alert(1))');

    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<a ');
    expect(html).toContain('click me');
  });

  it.each([
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    '/documents/forged',
    '../relative',
  ])('refuses the non-http destination %s', (href) => {
    const html = renderMarkdown(`[label](${href})`);

    expect(html).not.toContain('<a ');
    expect(html).toContain('label');
  });

  it('links http and https, with rel guarding the referrer', () => {
    const html = renderMarkdown('[docs](https://example.test/a?b=1&c=2)');

    expect(html).toContain('href="https://example.test/a?b=1&amp;c=2"');
    expect(html).toContain('rel="noreferrer noopener nofollow external"');
    expect(html).toContain('>docs</a>');
  });

  it('renders an image as a link rather than firing an off-origin request', () => {
    const html = renderMarkdown('![a beacon](https://tracker.test/pixel.gif)');

    expect(html).not.toContain('<img');
    expect(html).toContain('href="https://tracker.test/pixel.gif"');
    expect(html).toContain('a beacon');
  });

  it('cannot be tricked into emitting an attribute by a quote in a label', () => {
    const html = renderMarkdown('[" onmouseover="alert(1)](https://example.test)');

    // The quote is escaped, so the handler text stays inside the anchor's text
    // node instead of closing the href and becoming an attribute.
    expect(html).toContain('&quot;');
    expectOnlySafeMarkup(html);
  });

  it('escapeHtml covers every character that matters', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  it('escapes the ampersand first, so an entity in the source stays literal', () => {
    // Getting this order wrong turns "&lt;" in a document into a real "<".
    expect(escapeHtml('&lt;script&gt;')).toBe('&amp;lt;script&amp;gt;');
  });
});

describe('block structure', () => {
  it('renders ATX headings at their level', () => {
    expect(renderMarkdown('# One')).toContain('<h1');
    expect(renderMarkdown('### Three')).toContain('<h3');
    // Seven hashes is not a heading at all in CommonMark, and must not become
    // one by clamping — it is a paragraph that happens to start with hashes.
    expect(renderMarkdown('####### Seven')).toContain('<p ');
    expect(renderMarkdown('###### Six')).toContain('<h6');
  });

  it('renders setext headings', () => {
    expect(renderMarkdown('Title\n=====')).toContain('<h1');
    expect(renderMarkdown('Title\n-----')).toContain('<h2');
  });

  it('treats a thematic break as a rule, not an empty list item', () => {
    const html = renderMarkdown('a\n\n---\n\nb');

    expect(html).toContain('<hr');
    expect(html).not.toContain('<li');
  });

  it('keeps a fenced block verbatim and does not parse markdown inside it', () => {
    const html = renderMarkdown('```sh\n# not a heading\n**not bold**\n```');

    expect(html).toContain('<pre');
    expect(html).toContain('# not a heading');
    expect(html).not.toContain('<h1');
    expect(html).not.toContain('<strong>');
  });

  it('closes an unterminated fence at the end of the document', () => {
    const html = renderMarkdown('```\nstill code');

    expect(html).toContain('<pre');
    expect(html).toContain('still code');
  });

  it('joins the lines of one paragraph and separates two', () => {
    const html = renderMarkdown('one\ntwo\n\nthree');

    expect(html).toContain('<p class="my-3 leading-relaxed text-slate-800 dark:text-slate-200">');
    expect(html).toContain('one two');
    expect((html.match(/<p /gu) ?? []).length).toBe(2);
  });

  it('renders unordered and ordered lists', () => {
    expect(renderMarkdown('- a\n- b')).toContain('<ul');
    expect(renderMarkdown('1. a\n2. b')).toContain('<ol');
    expect((renderMarkdown('- a\n- b').match(/<li/gu) ?? []).length).toBe(2);
  });

  it('nests a list by indentation', () => {
    const html = renderMarkdown('- outer\n  - inner');

    expect((html.match(/<ul/gu) ?? []).length).toBe(2);
    expect(html).toContain('inner');
  });

  it('renders a blockquote', () => {
    expect(renderMarkdown('> quoted')).toContain('<blockquote');
  });

  it('renders a pipe table with a header row', () => {
    const html = renderMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |');

    expect(html).toContain('<table');
    expect(html).toContain('<th');
    expect(html).toContain('scope="col"');
    expect((html.match(/<td/gu) ?? []).length).toBe(2);
  });

  it('does not turn a paragraph containing a pipe into a table', () => {
    // No divider row, so this is prose about a shell pipeline.
    const html = renderMarkdown('run `ls | wc -l` to count');

    expect(html).not.toContain('<table');
    expect(html).toContain('<p ');
  });
});

describe('inline formatting', () => {
  it('renders strong and emphasis', () => {
    expect(renderMarkdown('**bold**')).toContain('<strong>bold</strong>');
    expect(renderMarkdown('*italic*')).toContain('<em>italic</em>');
    expect(renderMarkdown('__bold__')).toContain('<strong>bold</strong>');
  });

  it('prefers strong over emphasis at the same position', () => {
    const html = renderMarkdown('**both**');

    expect(html).toContain('<strong>');
    expect(html).not.toContain('<em>');
  });

  it('leaves markdown inside a code span literal', () => {
    const html = renderMarkdown('`**not bold**`');

    expect(html).toContain('<code');
    expect(html).toContain('**not bold**');
    expect(html).not.toContain('<strong>');
  });

  it('leaves an unmatched marker as text rather than dropping it', () => {
    const html = renderMarkdown('2 * 3 * 4 is math');

    expect(html).toContain('is math');
    expect(html).toContain('2 *');
  });

  it('renders unsupported syntax as text instead of losing it', () => {
    // Reference links and footnotes are out of scope; the words must survive.
    const html = renderMarkdown('see [the docs][ref] and a note[^1]');

    expect(html).toContain('the docs');
    expect(html).toContain('a note');
  });
});

describe('robustness', () => {
  it.each(['', '\n', '   ', '\n\n\n'])('returns no elements for blank input %j', (source) => {
    expect(renderMarkdown(source).trim()).toBe('');
  });

  it('handles CRLF the same as LF', () => {
    expect(renderMarkdown('# One\r\n\r\ntext')).toBe(renderMarkdown('# One\n\ntext'));
  });

  it('terminates on pathological emphasis markers', () => {
    // A quadratic or non-terminating inline scanner shows up here first.
    const html = renderMarkdown(`${'*'.repeat(500)}text${'_'.repeat(500)}`);

    expect(html).toContain('text');
  });
});
