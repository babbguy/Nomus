// The bundled action ships only dist/index.js. The .d.ts.map files ncc emits
// alongside it embed absolute build-machine paths, which
// would be published verbatim in a public action repo. Strip them after every
// build, and drop the now-dangling sourceMappingURL comments from the .d.ts.
import { readdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

for (const file of readdirSync(dist)) {
  if (file.endsWith('.d.ts.map')) {
    rmSync(join(dist, file));
  } else if (file.endsWith('.d.ts')) {
    const path = join(dist, file);
    const stripped = readFileSync(path, 'utf8').replace(
      /^\/\/# sourceMappingURL=.*\.d\.ts\.map\s*$/m,
      '',
    );
    writeFileSync(path, stripped.trimEnd() + '\n');
  }
}
