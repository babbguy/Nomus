/**
 * ImportDetector — the v1 detector plugin.
 *
 * Wraps the existing import detection + capability mapping logic
 * into the DetectorPlugin interface. This is what ships today.
 */

import { detectImportsInFile, detectImportsInContent } from './imports.js';
import { mapCapabilities } from './capabilities.js';
import type { DetectorPlugin, DetectorContext, DetectorSignal } from './detector.js';

export class ImportDetector implements DetectorPlugin {
  readonly name = 'import-detector';
  readonly description = 'Detects AI SDK imports and infers capabilities from SDK presence';
  readonly version = '1.0.0';

  async detect(ctx: DetectorContext): Promise<DetectorSignal[]> {
    // Detect imports — either from filesystem or in-memory contents
    const imports = ctx.fileContents
      ? Array.from(ctx.fileContents.entries()).flatMap(
          ([filePath, content]) => detectImportsInContent(content, filePath),
        )
      : ctx.files.flatMap(detectImportsInFile);

    if (imports.length === 0) return [];

    // Map imports to capabilities
    const capabilities = mapCapabilities(imports);
    const capsBySDK = new Map(capabilities.map((c) => [c.sdk, c.capabilities]));

    // Convert to DetectorSignal[]
    return imports.map((imp) => ({
      source: this.name,
      file: imp.file,
      line: imp.line,
      target: imp.sdk,
      capabilities: capsBySDK.get(imp.sdk) ?? ['unknown'],
      confidence: 1.0, // Import detection is binary — it's there or it isn't
      evidence: imp.importStatement,
      metadata: { language: imp.language },
    }));
  }
}
