/**
 * PhiPatternDetector — Phase 3c.
 *
 * Detects PHI/PII data format patterns and variable name patterns in source code.
 * Pure regex + heuristics, zero external dependencies.
 *
 * Emits capabilities:
 *   contains_phi, contains_pii, contains_financial,
 *   logs_phi, logs_pii,
 *   phi_in_ai_call, pii_in_ai_call
 *
 * Capabilities are designed to match the conditions.action values in
 * seed-phase3-rules.ts so HIPAA / GDPR / PCI DSS rules fire correctly.
 */

import type { DetectorPlugin, DetectorContext, DetectorSignal } from './detector.js';
import { iterFiles, isTestFile, stripComments } from './file-content.js';

interface PatternHit {
  category: 'phi' | 'pii' | 'financial';
  label: string;
  line: number;
  evidence: string;
}

// ─── Data format patterns ────────────────────────────────────────────
// Each pattern is conservative — false positive cost > false negative cost.

const SSN = /\b(?!000|666|9\d{2})\d{3}[- ](?!00)\d{2}[- ](?!0000)\d{4}\b/;
// Luhn-validated credit card numbers — 13-19 digits, common prefixes
const CC_CANDIDATE = /\b(?:\d[ -]?){13,19}\b/g;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const PHONE_US = /\b(?:\+?1[-. ]?)?\(?\d{3}\)?[-. ]?\d{3}[-. ]?\d{4}\b/;
const DOB = /\b(?:19|20)\d{2}[-/](?:0[1-9]|1[0-2])[-/](?:0[1-9]|[12]\d|3[01])\b/;
// MRN: medical record numbers — typically MRN: <digits> or "mrn"="..."
const MRN_LABELED = /\bMRN[\s:=]+["']?(\d{4,})/i;
// IPv4 (RFC1918 + public)
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;

// ─── Variable name patterns (PHI) ────────────────────────────────────
//
// Each entry is a "stem" identifier. To fire, the stem must appear in an
// assignment / declaration / key / parameter context — bare references in
// arbitrary code do NOT count. This is enforced by `inDeclarationContext`.
const PHI_VAR_STEMS = [
  'patient_?id',
  'patient_?name',
  'medical_?record',
  'medical_?history',
  'medical_?id',
  'phi',
  'protected_?health',
  'health_?record',
  'icd_?10',
  'cpt_?code',
  'diagnosis_?code',
  'prescription_?id',
];

// ─── Variable name patterns (PII) ────────────────────────────────────
//
// Words removed from this list because they were too ambiguous and produced
// systemic false positives:
//   - `passport` (Passport.js), `tin` (English word), `nino` (a person's name),
//     `sin` (Math.sin, single-letter), `dob` standalone (often used elsewhere)
//
// PHONE-related identifiers and bare `firstName`/`lastName` are removed because
// they appear in nearly every web app. They're recovered via the data-format
// detectors (SSN regex, phone regex) instead.
const PII_VAR_STEMS = [
  'ssn',
  'social_?security_?number',
  'date_?of_?birth',
  'birth_?date',
  'drivers_?license_?number',
  'passport_?number',
  'national_?insurance_?number',
  'tax_?id_?number',
  'home_?address',
  'street_?address',
  'mailing_?address',
];

// ─── Variable name patterns (Financial / PCI) ────────────────────────
//
// `pan`, `bic`, `cvv2` removed — too short/generic. We require fuller stems.
const FIN_VAR_STEMS = [
  'credit_?card_?number',
  'credit_?card_?num',
  'card_?number',
  'card_?cvv',
  'card_?cvc',
  'account_?number',
  'routing_?number',
  'iban_?number',
  'swift_?code',
  'cc_?num(?:ber)?',
];

function buildVarRegex(stems: string[]): RegExp {
  // Match the stem when it appears as a:
  //   - declaration:  const/let/var/val NAME
  //   - assignment:   NAME =
  //   - object key:   NAME: or "NAME":
  //   - function param: (NAME, NAME, ...)
  //   - field decl:   NAME [:type]?
  // Captures the identifier in group 1.
  const stemPattern = `(?:${stems.join('|')})`;
  // Look for the stem possibly prefixed (e.g. patient_id, my_patient_id)
  // and require an immediate trailing context that signals declaration.
  return new RegExp(
    [
      // const|let|var|val|static|public|private|protected|readonly|final NAME
      String.raw`\b(?:const|let|var|val|static|public|private|protected|readonly|final|def|self\.)\s+(\w*${stemPattern})\b`,
      // assignment:  NAME =
      String.raw`\b(\w*${stemPattern})\s*[:=]`,
      // object key:  "NAME":
      String.raw`["'](\w*${stemPattern})["']\s*:`,
    ].join('|'),
    'i',
  );
}

const PHI_VAR_RE = buildVarRegex(PHI_VAR_STEMS);
const PII_VAR_RE = buildVarRegex(PII_VAR_STEMS);
const FIN_VAR_RE = buildVarRegex(FIN_VAR_STEMS);

// DOB context: only fire on a date format if there's a DOB-related label
// on the same line. Avoids matching every ISO timestamp in a codebase.
const DOB_CONTEXT_RE = /\b(?:dob|date_?of_?birth|birth_?date|birthday|birth_?day)\b/i;

// ─── AI SDK call markers ─────────────────────────────────────────────
// Must look like a method call, not just a bare SDK identifier — otherwise
// `import OpenAI from "openai"` would falsely indicate an active call.
const AI_CALL_RE = new RegExp(
  [
    // namespace.method(
    /\b(?:openai|anthropic|cohere|replicate|huggingface|hf|bedrock|gemini|generativeai|vertexai|claude|genai|BedrockRuntime|GenerativeModel)\s*\.\s*[a-zA-Z_]\w*\s*\(/.source,
    // chat.completions.create( style
    /\b(?:messages|completions|embeddings|chat\.completions|images|audio|moderations)\.create\s*\(/.source,
    // standalone Python helpers
    /\b(?:generate_content|invoke_model|generateContent|invokeModel)\s*\(/.source,
  ].join('|'),
  'i',
);

// ─── Log call markers ────────────────────────────────────────────────
const LOG_CALL_RE = /\b(?:console\.(?:log|info|warn|error|debug)|logger?\.(?:info|warn|error|debug|log)|print|printf|println|System\.out\.print|fmt\.(?:Print|Println))\b/;

// ─── False-positive suppression ──────────────────────────────────────
const FAKE_SSN = /\b000-00-0000\b|\b123-45-6789\b|\b111-11-1111\b/;

function passesLuhn(digits: string): boolean {
  const d = digits.replace(/[^\d]/g, '');
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = parseInt(d[i], 10);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function findHits(content: string): PatternHit[] {
  const hits: PatternHit[] = [];
  const lines = content.split('\n');

  // Email/phone in the format-detection pass are noisy at scale; require an
  // assignment-context label to avoid matching JSDoc, README snippets, etc.
  const EMAIL_LABEL = /\b(email|e_mail|user_?email|contact_?email)\b/i;
  const PHONE_LABEL = /\b(phone|telephone|mobile|cell|contact_?(?:phone|number))\b/i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Skip lines that look like fake/example data
    if (FAKE_SSN.test(line)) continue;

    // ── Data format (always-on, high precision) ──
    if (SSN.test(line)) {
      hits.push({ category: 'pii', label: 'ssn', line: lineNum, evidence: line.trim().slice(0, 200) });
    }
    // DOB requires both a date format AND a DOB-related label on the line
    if (DOB.test(line) && DOB_CONTEXT_RE.test(line)) {
      hits.push({ category: 'pii', label: 'dob', line: lineNum, evidence: line.trim().slice(0, 200) });
    }
    // Email/phone require a label so we don't trip on every JSDoc / README
    if (EMAIL.test(line) && EMAIL_LABEL.test(line)) {
      hits.push({ category: 'pii', label: 'email', line: lineNum, evidence: line.trim().slice(0, 200) });
    }
    if (PHONE_US.test(line) && PHONE_LABEL.test(line) && !IPV4.test(line)) {
      hits.push({ category: 'pii', label: 'phone', line: lineNum, evidence: line.trim().slice(0, 200) });
    }
    if (MRN_LABELED.test(line)) {
      hits.push({ category: 'phi', label: 'mrn', line: lineNum, evidence: line.trim().slice(0, 200) });
    }

    // Credit card with Luhn
    const ccMatches = line.match(CC_CANDIDATE);
    if (ccMatches) {
      for (const candidate of ccMatches) {
        if (passesLuhn(candidate)) {
          hits.push({ category: 'financial', label: 'credit_card', line: lineNum, evidence: line.trim().slice(0, 200) });
          break;
        }
      }
    }

    // ── Variable name detection (declaration-context only) ──
    if (PHI_VAR_RE.test(line)) {
      hits.push({ category: 'phi', label: 'phi_var', line: lineNum, evidence: line.trim().slice(0, 200) });
    }
    if (PII_VAR_RE.test(line)) {
      hits.push({ category: 'pii', label: 'pii_var', line: lineNum, evidence: line.trim().slice(0, 200) });
    }
    if (FIN_VAR_RE.test(line)) {
      hits.push({ category: 'financial', label: 'fin_var', line: lineNum, evidence: line.trim().slice(0, 200) });
    }
  }

  return hits;
}

/** Proximity radius for `phi_in_ai_call` / `pii_in_ai_call`. */
const AI_PROXIMITY_LINES = 5;

/**
 * For each hit line, return true if there is an AI call within `radius` lines.
 * Pre-computes the set of AI-call line numbers in O(N) on the file.
 */
function buildAiCallLineSet(content: string): Set<number> {
  const lines = content.split('\n');
  const set = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (AI_CALL_RE.test(lines[i])) set.add(i + 1);
  }
  return set;
}

function nearAiCall(hitLine: number, callLines: Set<number>): boolean {
  for (let d = 0; d <= AI_PROXIMITY_LINES; d++) {
    if (callLines.has(hitLine - d) || callLines.has(hitLine + d)) return true;
  }
  return false;
}

export class PhiPatternDetector implements DetectorPlugin {
  readonly name = 'phi-pattern-detector';
  readonly description = 'Detects PHI, PII, and financial data patterns in source code (HIPAA / GDPR / PCI DSS)';
  readonly version = '1.0.0';

  async detect(ctx: DetectorContext): Promise<DetectorSignal[]> {
    const signals: DetectorSignal[] = [];

    for (const { file, content } of iterFiles(ctx)) {
      if (isTestFile(file, ctx.rootDir)) continue;

      // Strip comments to suppress findings buried in example documentation
      const stripped = stripComments(file, content);
      const hits = findHits(stripped);
      if (hits.length === 0) continue;

      // Pre-compute the AI-call and log-call line sets for proximity checks.
      const aiCallLines = buildAiCallLineSet(stripped);
      const logCallLines = new Set<number>();
      const lines = stripped.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (LOG_CALL_RE.test(lines[i])) logCallLines.add(i + 1);
      }

      for (const hit of hits) {
        const baseCaps: string[] = [];
        if (hit.category === 'phi') baseCaps.push('contains_phi', 'handles_phi');
        if (hit.category === 'pii') baseCaps.push('contains_pii', 'handles_pii');
        if (hit.category === 'financial') baseCaps.push('contains_financial', 'handles_financial');

        // Proximity check (within AI_PROXIMITY_LINES of an AI call) — fixes
        // the false-positive of every PHI variable in a file with one AI import.
        const aiNear = nearAiCall(hit.line, aiCallLines);
        const logNear = nearAiCall(hit.line, logCallLines);

        if (aiNear) {
          if (hit.category === 'phi') baseCaps.push('phi_in_ai_call');
          if (hit.category === 'pii') baseCaps.push('pii_in_ai_call');
        }
        if (logNear) {
          if (hit.category === 'phi') baseCaps.push('logs_phi');
          if (hit.category === 'pii') baseCaps.push('logs_pii');
        }

        signals.push({
          source: this.name,
          file,
          line: hit.line,
          target: hit.label,
          capabilities: baseCaps,
          confidence: hit.label.endsWith('_var') ? 0.7 : 0.9,
          evidence: hit.evidence,
          metadata: { category: hit.category, aiNear, logNear },
        });
      }
    }

    return signals;
  }
}

// Export internals for unit tests
export const __test__ = { findHits, passesLuhn, PHI_VAR_RE, PII_VAR_RE, FIN_VAR_RE };
