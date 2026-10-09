/**
 * Repository-pattern globs for team scoping (design spec §7.1).
 *
 * Phase 1 carried an engine-local copy of the glob engine; it is now the one
 * implementation in `@nomus/scanner/corporate` (shared with corporate rule
 * file scopes and, later, standing-exception patterns). This module keeps the
 * engine's import path stable.
 */
export {
  compileGlob,
  globMatches,
  InvalidGlobError,
  MAX_GLOB_LENGTH,
  MAX_GLOBS_PER_LIST,
  repoPatternError,
} from '@nomus/scanner/corporate';
