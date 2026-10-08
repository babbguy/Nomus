/**
 * Content-cleaner channel-appropriate cleaning.
 * =============================================
 *
 * Proves the two cleaning profiles behave correctly:
 *
 *   - The LIGHT 'structured' profile (official-API-derived byte_exact text)
 *     preserves legitimate regulatory preamble/recital text — including
 *     angle-bracket tokens that the aggressive HTML profile would WRONGLY strip.
 *   - The aggressive 'html_scrape' profile still strips real page chrome
 *     (nav / scripts / cookie banners) from scraped HTML.
 *   - selectCleaningProfile routes official-API byte_exact content to the LIGHT
 *     profile and everything else (incl. plain byte_exact HTML scrapes) to the
 *     aggressive profile.
 */
import { describe, it, expect } from 'vitest';
import { cleanContent, selectCleaningProfile } from './content-cleaner.js';

// Representative text an official-API adapter produces from an authoritative
// STRUCTURED artifact (already-clean text, no page chrome). It legitimately
// contains angle-bracket tokens: an official-journal URL and a fill-in
// placeholder quoted verbatim from the law text — both are CONTENT.
const STRUCTURED_REGULATION = `# Regulation (EU) 2024/1000

Recital 1
Whereas, in order to protect natural persons with regard to the processing of
personal data, the competent authority designated under Article 5 shall publish
the notice at <https://official-journal.europa.eu/notice> and insert the phrase
"<name of the controller>" in every published decision where indicated.

Recital 2
Whereas providers should share information about systemic risks, consent to
periodic audits, and subscribe to the newsletter of the supervisory authority
in accordance with the cooperation mechanism established by this Regulation.

Article 1
Providers of high-risk AI systems shall maintain technical documentation and
records demonstrating compliance with this Regulation throughout the lifecycle
of the system.`;

// Representative SCRAPED HTML page: real regulatory <p> content wrapped in real
// page chrome (nav / script / cookie-consent banner) that MUST be stripped.
const SCRAPED_HTML_PAGE = `<!DOCTYPE html>
<html>
<head><script>trackAnalytics();</script></head>
<body>
  <nav class="site-navigation"><a href="/home">Home</a><a href="/laws">Laws</a></nav>
  <div class="cookie-consent">We use cookies. Consent to cookies to continue. Subscribe to our newsletter.</div>
  <main>
    <h1>Regulation (EU) 2024/1000</h1>
    <p>Article 1</p>
    <p>Providers of high-risk AI systems shall maintain technical documentation and records demonstrating compliance with this Regulation.</p>
  </main>
  <footer class="site-footer">Copyright 2024. Share on social media.</footer>
</body>
</html>`;

describe('structured profile — light normalization preserves legitimate regulatory text', () => {
  it('keeps preamble/recital text and angle-bracket tokens that the HTML profile strips', () => {
    const structured = cleanContent(STRUCTURED_REGULATION, 'html', 'structured');
    const html = cleanContent(STRUCTURED_REGULATION, 'html', 'html_scrape');

    // The LIGHT profile preserves the full preamble/recital + article prose.
    expect(structured.cleanText).toContain('Recital 1');
    expect(structured.cleanText).toContain('Recital 2');
    expect(structured.cleanText).toContain('Article 1');
    expect(structured.cleanText).toContain('Providers of high-risk AI systems shall maintain technical documentation');

    // The angle-bracket tokens are legitimate CONTENT and MUST survive.
    expect(structured.cleanText).toContain('official-journal.europa.eu/notice');
    expect(structured.cleanText).toContain('name of the controller');

    // The aggressive HTML profile treats <https://...> and <name ...> as markup
    // and WRONGLY deletes them — this is exactly the damage the structured
    // profile avoids.
    expect(html.cleanText).not.toContain('official-journal.europa.eu/notice');
    expect(html.cleanText).not.toContain('name of the controller');

    // The structured profile records that it did LIGHT normalization only,
    // never HTML-chrome stripping.
    expect(structured.removedElements.join(' ')).toContain('structured: light normalization');
    expect(structured.removedElements.join(' ')).not.toMatch(/noise element|<nav>|<footer>/);
  });

  it('does not flag recital/preamble prose as noise even though it mentions share/consent/subscribe', () => {
    // NOISE_PATTERNS match on class/id attributes, not prose — but prove the
    // light profile keeps Recital 2's "share / consent / subscribe" prose that a
    // careless text-level filter might drop.
    const structured = cleanContent(STRUCTURED_REGULATION, 'html', 'structured');
    expect(structured.cleanText).toContain('share information about systemic risks');
    expect(structured.cleanText).toContain('consent to');
    expect(structured.cleanText).toContain('subscribe to the newsletter of the supervisory authority');
  });

  it('applies encoding normalization, hyphenation rejoin and consecutive-line dedupe only', () => {
    const raw = 'Article 1\nArticle 1\nThe supervisory author-\nity shall act &amp; publish results.';
    const structured = cleanContent(raw, 'html', 'structured');
    // Adjacent duplicate heading collapsed to one.
    expect(structured.cleanText.match(/Article 1/g)?.length).toBe(1);
    // Hyphenated line-break rejoined.
    expect(structured.cleanText).toContain('authority shall act');
    // Entity decoded.
    expect(structured.cleanText).toContain('act & publish');
  });
});

