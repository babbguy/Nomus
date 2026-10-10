// Copyright 2026 babbguy
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CorporateFinding } from '../match/rule-matcher.js';
import type { FindingResolution } from '../corporate/contracts.js';
import { corporateStatusText } from './reporter.js';

/**
 * SARIF for corporate policy findings (design spec §11.4): its own run,
 * with the Code Scanning category `nomus-corporate/`, so the regulatory run
 * and its upload are untouched. Results carry the region and the
 * fingerprint, never the snippet text.
 */

type SarifLevel = 'error' | 'warning' | 'note' | 'none';

export const CORPORATE_SARIF_CATEGORY = 'nomus-corporate/';
export const CORPORATE_SARIF_TOOL = 'Nomus Corporate Policy';

export interface CorporateSarifRule {
  id: string;
  shortDescription: { text: string };
  fullDescription: { text: string };
  helpUri?: string;
  defaultConfiguration: { level: SarifLevel };
  properties: { tags: string[] };
}

export interface CorporateSarifResult {
  ruleId: string;
  level: SarifLevel;
  message: { text: string };
  locations: Array<{
    physicalLocation: {
      artifactLocation: { uri: string; uriBaseId: string };
      region: { startLine: number; endLine: number; startColumn: number };
    };
  }>;
  partialFingerprints: { 'nomusCorporate/v1': string };
  suppressions?: Array<{ kind: 'external'; status: 'accepted'; justification: string }>;
  properties: { tier: string; status: string; blocking: boolean; policyVersion: number; enforceFrom: string };
}

export interface CorporateSarifRun {
  tool: { driver: { name: string; version: string; informationUri: string; rules: CorporateSarifRule[] } };
  automationDetails: { id: string };
  results: CorporateSarifResult[];
}

export interface CorporateSarifOptions {
  /** Dashboard origin; when set, each rule links to its policy page. */
  dashboardUrl?: string;
  /**
   * The server's resolution of a finding (the CI gate, E61). It replaces the
   * local status; approved and excepted findings are suppressed with the
   * decision that covers them.
   */
  resolutionOf?: (f: CorporateFinding) => FindingResolution | undefined;
  /** The review case, linked from every result. */
  caseUrl?: string | null;
}

function scannerVersion(): string {
  try {
    const dir = typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url));
    return JSON.parse(readFileSync(resolve(dir, '..', '..', 'package.json'), 'utf-8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** A server-side decision covering the finding, as a SARIF suppression. */
function suppressionOf(r: FindingResolution | undefined): CorporateSarifResult['suppressions'] {
  if (r?.status !== 'approved' && r?.status !== 'excepted') return undefined;
  const what = r.status === 'approved' ? `Approved by Nomus decision ${r.decisionId}` : `Excepted by Nomus standing exception ${r.exceptionDecisionId}`;
  return [{ kind: 'external', status: 'accepted', justification: `${what}${r.expiresAt ? ` until ${r.expiresAt}` : ''}` }];
}

/** The policy page in the dashboard, or undefined when no dashboard origin is known. */
export function policyPageUrl(dashboardUrl: string | undefined, policyId: string): string | undefined {
  if (!dashboardUrl) return undefined;
  return `${dashboardUrl.replace(/\/+$/, '')}/governance/policies/${policyId}`;
}

/** The corporate SARIF run (one per scan, appended after the regulatory run by the CLI). */
export function formatCorporateSarifRun(findings: readonly CorporateFinding[], options: CorporateSarifOptions = {}): CorporateSarifRun {
  const rules = new Map<string, CorporateSarifRule>();
  for (const f of findings) {
    if (rules.has(f.policyKey)) continue;
    const helpUri = policyPageUrl(options.dashboardUrl, f.rule.policyId);
    rules.set(f.policyKey, {
      id: f.policyKey,
      shortDescription: { text: f.rule.title },
      fullDescription: { text: f.rule.message },
      ...(helpUri ? { helpUri } : {}),
      defaultConfiguration: { level: f.tier === 'advisory' ? 'note' : 'error' },
      properties: { tags: ['corporate-policy', f.tier] },
    });
  }
  return {
    tool: {
      driver: {
        name: CORPORATE_SARIF_TOOL,
        version: scannerVersion(),
        informationUri: 'https://github.com/babbguy/Nomus',
        rules: [...rules.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      },
    },
    automationDetails: { id: CORPORATE_SARIF_CATEGORY },
    results: findings.map((f) => {
      const r = options.resolutionOf?.(f);
      const blocking = r?.blocking ?? f.blocking;
      const statusText = r ? r.status.replace(/_/g, ' ') : corporateStatusText(f);
      const suppressions = suppressionOf(r);
      return {
        ruleId: f.policyKey,
        // Blocking findings are errors; advisory, grace-period, approved and excepted ones are notes.
        level: blocking ? 'error' : 'note',
        message: { text: `${f.rule.title} (${f.policyKey} v${f.policyVersion}): ${f.rule.message} Status: ${statusText}.${options.caseUrl ? ` Review case: ${options.caseUrl}` : ''}` },
        locations: [{
          physicalLocation: {
            artifactLocation: { uri: f.filePath, uriBaseId: '%SRCROOT%' },
            region: { startLine: f.startLine, endLine: f.endLine, startColumn: 1 },
          },
        }],
        partialFingerprints: { 'nomusCorporate/v1': f.fingerprint },
        ...(suppressions ? { suppressions } : {}),
        properties: { tier: f.tier, status: r?.status ?? f.status, blocking, policyVersion: f.policyVersion, enforceFrom: f.enforceFrom },
      };
    }),
  };
}

/** A SARIF 2.1.0 log holding only the corporate run: the GitHub Action uploads it on its own (§11.4). */
export function formatCorporateSarif(findings: readonly CorporateFinding[], options: CorporateSarifOptions = {}) {
  return {
    $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/Schemata/sarif-schema-2.1.0.json',
    version: '2.1.0' as const,
    runs: [formatCorporateSarifRun(findings, options)],
  };
}
