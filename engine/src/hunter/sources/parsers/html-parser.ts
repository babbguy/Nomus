import * as cheerio from 'cheerio';
import type { Element } from 'domhandler';
import type { SelectorConfig } from '@nomus/shared';

/**
 * Extract structured text from HTML using Cheerio.
 * Preserves heading hierarchy as markdown markers for semantic chunking.
 * Removes navigation, footers, scripts, and other non-content elements.
 *
 * Returns: { text: string, rawHtml: string } — rawHtml is for quality scoring.
 */
export function parseHtml(html: string, config: SelectorConfig): string {
  const $ = cheerio.load(html);

  // Remove noise elements — always strip these regardless of config
  const alwaysRemove = [
    'script', 'style', 'noscript', 'iframe', 'svg', 'img',
    'button', 'input', 'form',
  ];

  // Config-provided selectors extend the defaults, never replace them
  const defaultRemove = [
    'nav', 'footer', 'header',
    '.cookie-banner', '.sidebar', '#menu',
  ];

  const removeSelectors = [
    ...alwaysRemove,
    ...(config.removeSelectors?.length ? config.removeSelectors : defaultRemove),
  ];

  for (const sel of removeSelectors) {
    $(sel).remove();
  }

  // Extract from target selector or body
  const root = config.contentSelector
    ? $(config.contentSelector)
    : $('body');

  // Structure-aware extraction: convert HTML hierarchy to markdown
  const lines: string[] = [];

  root.find('*').each((_, el) => {
    const node = $(el);
    // find('*') is typed Cheerio<AnyNode>; only Element nodes carry tagName,
    // and the '*' selector only ever yields elements at runtime.
    const tag = (el as Element).tagName?.toLowerCase();
    if (!tag) return;

    // Skip if already processed as part of a parent
    if (node.parents('li, td, th').length > 0 && !['li', 'td', 'th'].includes(tag)) return;

    switch (tag) {
      case 'h1':
        lines.push(`\n# ${cleanText(node.text())}\n`);
        break;
      case 'h2':
        lines.push(`\n## ${cleanText(node.text())}\n`);
        break;
      case 'h3':
        lines.push(`\n### ${cleanText(node.text())}\n`);
        break;
      case 'h4':
        lines.push(`\n#### ${cleanText(node.text())}\n`);
        break;
      case 'h5':
      case 'h6':
        lines.push(`\n##### ${cleanText(node.text())}\n`);
        break;
      case 'p':
        const text = cleanText(node.text());
        if (text.length > 0) lines.push(text + '\n');
        break;
      case 'li': {
        const liText = cleanText(node.text());
        if (liText.length > 0) lines.push(`- ${liText}`);
        break;
      }
      case 'table': {
        // Convert table to simple text representation
        const rows: string[] = [];
        node.find('tr').each((_, tr) => {
          const cells: string[] = [];
          $(tr).find('td, th').each((_, cell) => {
            cells.push(cleanText($(cell).text()));
          });
          if (cells.length > 0) rows.push(cells.join(' | '));
        });
        if (rows.length > 0) {
          lines.push('\n' + rows.join('\n') + '\n');
        }
        break;
      }
      case 'pre': {
        // Preformatted blocks can carry statutory text/formulae verbatim.
        const preText = cleanText(node.text());
        if (preText.length > 0) lines.push(preText + '\n');
        break;
      }
      default:
        if (BLOCK_CONTAINER.has(tag)) {
          // Legal text is frequently wrapped in a bare <div>/<section>/
          // <blockquote>/<dd> etc. that is NOT in the markdown whitelist above.
          // Previously that text was silently dropped. Capture the block's
          // "leaf" text — everything NOT already emitted by a descendant
          // heading/paragraph/list/table — so nothing is lost and nothing is
          // double-counted.
          const leaf = blockLeafText(node);
          if (leaf.length > 0) {
            lines.push(tag === 'blockquote' ? `> ${leaf}\n` : leaf + '\n');
          }
        }
        break;
    }
  });

  // If structure-aware extraction produced content, use it
  let result = lines.join('\n');

  // Over-strip guard: fall back to the raw text of the root when structured
  // extraction captured little OR lost a large fraction of the available text.
  // A tiny (<200 char) fixed floor cannot catch partial loss of a large
  // document, so we also compare against the root's full plain text.
  const structuredLen = result.replace(/\s+/g, ' ').trim().length;
  const plain = root.text();
  const plainLen = plain.replace(/\s+/g, ' ').trim().length;
  if (structuredLen < 200 || structuredLen < plainLen * MIN_RETENTION_RATIO) {
    result = plain;
  }

  // Normalize whitespace
  result = result
    .replace(/\t/g, ' ')
    .replace(/ +/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return result;
}

/**
 * Block-level containers that are NOT part of the markdown whitelist but that
 * can legitimately hold legal text as their own content.
 */
const BLOCK_CONTAINER = new Set([
  'div', 'section', 'article', 'main', 'blockquote',
  'dd', 'dt', 'figcaption', 'details', 'summary', 'address',
]);

/**
 * If structured extraction captures less than this fraction of the root's plain
 * text, treat it as over-stripping and fall back to the full plain text — a
 * complete-but-flat capture beats a pretty-but-partial one for legal exactness.
 */
const MIN_RETENTION_RATIO = 0.4;

/**
 * Extract the "leaf" text of a block container: all text NOT inside a
 * descendant that is captured on its own (headings, paragraphs, list items,
 * tables, or nested block containers). This preserves loose text — including
 * text wrapped only in inline elements like <span>/<strong> — without
 * duplicating content already emitted for child elements.
 */
function blockLeafText(node: cheerio.Cheerio<Element>): string {
  const clone = node.clone();
  clone
    .find('h1, h2, h3, h4, h5, h6, p, li, ul, ol, dl, table, pre, div, section, article, main, blockquote, dd, dt, figcaption, details, summary, address')
    .remove();
  return cleanText(clone.text());
}

/**
 * Get raw HTML for quality scoring (before stripping).
 */
export function getRawHtml(html: string, config: SelectorConfig): string {
  const $ = cheerio.load(html);
  const root = config.contentSelector
    ? $(config.contentSelector)
    : $('body');
  return root.html() ?? '';
}

function cleanText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
