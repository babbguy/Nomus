#!/usr/bin/env node
// Dry-runs `npm pack` for each workspace given and checks that the tarball
// contains every file its package.json points at (main, types, bin, exports)
// plus README.md and LICENSE. Build the packages first. Exits 1 on a miss.
//
//   node scripts/check-pack.mjs packages/scanner packages/mcp-server

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspaces = process.argv.slice(2);
if (!workspaces.length) {
  console.error('usage: node scripts/check-pack.mjs <workspace>...');
  process.exit(1);
}

// Every string value under main/types/bin/exports is a path into the package.
function entryPoints(pkg) {
  const out = [];
  const walk = (v) => {
    if (typeof v === 'string') out.push(v);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  [pkg.main, pkg.types, pkg.bin, pkg.exports].forEach(walk);
  return out.map((p) => path.posix.normalize(p));
}

let failed = false;
for (const ws of workspaces) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, ws, 'package.json'), 'utf8'));
  const [result] = JSON.parse(execSync(`npm pack --dry-run --json --workspace=${ws}`, {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }));
  const files = new Set(result.files.map((f) => f.path));
  const missing = [...new Set([...entryPoints(pkg), 'README.md', 'LICENSE'])].filter((f) => !files.has(f));
  if (missing.length) {
    failed = true;
    for (const f of missing) console.error(`::error file=${ws}/package.json::${result.filename} is missing ${f}`);
  } else {
    console.log(`${result.filename}: ${result.entryCount} files, ${result.size} bytes, entry points present`);
  }
}
process.exit(failed ? 1 : 0);
