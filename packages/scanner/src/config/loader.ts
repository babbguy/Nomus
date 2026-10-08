import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { nomusConfigSchema, type NomusConfig } from './schema.js';

/**
 * Load .nomus.yml from the repository root.
 * Falls back to .nomus.yaml, then .nomus.json.
 */
export function loadConfig(rootDir: string): NomusConfig {
  const candidates = ['.nomus.yml', '.nomus.yaml', '.nomus.json'];

  for (const filename of candidates) {
    const filepath = resolve(rootDir, filename);
    if (existsSync(filepath)) {
      const raw = readFileSync(filepath, 'utf-8');

      let parsed: unknown;
      if (filename.endsWith('.json')) {
        try {
          parsed = JSON.parse(raw);
        } catch (e) {
          throw new Error(`Invalid JSON in ${filename}: ${(e as Error).message}`);
        }
      } else {
        parsed = parseYamlConfig(raw, filename);
      }

      const result = nomusConfigSchema.safeParse(parsed);
      if (!result.success) {
        const messages = result.error.issues.map(
          (issue) => `  ${issue.path.join('.')}: ${issue.message}`,
        );
        throw new Error(
          `Invalid ${filename}:\n${messages.join('\n')}`,
        );
      }

      // Override api_key from env if not in config
      if (!result.data.nomus.api_key) {
        result.data.nomus.api_key = process.env.NOMUS_API_KEY;
      }

      return result.data;
    }
  }

  throw new Error(
    'No .nomus.yml found. Create one in your repository root.\nSee: https://github.com/babbguy/Nomus/tree/main/packages/scanner',
  );
}

/**
 * Parse .nomus.yml. Values written as `$NAME` (the whole value) are replaced
 * with the environment variable NAME, and an unset variable is an error.
 */
function parseYamlConfig(source: string, filename: string): unknown {
  let doc: unknown;
  try {
    doc = parseYaml(source);
  } catch (e) {
    throw new Error(`Invalid YAML in ${filename}: ${(e as Error).message}`);
  }
  return expandEnvRefs(doc, filename);
}

function expandEnvRefs(value: unknown, filename: string): unknown {
  if (typeof value === 'string' && /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    const envName = value.slice(1);
    const envValue = process.env[envName];
    if (envValue === undefined) {
      throw new Error(
        `Environment variable ${envName} is not set (referenced in ${filename} as ${value})`,
      );
    }
    return envValue;
  }
  if (Array.isArray(value)) return value.map((v) => expandEnvRefs(v, filename));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, expandEnvRefs(v, filename)]),
    );
  }
  return value;
}
