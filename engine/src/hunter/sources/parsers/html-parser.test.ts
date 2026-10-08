/**
 * html-parser tests — the parser must not silently drop legal text that lives
 * in non-whitelisted containers (<div>/<blockquote>/<span>/<pre>). Dropped
 * statutory text is a completeness failure presented as complete.
 */
import { describe, it, expect } from 'vitest';
import { parseHtml } from './html-parser.js';

describe('parseHtml block-level text capture', () => {
  it('captures legal text inside a bare <div> (previously dropped)', () => {
    const html = `<html><body><article>
      <h2>Article 5</h2>
      <div>The provider of a high-risk AI system shall establish, implement, document and maintain a risk management system in relation to the high-risk AI system throughout its entire lifecycle.</div>
    </article></body></html>`;
    const out = parseHtml(html, {});
    expect(out).toContain('Article 5');
    expect(out).toContain('risk management system');
    expect(out).toContain('throughout its entire lifecycle');
  });

  it('captures legal text inside a <blockquote>', () => {
    const html = `<html><body><main>
      <blockquote>Personal data shall be processed lawfully, fairly and in a transparent manner in relation to the data subject as required by this Regulation and applicable law.</blockquote>
    </main></body></html>`;
    const out = parseHtml(html, {});
    expect(out).toContain('processed lawfully, fairly and in a transparent manner');
  });

  it('captures span-wrapped loose text inside a bare div', () => {
    const html = `<html><body><section>
      <div><span>Member States shall lay down the rules on penalties applicable to infringements of this Regulation and shall take all measures necessary to ensure that they are implemented.</span></div>
    </section></body></html>`;
    const out = parseHtml(html, {});
    expect(out).toContain('rules on penalties applicable to infringements');
  });

  it('captures <pre> statutory text verbatim', () => {
    const html = `<html><body><div><pre>SECTION 1798.100. A consumer shall have the right to request that a business disclose the categories of personal information it collects.</pre></div></body></html>`;
    const out = parseHtml(html, {});
    expect(out).toContain('1798.100');
    expect(out).toContain('categories of personal information');
  });

  it('does NOT duplicate text already captured from <p> children', () => {
    const html = `<html><body><div class="content"><p>The unique clause about algorithmic transparency appears exactly once.</p></div></body></html>`;
    const out = parseHtml(html, {});
    const occurrences = out.split('algorithmic transparency').length - 1;
    expect(occurrences).toBe(1);
  });

  it('still parses well-structured documents into markdown headings', () => {
    const html = `<html><body><article>
      <h1>Regulation on Artificial Intelligence</h1>
      <h2>Article 1 Subject matter</h2>
      <p>This Regulation lays down harmonised rules on artificial intelligence across the Union, establishing obligations for providers and deployers of AI systems and ensuring a high level of protection of health, safety and fundamental rights.</p>
      <h2>Article 2 Scope</h2>
      <p>This Regulation applies to providers placing on the market or putting into service AI systems in the Union, irrespective of whether those providers are established within the Union or in a third country, as well as to deployers of AI systems.</p>
    </article></body></html>`;
    const out = parseHtml(html, {});
    expect(out).toContain('# Regulation on Artificial Intelligence');
    expect(out).toContain('## Article 1');
    expect(out).toContain('harmonised rules on artificial intelligence');
  });
});
