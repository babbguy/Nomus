#!/usr/bin/env node
// Prints the CHANGELOG.md section for a release version (the GitHub release
// notes).
//
//   node scripts/release-notes.mjs 1.2.0 [--images]
//
// Exits 1 when the version has no section or the section is empty, so a
// release never goes out with missing notes. --images appends the docker pull
// commands for the published container images.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CHANGELOG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'CHANGELOG.md');
const IMAGES = ['nomus-engine', 'nomus-dashboard'];

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (args.length !== 1) fail('usage: node scripts/release-notes.mjs <version> [--images]');
const version = args[0].replace(/^v/, '');

const text = fs.readFileSync(CHANGELOG, 'utf8').replace(/\r\n/g, '\n');
const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const heading = new RegExp(`^## \\[${escaped}\\][^\\n]*$`, 'm').exec(text);
if (!heading) fail(`CHANGELOG.md has no section for ${version}`);

const rest = text.slice(heading.index + heading[0].length);
const next = /^## \[/m.exec(rest);
let notes = (next ? rest.slice(0, next.index) : rest).trim();
if (!notes) fail(`CHANGELOG.md section for ${version} is empty`);

if (process.argv.includes('--images')) {
  const pulls = IMAGES.map((name) => `docker pull ghcr.io/babbguy/${name}:${version}`).join('\n');
  notes += `\n\n### Container images\n\n\`\`\`\n${pulls}\n\`\`\``;
}
process.stdout.write(`${notes}\n`);
