// Numbers that appear on more than one page (and in the API, the VS Code
// extension and the GitHub Action output) must agree.

/** First number after `label` in the page text (labels and values are separate lines). */
function num(text, label) {
  if (!text) return undefined;
  const re = new RegExp(`${label}\\s*\\n+\\s*(-?[\\d,]+(?:\\.\\d+)?)`, 'i');
  const m = re.exec(text);
  return m ? Number(m[1].replace(/,/g, '')) : undefined;
}

export async function crossChecks(ctx, texts) {
  const { gate } = ctx;
  const d = ctx.data;
  const t = (k) => texts[k] ?? '';
  const hash = (await d.orgKey.get('/api/v1/policies/hash')).json;
  const score = (await d.orgKey.get('/api/v1/compliance/score')).json;
  const atts = (await d.orgKey.get('/api/v1/attestations?limit=1')).json;
  const bom = (await d.orgKey.get('/api/v1/ai-bom')).json;
  const repos = (await d.orgKey.get('/api/v1/scan/repos')).json;
  const tenants = (await d.adminKey.get('/api/v1/tenants')).json;
  const srcs = (await d.adminKey.get('/api/v1/sources')).json;
  const sourceList = Array.isArray(srcs) ? srcs : srcs?.sources ?? [];

  const same = (name, values) => {
    const shown = Object.entries(values);
    const distinct = new Set(shown.map(([, v]) => v));
    gate.check(`same ${name} everywhere`, distinct.size === 1 && !distinct.has(undefined) && !distinct.has(NaN),
      'one value', Object.fromEntries(shown.map(([k, v]) => [k, v === undefined ? '(not found)' : v])));
  };

  same('active rule count', {
    'API /policies/hash': hash?.ruleCount,
    'Dashboard "Active Policies"': num(t('member:/dashboard'), 'Active Policies'),
    'Posture "Active Rules"': num(t('member:/compliance'), 'Active Rules'),
    'Policies "N rules"': (() => { const m = /\n(\d+) rules\n/.exec(t('member:/policies')); return m ? Number(m[1]) : undefined; })(),
    'Admin dashboard "Active Policy Rules"': num(t('admin:/admin/dashboard'), 'Active Policy Rules'),
  });
  same('attestation count', {
    'API /attestations total': atts?.total,
    'Dashboard "Attestations"': num(t('member:/dashboard'), 'Attestations'),
    'Audit Log "Attestations"': num(t('member:/audit-log'), '\\nAttestations'),
  });
  same('open findings', {
    'API /compliance/score openFindings': score?.openFindings,
    'API /scan/repos open': (repos?.repos ?? []).reduce((n, r) => n + Number(r.openFindings ?? 0), 0),
    'GitHub Action total-findings': d.action?.total,
    'Scans "Open Findings"': num(t('member:/scans'), 'Open Findings'),
    'Posture "Open Findings"': num(t('member:/compliance'), 'Open Findings'),
    'Audit Log "Findings"': num(t('member:/audit-log'), '\\nFindings'),
    'Admin Scans "Open Findings"': num(t('admin:/admin/scans'), 'Open Findings'),
  });
  same('critical open findings', {
    'scanner CLI critical': d.scan?.findings?.filter((f) => f.severity === 'critical').length,
    'Admin Scans "Critical Open"': num(t('admin:/admin/scans'), 'Critical Open'),
    'Posture factor': (() => { const m = /(\d+) critical open finding/.exec(t('member:/compliance')); return m ? Number(m[1]) : undefined; })(),
  });
  same('AI systems', {
    'API /ai-bom count': bom?.count,
    'API /compliance/score aiBomSystemCount': score?.aiBomSystemCount,
    'AI-BOM "Total AI Systems"': num(t('member:/ai-bom'), 'Total AI Systems'),
    'Posture "Total AI Systems"': num(t('member:/compliance'), 'Total AI Systems'),
    'VS Code generate (systems detected)': d.aiBomSystems,
  });
  same('compliance score', {
    'API /compliance/score': score?.overallScore,
    'Dashboard gauge': (() => { const m = /\n(\d+)\n+Compliance Score/.exec(t('member:/dashboard')); return m ? Number(m[1]) : undefined; })(),
    'Posture score': (() => { const m = /Recalculate\n+(\d+)\n/.exec(t('member:/compliance')); return m ? Number(m[1]) : undefined; })(),
    'GitHub Action compliance-score': d.action?.score,
  });
  same('organizations', {
    'API /tenants': tenants?.organizations?.length ?? tenants?.count,
    'Admin dashboard "Active Tenants"': num(t('admin:/admin/dashboard'), 'Active Tenants'),
  });
  const active = sourceList.filter((s) => s.isActive).length;
  const adminSources = /Active Sources\s*\n+\s*(\d+) of (\d+)/.exec(t('admin:/admin/dashboard'));
  gate.check('same source counts on the admin dashboard and the API', adminSources && Number(adminSources[1]) === active && Number(adminSources[2]) === sourceList.length,
    `${active} of ${sourceList.length}`, adminSources ? `${adminSources[1]} of ${adminSources[2]}` : '(not found)');
}
