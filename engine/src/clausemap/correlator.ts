/**
 * Clause Map correlator.
 *
 * Evaluates every active clause mapping's heuristic signature against the
 * findings of one scan upload and persists clause matches. Runs inline in
 * the scan-upload path (SQLite, synchronous, tens of mappings — cheap).
 *
 * Learning happens on every scan in three auditable ways:
 *   1. evaluated/fired counters accumulate per mapping (dataset telemetry);
 *   2. match confidence = live posterior × evidence strength, so mappings
 *      the org has dismissed surface with visibly lower confidence;
 *   3. a mapping that previously produced a DISMISSED match for the same
 *      (org, repo, file) is suppressed instead of re-opened — the engine
 *      remembers the org's verdict, and the suppression itself is logged
 *      as a clause_learning_event.
 */

import { randomUUID } from 'node:crypto';
import { eq, and, inArray } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { clauseMappings, clauseMatches, clauseLearningEvents } from '../db/schema.js';
import type { HeuristicSignature, SignalRequirement } from './dataset.js';

/** The slice of a scan finding the correlator needs. */
export interface CorrelatableFinding {
  id: string;
  filePath: string;
  lineNumber: number;
  capability: string;
  detectorSource: string | null;
  severity: 'critical' | 'high' | 'medium' | 'low';
}

export interface EvidenceEntry {
  findingId: string;
  capability: string;
  detector: string | null;
  line: number;
  severity: string;
}

export interface CorrelationResult {
  created: number;
  suppressed: number;
  evaluated: number;
}

const SEVERITY_WEIGHT: Record<CorrelatableFinding['severity'], number> = {
  critical: 1.0,
  high: 0.9,
  medium: 0.75,
  low: 0.6,
};

function satisfies(finding: CorrelatableFinding, req: SignalRequirement): boolean {
  const caps = [req.capability, ...(req.anyOf ?? [])];
  if (!caps.includes(finding.capability)) return false;
  if (req.detector && finding.detectorSource !== req.detector) return false;
  return true;
}

/**
 * Evaluate one signature against the findings of one file.
 * Returns the supporting findings (one per requirement, first match wins,
 * proximity-constrained when maxLineDistance is set) or null.
 */
export function evaluateSignature(
  signature: HeuristicSignature,
  fileFindings: CorrelatableFinding[],
): CorrelatableFinding[] | null {
  const chosen: CorrelatableFinding[] = [];
  for (const req of signature.requires) {
    const candidates = fileFindings.filter((f) => satisfies(f, req));
    if (candidates.length === 0) return null;

    if (signature.maxLineDistance != null && chosen.length > 0) {
      const anchor = chosen[0].lineNumber;
      const near = candidates.find(
        (f) => Math.abs(f.lineNumber - anchor) <= signature.maxLineDistance!,
      );
      if (!near) return null;
      chosen.push(near);
    } else {
      chosen.push(candidates[0]);
    }
  }
  return chosen;
}

/** Evidence strength = strongest severity among supporting findings. */
function evidenceStrength(evidence: CorrelatableFinding[]): number {
  return Math.max(...evidence.map((f) => SEVERITY_WEIGHT[f.severity]));
}

/**
 * Correlate one scan upload. Findings must all belong to (orgId, repo,
 * commitSha). Idempotent per file: an existing open/confirmed match for
 * (org, repo, mapping, file) is not duplicated; a dismissed one suppresses
 * re-creation.
 */
export function correlateScan(
  db: BetterSQLite3Database<Record<string, unknown>>,
  orgId: string,
  repo: string,
  commitSha: string,
  findings: CorrelatableFinding[],
): CorrelationResult {
  const now = new Date().toISOString();
  const mappings = db
    .select()
    .from(clauseMappings)
    .where(eq(clauseMappings.isActive, true))
    .all();
  if (mappings.length === 0 || findings.length === 0) {
    return { created: 0, suppressed: 0, evaluated: mappings.length };
  }

  const byFile = new Map<string, CorrelatableFinding[]>();
  for (const f of findings) {
    const list = byFile.get(f.filePath) ?? [];
    list.push(f);
    byFile.set(f.filePath, list);
  }

  // Prior verdicts for dedup/suppression, one query up front.
  const priorMatches = db
    .select({
      mappingId: clauseMatches.mappingId,
      filePath: clauseMatches.filePath,
      status: clauseMatches.status,
    })
    .from(clauseMatches)
    .where(
      and(
        eq(clauseMatches.orgId, orgId),
        eq(clauseMatches.repo, repo),
        inArray(clauseMatches.mappingId, mappings.map((m) => m.id)),
      ),
    )
    .all();
  const priorByKey = new Map<string, string>();
  for (const p of priorMatches) {
    // Dismissed wins over any other prior status for the same key
    const key = `${p.mappingId}::${p.filePath}`;
    const existing = priorByKey.get(key);
    if (existing !== 'dismissed') priorByKey.set(key, p.status);
  }

  let created = 0;
  let suppressed = 0;

  for (const mapping of mappings) {
    let signature: HeuristicSignature;
    try {
      signature = JSON.parse(mapping.heuristicJson) as HeuristicSignature;
    } catch {
      continue; // corrupt heuristic must never fail a scan
    }

    let firedThisScan = false;

    for (const [filePath, fileFindings] of byFile) {
      const evidence = evaluateSignature(signature, fileFindings);
      if (!evidence) continue;
      firedThisScan = true;

      const priorStatus = priorByKey.get(`${mapping.id}::${filePath}`);
      if (priorStatus === 'dismissed') {
        // The org already ruled this mapping out here — remember that.
        suppressed++;
        db.insert(clauseLearningEvents).values({
          mappingId: mapping.id,
          eventType: 'scan_suppressed',
          orgId,
          posteriorBefore: mapping.posterior,
          posteriorAfter: mapping.posterior,
          detailsJson: JSON.stringify({ repo, filePath, commitSha }),
          createdAt: now,
        }).run();
        continue;
      }
      if (priorStatus === 'open' || priorStatus === 'confirmed') continue; // already tracked

      const confidence = mapping.posterior * evidenceStrength(evidence);
      const evidenceJson: EvidenceEntry[] = evidence.map((f) => ({
        findingId: f.id,
        capability: f.capability,
        detector: f.detectorSource,
        line: f.lineNumber,
        severity: f.severity,
      }));

      const matchId = randomUUID();
      db.insert(clauseMatches).values({
        id: matchId,
        orgId,
        mappingId: mapping.id,
        repo,
        commitSha,
        filePath,
        lineNumber: evidence[0].lineNumber,
        evidenceJson: JSON.stringify(evidenceJson),
        confidence,
        status: 'open',
        matchedAt: now,
      }).run();
      priorByKey.set(`${mapping.id}::${filePath}`, 'open');
      created++;

      db.insert(clauseLearningEvents).values({
        mappingId: mapping.id,
        eventType: 'scan_fired',
        orgId,
        matchId,
        posteriorBefore: mapping.posterior,
        posteriorAfter: mapping.posterior,
        detailsJson: JSON.stringify({ repo, filePath, commitSha, confidence }),
        createdAt: now,
      }).run();
    }

    db.update(clauseMappings)
      .set({
        evaluatedCount: mapping.evaluatedCount + 1,
        firedCount: mapping.firedCount + (firedThisScan ? 1 : 0),
        updatedAt: now,
      })
      .where(eq(clauseMappings.id, mapping.id))
      .run();
  }

  return { created, suppressed, evaluated: mappings.length };
}
