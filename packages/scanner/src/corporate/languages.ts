import type { Language } from './vocab.js';

/**
 * File language for corporate rule scoping (`files.languages`) and for the
 * `language` of a finding. Decided by extension only, so it is deterministic
 * and identical in the CLI, the editor and CI.
 */
const EXTENSIONS: Array<[RegExp, Language]> = [
  [/\.(ts|tsx|mts|cts)$/i, 'typescript'],
  [/\.(js|jsx|mjs|cjs)$/i, 'javascript'],
  [/\.(py|pyi)$/i, 'python'],
  [/\.java$/i, 'java'],
  [/\.go$/i, 'go'],
];

export function languageOf(path: string): Language {
  for (const [re, lang] of EXTENSIONS) if (re.test(path)) return lang;
  return 'other';
}
