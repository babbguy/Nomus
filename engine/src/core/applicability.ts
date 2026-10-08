// Copyright 2026 babbguy
// SPDX-License-Identifier: Apache-2.0

/**
 * Capability-profile applicability: decides whether a policy rule applies to
 * a described AI system (capabilities, data types, market, sector, model type).
 *
 * Used by POST /api/v1/simulate, which every scanner surface (CLI, GitHub
 * Action, VS Code extension, MCP server) calls to turn detected capabilities
 * into obligations. The semantics mirror POST /api/v1/evaluate: a rule applies
 * only when EVERY condition it declares is satisfied. A rule's region alone
 * never makes it apply, and a sector-scoped rule never applies to a different
 * (or undeclared) sector.
 */

export interface ApplicabilityProfile {
  /** Detected/declared capabilities, compared exactly against `conditions.action`. */
  capabilities: string[];
  /** Declared data types (aliases such as `phi`/`pii` are normalized). */
  dataTypes: string[];
  /** Jurisdiction code being evaluated (compared against `conditions.region`). */
  market: string;
  sector?: string;
  modelType?: string;
}

/** Sector spellings accepted from clients, mapped to the vocabulary rules use. */
const SECTOR_ALIASES: Record<string, string> = {
  fintech: 'finance',
  financial: 'finance',
  financial_services: 'finance',
  banking: 'finance',
  insurance: 'finance',
  health: 'healthcare',
  healthtech: 'healthcare',
  medical: 'healthcare',
  life_sciences: 'healthcare',
  edtech: 'education',
  public_sector: 'government',
};

/** Data-type spellings accepted from clients, mapped to the vocabulary rules use. */
const DATA_TYPE_ALIASES: Record<string, string> = {
  phi: 'health',
  health_data: 'health',
  medical: 'health',
  pii: 'personal_data',
  personal: 'personal_data',
  location: 'geolocation',
  financial_data: 'financial',
  biometrics: 'biometric',
};

/**
 * Data types implied by a detected capability. Code that puts PHI into an AI
 * call handles health data whether or not the config declares it, so the
 * health-data rules must not silently drop out.
 */
const IMPLIED_DATA_TYPES: Record<string, string> = {
  contains_phi: 'health',
  handles_phi: 'health',
  phi_in_ai_call: 'health',
  logs_phi: 'health',
  contains_pii: 'personal_data',
  handles_pii: 'personal_data',
  pii_in_ai_call: 'personal_data',
  logs_pii: 'personal_data',
  handles_biometric: 'biometric',
  contains_financial: 'financial',
  handles_financial: 'financial',
};

/**
 * Condition keys that describe a rule for people rather than constrain it.
 * Rules extracted by the regulation pipeline carry the addressee ("who") and
 * free-text applicability ("condition") alongside the machine conditions; no
 * request context can equal that prose, so treating them as constraints made
 * every pipeline-extracted rule unmatchable in /evaluate and /simulate.
 */
const DESCRIPTIVE_CONDITION_KEYS = new Set(['who', 'condition']);

export function isDescriptiveConditionKey(key: string): boolean {
  return DESCRIPTIVE_CONDITION_KEYS.has(key);
}

/** `ai_operation` is the generic action: any AI capability satisfies it. */
const GENERIC_AI_ACTION = 'ai_operation';

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

export function normalizeSector(sector: string | undefined | null): string | undefined {
  if (!sector || !sector.trim()) return undefined;
  const s = slug(sector);
  return SECTOR_ALIASES[s] ?? s;
}

export function normalizeDataType(dataType: string): string {
  const d = slug(dataType);
  return DATA_TYPE_ALIASES[d] ?? d;
}

/** Declared data types plus the ones the capabilities imply, normalized and deduplicated. */
export function effectiveDataTypes(capabilities: string[], dataTypes: string[]): string[] {
  const out = new Set(dataTypes.map(normalizeDataType));
  for (const cap of capabilities) {
    const implied = IMPLIED_DATA_TYPES[cap];
    if (implied) out.add(implied);
  }
  return [...out];
}

function parseIndustries(industries: string | string[] | null | undefined): string[] {
  if (!industries) return [];
  if (Array.isArray(industries)) return industries;
  try {
    const parsed = JSON.parse(industries);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Return the conditions that made `conditions` apply to `profile`, or null when
 * the rule does not apply. A rule with no conditions applies generally.
 *
 * `industries` is the rule's industry metadata (JSON string or array). When the
 * profile declares a sector and the rule is scoped to other industries only,
 * the rule does not apply.
 */
export function matchRuleToProfile(
  conditions: Record<string, unknown>,
  industries: string | string[] | null | undefined,
  profile: ApplicabilityProfile,
): string[] | null {
  const sector = normalizeSector(profile.sector);
  const ruleIndustries = parseIndustries(industries).map((i) => normalizeSector(i) ?? i);
  if (sector && ruleIndustries.length > 0 && !ruleIndustries.includes('all') && !ruleIndustries.includes(sector)) {
    return null;
  }

  const entries = Object.entries(conditions).filter(
    (e): e is [string, string] => typeof e[1] === 'string' && e[1].length > 0 && !isDescriptiveConditionKey(e[0]),
  );
  if (entries.length === 0) return ['general_applicability'];

  const dataTypes = effectiveDataTypes(profile.capabilities, profile.dataTypes);
  const matchedOn: string[] = [];

  for (const [key, value] of entries) {
    switch (key) {
      case 'action':
        if (value === GENERIC_AI_ACTION && profile.capabilities.length > 0) {
          matchedOn.push(`capability: ${GENERIC_AI_ACTION}`);
        } else if (profile.capabilities.includes(value)) {
          matchedOn.push(`capability: ${value}`);
        } else {
          return null;
        }
        break;
      case 'data_type': {
        const wanted = normalizeDataType(value);
        if (!dataTypes.includes(wanted)) return null;
        matchedOn.push(`data_type: ${wanted}`);
        break;
      }
      case 'sector': {
        if (!sector || normalizeSector(value) !== sector) return null;
        matchedOn.push(`sector: ${sector}`);
        break;
      }
      case 'region':
        if (value !== profile.market) return null;
        matchedOn.push(`region: ${value}`);
        break;
      case 'model_type':
        if (!profile.modelType || profile.modelType !== value) return null;
        matchedOn.push(`model_type: ${value}`);
        break;
      default:
        // A condition the profile cannot express (e.g. risk_level) is not
        // satisfied — the same outcome /evaluate gives a context without it.
        return null;
    }
  }

  return matchedOn;
}
