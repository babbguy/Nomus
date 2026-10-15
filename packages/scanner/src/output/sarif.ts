import { relative } from 'node:path';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Finding } from '../match/rule-matcher.js';

function getScannerVersion(): string {
  try {
    // Resolve relative to this file's location (works in both src and dist)
    const dir = typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url));
    const pkgPath = resolve(dir, '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** SARIF 2.1.0 severity levels recognized by GitHub Code Scanning */
type SarifLevel = 'error' | 'warning' | 'note' | 'none';

interface SarifLog {
  $schema: string;
  version: string;
  runs: SarifRun[];
}

interface SarifRun {
  tool: { driver: SarifDriver };
  results: SarifResult[];
}

interface SarifDriver {
  name: string;
  version: string;
  informationUri: string;
  rules: SarifRule[];
}

interface SarifRule {
  id: string;
  shortDescription: { text: string };
  fullDescription: { text: string };
  helpUri: string;
  defaultConfiguration: { level: SarifLevel };
  properties: { tags: string[] };
}

interface SarifResult {
  ruleId: string;
  level: SarifLevel;
  message: { text: string };
  locations: SarifLocation[];
  /**
   * Remediation guidance. Not emitted as a SARIF `fix`: the 2.1.0 schema
   * requires `fix.artifactChanges` (concrete replacements), and GitHub Code
   * Scanning rejects uploads whose fixes lack them.
   */
  properties?: { suggestion: string };
}

interface SarifLocation {
  physicalLocation: {
    artifactLocation: { uri: string; uriBaseId: string };
    region: { startLine: number; startColumn: number };
  };
}

function mapSeverityToLevel(severity: string): SarifLevel {
  switch (severity) {
    case 'critical':
    case 'high':
      return 'error';
    case 'medium':
      return 'warning';
    case 'low':
      return 'note';
    default:
      return 'none';
  }
}

function mapEffectToTags(effect: string): string[] {
  const tags = ['security', 'regulatory', 'ai-regulation'];
  switch (effect) {
    case 'deny':
      tags.push('prohibited');
      break;
    case 'require_disclosure':
      tags.push('transparency');
      break;
    case 'allow_with_audit':
      tags.push('audit-required');
      break;
    case 'flag':
      tags.push('advisory');
      break;
  }
  return tags;
}

/**
 * Convert Nomus findings to SARIF 2.1.0 format.
 * Compatible with GitHub Code Scanning, VS Code SARIF Viewer, and other SARIF consumers.
 */
export function formatSarifReport(findings: Finding[], rootDir: string): SarifLog {
  // Build unique rules map
  const rulesMap = new Map<string, SarifRule>();
  for (const f of findings) {
    if (!rulesMap.has(f.rule.ruleKey)) {
      rulesMap.set(f.rule.ruleKey, {
        id: f.rule.ruleKey,
        shortDescription: { text: f.rule.humanSummary },
        fullDescription: { text: `${f.rule.humanSummary} [${f.rule.legalReference}]` },
        helpUri: 'https://github.com/babbguy/Nomus/tree/main/docs',
        defaultConfiguration: { level: mapSeverityToLevel(f.rule.severity) },
        properties: { tags: mapEffectToTags(f.rule.effect) },
      });
    }
  }

  // Build results
  const results: SarifResult[] = findings.map((f) => {
    const relPath = relative(rootDir, f.file).replace(/\\/g, '/');
    const result: SarifResult = {
      ruleId: f.rule.ruleKey,
      level: mapSeverityToLevel(f.rule.severity),
      message: {
        text: `${f.rule.humanSummary}\n\nRegulation: ${f.rule.legalReference}\nSDK: ${f.sdk}\nDetector: ${f.detectorSource}\nEvidence: ${f.evidence}\nEffect: ${f.rule.effect}\nConfidence: ${Math.round(f.rule.confidence * 100)}%`,
      },
      locations: [{
        physicalLocation: {
          artifactLocation: { uri: relPath, uriBaseId: '%SRCROOT%' },
          region: { startLine: f.line, startColumn: 1 },
        },
      }],
    };

    if (f.suggestion) {
      result.properties = { suggestion: f.suggestion };
    }

    return result;
  });

  return {
    $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/Schemata/sarif-schema-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: {
        driver: {
          name: 'Nomus',
          version: getScannerVersion(),
          informationUri: 'https://github.com/babbguy/Nomus',
          rules: Array.from(rulesMap.values()),
        },
      },
      results,
    }],
  };
}

export {
  formatCorporateSarif, formatCorporateSarifRun, CORPORATE_SARIF_CATEGORY, CORPORATE_SARIF_TOOL,
  type CorporateSarifOptions, type CorporateSarifRun,
} from './sarif-corporate.js';
