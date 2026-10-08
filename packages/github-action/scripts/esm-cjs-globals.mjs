// Copyright 2026 babbguy
// SPDX-License-Identifier: Apache-2.0

// ncc emits dist/index.js as an ES module (dist/package.json has
// "type": "module"), but the bundled TypeScript compiler, which the scanner's
// SDK-usage detector uses to parse JS/TS, reads the CommonJS globals
// `__filename` and `__dirname` when it initialises. In an ES module those are
// undefined, so the action crashed on load with
// "ReferenceError: __filename is not defined in ES module scope" before
// scanning anything. Define them at the top of the bundle.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER = '/* nomus: CommonJS globals for bundled CJS code */';
const SHIM = [
  MARKER,
  "import { fileURLToPath as __nomusFileURLToPath } from 'node:url';",
  "import { dirname as __nomusDirname } from 'node:path';",
  'const __filename = __nomusFileURLToPath(import.meta.url);',
  'const __dirname = __nomusDirname(__filename);',
  '',
].join('\n');

const bundle = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const source = readFileSync(bundle, 'utf8');
if (!source.includes(MARKER)) {
  writeFileSync(bundle, SHIM + source);
}
