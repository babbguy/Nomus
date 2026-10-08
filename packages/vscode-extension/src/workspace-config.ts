import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Config file names the scanner recognises, in its own precedence order. */
const CONFIG_FILES = ['.nomus.yml', '.nomus.yaml', '.nomus.json'];

export interface WorkspaceScanConfig {
  jurisdictions: string[];
  api_key?: string;
  api_url?: string;
  sector?: string;
  data_types?: string[];
  ignore?: string[];
}

/** Thrown when the workspace has a Nomus config file that cannot be used. */
export class WorkspaceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceConfigError';
  }
}

/**
 * Load the workspace's `.nomus.yml` (or `.yaml` / `.json`) with the scanner's
 * own loader, so the editor scans with the same jurisdictions, sector, data
 * types and ignore rules as the CLI and the GitHub Action.
 *
 * The API key and API URL always come from the extension (sign-in / settings).
 * Returns undefined when the workspace has no config file; throws
 * WorkspaceConfigError when the file exists but is invalid.
 */
export async function loadWorkspaceConfig(
  rootDir: string,
  apiKey: string | undefined,
  apiUrl: string,
): Promise<WorkspaceScanConfig | undefined> {
  if (!CONFIG_FILES.some((name) => existsSync(join(rootDir, name)))) return undefined;

  try {
    const { loadConfig } = await import('@nomus/scanner/config');
    const { nomus } = loadConfig(rootDir);
    return {
      jurisdictions: nomus.jurisdictions,
      api_key: apiKey || undefined,
      api_url: apiUrl,
      sector: nomus.sector,
      data_types: nomus.data_types,
      ignore: nomus.ignore,
    };
  } catch (err) {
    throw new WorkspaceConfigError(err instanceof Error ? err.message : String(err));
  }
}
