import pdf from 'pdf-parse';
import type { SelectorConfig } from '@nomus/shared';

/**
 * Extract text content from a PDF buffer.
 * Optionally limits to a page range specified in config.
 */
export async function parsePdf(buffer: Buffer, config: SelectorConfig): Promise<string> {
  const options: pdf.Options = {};

  // Parse page range if specified (e.g., "1-50")
  if (config.pageRange) {
    const [startStr, endStr] = config.pageRange.split('-');
    const start = parseInt(startStr, 10);
    const end = endStr ? parseInt(endStr, 10) : start;

    options.max = end; // pdf-parse max pages to parse
  }

  const data = await pdf(buffer, options);

  // Normalize whitespace
  let text = data.text;
  text = text
    .replace(/\t/g, ' ')
    .replace(/ +/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return text;
}