describe('html_scrape profile — still strips real page chrome from scraped HTML', () => {
  it('removes nav/script/cookie-banner/footer chrome but keeps regulatory <p> content', () => {
    const html = cleanContent(SCRAPED_HTML_PAGE, 'html', 'html_scrape');

    // Real regulatory content survives.
    expect(html.cleanText).toContain('Regulation (EU) 2024/1000');
    expect(html.cleanText).toContain('Providers of high-risk AI systems shall maintain technical documentation');

    // Page chrome is stripped.
    expect(html.cleanText).not.toContain('trackAnalytics');
    expect(html.cleanText).not.toContain('We use cookies');
    expect(html.cleanText).not.toContain('Share on social media');
    expect(html.cleanText.toLowerCase()).not.toContain('site-navigation');
  });

  it('is the default profile when none is supplied (unchanged behaviour)', () => {
    const explicit = cleanContent(SCRAPED_HTML_PAGE, 'html', 'html_scrape');
    const defaulted = cleanContent(SCRAPED_HTML_PAGE, 'html');
    expect(defaulted.cleanText).toBe(explicit.cleanText);
  });
});

describe('selectCleaningProfile — routes by ingestion channel + provenance', () => {
  it('routes official-API byte_exact content to the LIGHT structured profile', () => {
    expect(selectCleaningProfile({ ingestionChannel: 'official_api', provenanceMode: 'byte_exact' })).toBe('structured');
    expect(selectCleaningProfile({ ingestionChannel: 'bulk', provenanceMode: 'byte_exact' })).toBe('structured');
  });

  it('routes plain HTML scrapes (no channel / scrape channel) to the aggressive profile', () => {
    // A byte_exact single-body HTML scrape is NOT structured — it still has chrome.
    expect(selectCleaningProfile({ ingestionChannel: null, provenanceMode: 'byte_exact' })).toBe('html_scrape');
    expect(selectCleaningProfile({ ingestionChannel: undefined, provenanceMode: 'byte_exact' })).toBe('html_scrape');
    expect(selectCleaningProfile({ ingestionChannel: 'scrape', provenanceMode: 'byte_exact' })).toBe('html_scrape');
  });

  it('does not treat non-byte_exact official-channel content as structured (defensive)', () => {
    // e.g. a healed/stale copy must never receive the light profile.
    expect(selectCleaningProfile({ ingestionChannel: 'official_api', provenanceMode: 'healed' })).toBe('html_scrape');
    expect(selectCleaningProfile({ ingestionChannel: 'official_api', provenanceMode: 'stale_cache' })).toBe('html_scrape');
    // rss feed items are HTML-ish, not authoritative structured artifacts.
    expect(selectCleaningProfile({ ingestionChannel: 'rss', provenanceMode: 'byte_exact' })).toBe('html_scrape');
  });
});
