#!/usr/bin/env node
// Checks that every package in the workspace carries the same version, and
// that package-lock.json agrees. With a tag (v1.2.0), also checks that the tag
// names that version. Prints the version; exits 1 on any mismatch.
//
//   node scripts/check-version.mjs          all packages agree
//   node scripts/check-version.mjs v1.2.0   ...and the tag matches them

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));

const rootPkg = readJson('package.json');
const lock = readJson('package-lock.json');
const version = rootPkg.version;

// Workspace directories, from the root package.json globs ("packages/*", "engine").
const workspaces = rootPkg.workspaces.flatMap((pattern) => {
  if (!pattern.endsWith('/*')) return [pattern];
  const dir = pattern.slice(0, -2);
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(root, dir, e.name, 'package.json')))
    .map((e) => `${dir}/${e.name}`);
});

const found = [
  ['package.json', version],
  ['package-lock.json', lock.version],
  ['package-lock.json packages[""]', lock.packages['']?.version],
  ...workspaces.flatMap((ws) => [
    [`${ws}/package.json`, readJson(`${ws}/package.json`).version],
    [`package-lock.json packages["${ws}"]`, lock.packages[ws]?.version],
  ]),
];

const errors = found
  .filter(([, v]) => v !== version)
  .map(([where, v]) => `${where} has version ${v ?? '(none)'}, expected ${version}`);

const tag = process.argv[2];
if (tag !== undefined && tag !== `v${version}`) {
  errors.push(`tag ${tag} does not match the package version ${version} (expected v${version})`);
}

if (errors.length) {
  for (const e of errors) console.error(`::error::${e}`);
  process.exit(1);
}
console.log(version);
