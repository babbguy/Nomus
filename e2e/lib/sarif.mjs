// Structural validation of a SARIF 2.1.0 log against the parts of the OASIS
// schema the Nomus output uses, plus the constraints GitHub Code Scanning
// enforces on upload. Returns a list of problems (empty = valid).

const LEVELS = new Set(['none', 'note', 'warning', 'error']);
const KINDS = new Set(['notApplicable', 'pass', 'fail', 'review', 'open', 'informational']);

export function validateSarif(log) {
  const p = [];
  const at = (path, msg) => p.push(`${path}: ${msg}`);
  if (!log || typeof log !== 'object') return ['log is not a JSON object'];
  if (log.version !== '2.1.0') at('version', `must be "2.1.0" (got ${JSON.stringify(log.version)})`);
  if (log.$schema !== undefined && !/sarif-schema-2\.1\.0\.json$|sarif-2\.1\.0/.test(String(log.$schema))) at('$schema', `not a SARIF 2.1.0 schema URI: ${log.$schema}`);
  if (!Array.isArray(log.runs)) { at('runs', 'required array'); return p; }
  log.runs.forEach((run, ri) => {
    const rp = `runs[${ri}]`;
    const driver = run?.tool?.driver;
    if (!driver || typeof driver.name !== 'string' || !driver.name) at(`${rp}.tool.driver.name`, 'required non-empty string');
    const rules = driver?.rules ?? [];
    if (!Array.isArray(rules)) at(`${rp}.tool.driver.rules`, 'must be an array');
    const ruleIds = new Map();
    (Array.isArray(rules) ? rules : []).forEach((r, i) => {
      if (typeof r?.id !== 'string' || !r.id) at(`${rp}.tool.driver.rules[${i}].id`, 'required string');
      else if (ruleIds.has(r.id)) at(`${rp}.tool.driver.rules[${i}].id`, `duplicate rule id ${r.id}`);
      else ruleIds.set(r.id, i);
      for (const k of ['shortDescription', 'fullDescription', 'help']) {
        if (r?.[k] !== undefined && typeof r[k]?.text !== 'string') at(`${rp}.tool.driver.rules[${i}].${k}.text`, 'required string when the property is present');
      }
      if (r?.defaultConfiguration?.level !== undefined && !LEVELS.has(r.defaultConfiguration.level)) at(`${rp}.tool.driver.rules[${i}].defaultConfiguration.level`, `invalid level ${r.defaultConfiguration.level}`);
    });
    if (!Array.isArray(run.results)) { at(`${rp}.results`, 'must be an array'); return; }
    run.results.forEach((res, i) => {
      const xp = `${rp}.results[${i}]`;
      if (typeof res?.message?.text !== 'string' && typeof res?.message?.id !== 'string') at(`${xp}.message`, 'requires text or id');
      if (res?.ruleId !== undefined && typeof res.ruleId !== 'string') at(`${xp}.ruleId`, 'must be a string');
      if (res?.ruleId && ruleIds.size && !ruleIds.has(res.ruleId)) at(`${xp}.ruleId`, `${res.ruleId} is not defined in tool.driver.rules`);
      if (res?.ruleIndex !== undefined && rules[res.ruleIndex]?.id !== res.ruleId) at(`${xp}.ruleIndex`, 'does not point at the rule named by ruleId');
      if (res?.level !== undefined && !LEVELS.has(res.level)) at(`${xp}.level`, `invalid level ${res.level}`);
      if (res?.kind !== undefined && !KINDS.has(res.kind)) at(`${xp}.kind`, `invalid kind ${res.kind}`);
      if (!Array.isArray(res?.locations) || res.locations.length === 0) at(`${xp}.locations`, 'GitHub Code Scanning requires at least one location');
      (res?.locations ?? []).forEach((loc, li) => {
        const pl = loc?.physicalLocation;
        const lp = `${xp}.locations[${li}].physicalLocation`;
        if (!pl) { at(lp, 'required'); return; }
        if (typeof pl.artifactLocation?.uri !== 'string' || !pl.artifactLocation.uri) at(`${lp}.artifactLocation.uri`, 'required string');
        const reg = pl.region;
        if (reg) {
          for (const k of ['startLine', 'startColumn', 'endLine', 'endColumn']) {
            if (reg[k] !== undefined && !(Number.isInteger(reg[k]) && reg[k] >= 1)) at(`${lp}.region.${k}`, `must be an integer >= 1 (got ${reg[k]})`);
          }
          if (reg.endLine !== undefined && reg.startLine !== undefined && reg.endLine < reg.startLine) at(`${lp}.region`, 'endLine before startLine');
        }
      });
      // A fix must describe its artifactChanges (schema: required, minItems 1).
      (res?.fixes ?? []).forEach((fix, fi) => {
        if (!Array.isArray(fix?.artifactChanges) || fix.artifactChanges.length === 0) at(`${xp}.fixes[${fi}].artifactChanges`, 'required non-empty array');
      });
      if (res?.partialFingerprints !== undefined && (typeof res.partialFingerprints !== 'object' || Array.isArray(res.partialFingerprints))) at(`${xp}.partialFingerprints`, 'must be an object');
    });
  });
  return p;
}
