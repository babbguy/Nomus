// Builds the npm package: esbuild bundles the code and tsc emits the type
// declarations. @nomus/shared is a private workspace package, so it is inlined;
// every package in "dependencies" stays external and is installed from npm.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import * as esbuild from 'esbuild';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const external = Object.keys(pkg.dependencies).flatMap((name) => [name, `${name}/*`]);

fs.rmSync('dist', { recursive: true, force: true });

await esbuild.build({
  entryPoints: ['src/index.ts', 'src/server.ts'],
  outdir: 'dist',
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  external,
  logLevel: 'warning',
});

const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
execFileSync(process.execPath, [tsc, '-p', 'tsconfig.build.json'], { stdio: 'inherit' });
