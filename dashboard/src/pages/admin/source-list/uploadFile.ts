// ---------------------------------------------------------------------------
// Upload helpers — detect binary vs text and produce the correct payload
// ---------------------------------------------------------------------------

/**
 * Read an ArrayBuffer and convert to a base64 string.
 * Chunked to avoid `String.fromCharCode.apply` stack overflow on large PDFs.
 */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(binary);
}

/**
 * Read a File object and return a `{content, contentType}` payload suitable
 * for POST /sources/upload-content.
 *
 * - PDFs (detected by `%PDF` magic bytes OR `.pdf` extension OR `application/pdf`
 *   MIME) are read as ArrayBuffer and base64-encoded. The backend then does
 *   `Buffer.from(content, 'base64')` and passes to pdf-parse.
 * - Everything else (HTML, TXT, MD, XML) is read as UTF-8 text.
 *
 * This fixes the QA-flagged bug where `file.text()` corrupted PDF binary,
 * producing zero-rule extraction on ISO 27001 / ISO 42001 / PCI-DSS uploads.
 */
export async function readFileForUpload(file: File): Promise<{ content: string; contentType: 'html' | 'pdf' }> {
  const nameLower = file.name.toLowerCase();
  const looksLikePdf =
    nameLower.endsWith('.pdf') ||
    file.type === 'application/pdf' ||
    file.type === 'application/x-pdf';

  if (looksLikePdf) {
    const buffer = await file.arrayBuffer();
    // Confirm by magic bytes — first 4 bytes of a valid PDF are %PDF (0x25 0x50 0x44 0x46)
    const head = new Uint8Array(buffer.slice(0, 4));
    const isPdf = head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46;
    if (!isPdf) {
      throw new Error('File has .pdf extension but does not start with %PDF header. Is it corrupt or encrypted?');
    }
    return { content: arrayBufferToBase64(buffer), contentType: 'pdf' };
  }

  // Text path (HTML, TXT, MD, XML, etc.)
  const text = await file.text();
  return { content: text, contentType: 'html' };
}
