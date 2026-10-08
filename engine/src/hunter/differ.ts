/**
 * Step 1: Dumb Diff — $0 cost.
 * Compare content hashes to detect changes.
 * If changed, extract the diff between old and new text.
 */

export interface DiffResult {
  hasChanges: boolean;
  changedSections: string[];
  summary: string;
}

/**
 * Compare two content hashes. Returns true if they differ.
 */
export function hasContentChanged(oldHash: string | null, newHash: string): boolean {
  if (!oldHash) return true; // First scrape
  return oldHash !== newHash;
}

/**
 * Extract changed sections between old and new text.
 * Splits by paragraphs and finds added/modified ones.
 * Includes surrounding context for LLM processing.
 */
export function extractChangedSections(
  oldText: string,
  newText: string,
  contextLines = 3,
): DiffResult {
  const oldParagraphs = oldText.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
  const newParagraphs = newText.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);

  const oldSet = new Set(oldParagraphs);
  const changedIndices: number[] = [];

  // Find new/modified paragraphs
  for (let i = 0; i < newParagraphs.length; i++) {
    if (!oldSet.has(newParagraphs[i])) {
      changedIndices.push(i);
    }
  }

  if (changedIndices.length === 0) {
    return { hasChanges: false, changedSections: [], summary: 'No changes detected' };
  }

  // Extract changed paragraphs with surrounding context
  const sections: string[] = [];
  const visited = new Set<number>();

  for (const idx of changedIndices) {
    const start = Math.max(0, idx - contextLines);
    const end = Math.min(newParagraphs.length - 1, idx + contextLines);

    const section: string[] = [];
    for (let i = start; i <= end; i++) {
      if (!visited.has(i)) {
        visited.add(i);
        const marker = changedIndices.includes(i) ? '>>> CHANGED: ' : '';
        section.push(`${marker}${newParagraphs[i]}`);
      }
    }

    if (section.length > 0) {
      sections.push(section.join('\n\n'));
    }
  }

  return {
    hasChanges: true,
    changedSections: sections,
    summary: `${changedIndices.length} paragraph(s) changed or added`,
  };
}
