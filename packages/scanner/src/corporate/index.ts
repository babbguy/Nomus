/**
 * `@nomus/scanner/corporate`: the pure Corporate Policy Governance library
 * shared by the engine, the VS Code extension and the GitHub Action (design
 * spec §0). Rule schema and vocabularies, glob and regex safety, the
 * deterministic matcher, the fingerprint, repository and language helpers,
 * and the client contracts with the signed-bundle client.
 *
 * Only contracts.ts and bundle-client.ts deal with the network; the matcher
 * and everything it imports are pure (corporate.test.ts checks the imports).
 */
export * from './vocab.js';
export * from './glob.js';
export * from './regex-safety.js';
export * from './rule-schema.js';
export * from './languages.js';
export * from './repo.js';
export * from './fingerprint.js';
export * from './canonical.js';
export * from './matcher.js';
export * from './contracts.js';
export * from './bundle-client.js';
export { NomusApiError, isNomusApiError } from '../errors.js';
/** The detectors skip test files; the compile step explains that when an example misses. */
export { isTestFile } from '../detect/file-content.js';
