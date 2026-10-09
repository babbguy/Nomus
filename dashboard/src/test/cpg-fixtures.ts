import type { AuditEvent, CpgMe, CpgSettings, OrgUser, Permission, Role, Team } from '../api/cpg-schemas';

/**
 * Response bodies shaped exactly like the engine's (docs/api-reference/governance.md),
 * for the dashboard's contract and component tests. Neutral example values only.
 */

export const ORG_ID = '6f1c2a4e-1b2c-4d3e-8f90-0a1b2c3d4e5f';
export const OWNER_ID = '0b6c1d2e-3f40-4152-8a63-7b8c9d0e1f20';
export const DEV_ID = '1c7d2e3f-4051-4263-9b74-8c9d0e1f2031';
export const ROLE_ADMIN_ID = '2d8e3f40-5162-4374-ac85-9d0e1f203142';
export const ROLE_DEV_ID = '3e9f4051-6273-4485-bd96-0e1f20314253';
export const ROLE_CUSTOM_ID = '4fa05162-7384-4596-8ea7-1f2031425364';
export const TEAM_ID = '50b16273-8495-46a7-9fb8-203142536475';
const T = '2026-10-08T12:00:00.000Z';
const HASH = (c: string) => c.repeat(64);

export const permissions: Permission[] = [
  { key: 'org.members.read', category: 'org', scopable: false, description: 'Read the organization members' },
  { key: 'org.settings.manage', category: 'org', scopable: false, description: 'Change governance settings' },
  { key: 'rbac.users.manage', category: 'rbac', scopable: false, description: 'Invite users, grant and revoke roles' },
  { key: 'rbac.roles.manage', category: 'rbac', scopable: false, description: 'Manage roles' },
  { key: 'policy.read', category: 'policy', scopable: false, description: 'Read the policy log' },
  { key: 'case.read', category: 'case', scopable: true, description: 'Read review cases' },
  { key: 'case.comment', category: 'case', scopable: true, description: 'Comment on review cases' },
  { key: 'audit.read', category: 'audit', scopable: false, description: 'Read the audit log' },
];

export const roles: Role[] = [
  {
    id: ROLE_ADMIN_ID, key: 'org_admin', name: 'Org Admin', description: 'Manages users, roles and settings.', isSystem: true,
    permissions: ['audit.read', 'org.members.read', 'org.settings.manage', 'policy.read', 'rbac.roles.manage', 'rbac.users.manage'],
    createdAt: T, createdBy: 'system:seed', archivedAt: null, archivedBy: null,
  },
  {
    id: ROLE_DEV_ID, key: 'developer', name: 'Developer', description: 'Requests reviews.', isSystem: true,
    permissions: ['case.comment', 'case.read', 'org.members.read', 'policy.read'],
    createdAt: T, createdBy: 'system:seed', archivedAt: null, archivedBy: null,
  },
  {
    id: ROLE_CUSTOM_ID, key: 'repo_reader', name: 'Repo Reader', description: '', isSystem: false,
    permissions: ['case.read'], createdAt: T, createdBy: `user:${OWNER_ID}`, archivedAt: null, archivedBy: null,
  },
];

export const teams: Team[] = [
  { id: TEAM_ID, key: 'payments', name: 'Payments', repoPatterns: ['example-org/payments-*'], createdAt: T, createdBy: `user:${OWNER_ID}`, archivedAt: null },
];

const grant = (id: string, userId: string, role: Role, scopeType: 'org' | 'team' | 'repo' = 'org', scopeId: string | null = null) => ({
  id, userId, roleId: role.id, roleKey: role.key, roleName: role.name, scopeType, scopeId,
  grantedBy: 'system:rbac-migration', grantedAt: T, revokedAt: null, revokedBy: null, revokeReason: null,
});

export const users: OrgUser[] = [
  {
    id: OWNER_ID, name: 'Owner One', email: 'owner@example.org', isActive: true, mustChangePassword: false,
    grants: [grant('60c27384-95a6-47b8-a0c9-314253647586', OWNER_ID, roles[0]), grant('71d38495-a6b7-48c9-b1da-425364758697', OWNER_ID, roles[1])],
    boards: [],
  },
  {
    id: DEV_ID, name: 'Dev Two', email: 'dev@example.org', isActive: false, mustChangePassword: true,
    grants: [
      grant('82e495a6-b7c8-49da-82eb-5364758697a8', DEV_ID, roles[1]),
      grant('93f5a6b7-c8d9-4aeb-93fc-64758697a8b9', DEV_ID, roles[2], 'team', TEAM_ID),
      grant('a406b7c8-d9ea-4bfc-a40d-758697a8b9ca', DEV_ID, roles[2], 'repo', 'example-org/api'),
    ],
    boards: [],
  },
];

export const settings: CpgSettings = {
  orgId: ORG_ID, enabled: false, reviewerContextLlm: true, llmProviderConfigured: true,
  rbacMigratedAt: T, updatedAt: T, updatedBy: 'system:seed',
};

export const auditEvents: AuditEvent[] = [
  {
    id: 'b517c8d9-eafb-4c0d-b51e-8697a8b9cadb', seq: 2, actor: `user:${OWNER_ID}`, action: 'grant.created', targetType: 'grant',
    targetId: '93f5a6b7-c8d9-4aeb-93fc-64758697a8b9', payload: { userId: DEV_ID, roleKey: 'repo_reader', scopeType: 'team', scopeId: TEAM_ID },
    prevHash: HASH('a'), hash: HASH('b'), createdAt: T,
  },
  {
    id: 'c628d9ea-fb0c-4d1e-862f-97a8b9cadbec', seq: 1, actor: 'system:rbac-migration', action: 'rbac.migrated', targetType: 'org',
    targetId: ORG_ID, payload: { ownerUserId: OWNER_ID, developerCount: 1 }, prevHash: HASH('0'), hash: HASH('a'), createdAt: T,
  },
];

export function me(overrides: Partial<CpgMe> = {}): CpgMe {
  return {
    user: { id: OWNER_ID, name: 'Owner One', email: 'owner@example.org' },
    orgId: ORG_ID,
    cpgEnabled: false,
    isPlatformAdmin: false,
    permissions: roles[0].permissions.map((key) => ({ key, scope: 'org' as const, scopeId: null })),
    boards: [],
    roles: [
      { id: ROLE_DEV_ID, key: 'developer', name: 'Developer', isSystem: true },
      { id: ROLE_ADMIN_ID, key: 'org_admin', name: 'Org Admin', isSystem: true },
    ],
    identity: 'session',
    ...overrides,
  };
}

/** Text a page must never show (the release gate's broken-value rules). */
export const BROKEN = [/\bNaN\b/, /\bundefined\b/, /\[object Object\]/, /Invalid Date/];

// ═══ Phase 2: boards, quorum, compile records and the policy log ═════════

export const AUTHOR_ID = 'd739eafb-0c1d-4e2f-973a-a8b9cadbecfd';
export const APPROVER_ID = 'e84afb0c-1d2e-4f30-a84b-b9cadbecfd0e';
export const BOARD_AI_ID = 'f95b0c1d-2e3f-4041-b95c-cadbecfd0e1f';
export const BOARD_LEGAL_ID = '0a6c1d2e-3f40-4152-8a6d-dbecfd0e1f20';
export const POLICY_ID = '1b7d2e3f-4051-4263-9b7e-ecfd0e1f2031';
export const V1_ID = '2c8e3f40-5162-4374-ac8f-fd0e1f203142';
export const V2_ID = '3d9f4051-6273-4485-bd90-0e1f20314253';
export const COMPILE_V1_ID = '4ea05162-7384-4596-8ea1-1f2031425364';
export const COMPILE_V2_ID = '5fb16273-8495-46a7-9fb2-203142536475';
const T2 = '2026-10-09T08:00:00.000Z';
const SIG = 'c2lnbmF0dXJlLWJ5dGVzLWZvci10ZXN0cw==';

export const boards = [
  {
    id: BOARD_AI_ID, key: 'ai-review', name: 'AI Review Board', kind: 'ai' as const, description: 'Reviews AI usage.',
    createdAt: T, createdBy: `user:${OWNER_ID}`, archivedAt: null, archivedBy: null, memberCount: 1,
    members: [{ id: '60c27384-95a6-47b8-a0c9-3142536475a1', boardId: BOARD_AI_ID, userId: APPROVER_ID, userName: 'Approver Four', userEmail: 'approver@example.org', addedAt: T, addedBy: `user:${OWNER_ID}`, removedAt: null, removedBy: null }],
  },
  {
    id: BOARD_LEGAL_ID, key: 'legal', name: 'Legal Board', kind: 'legal' as const, description: '',
    createdAt: T, createdBy: `user:${OWNER_ID}`, archivedAt: null, archivedBy: null, memberCount: 0, members: [],
  },
];

const rule = (message: string, source = 'gpt-4-32k') => ({
  schemaVersion: 1 as const,
  match: { all: [{ kind: 'line_regex' as const, pattern: { source, flags: '' as const, ignoreComments: true } }], withinLines: null, unless: [], unlessScope: 'file' as const },
  files: { include: ['**/*'], exclude: ['vendor/**'] },
  snippet: { contextBefore: 0, contextAfter: 0 },
  message,
});

export const sdkRule = {
  schemaVersion: 1 as const,
  match: { all: [{ kind: 'sdk_call' as const, sdks: ['openai'] }], withinLines: null, unless: [], unlessScope: 'file' as const },
  files: { include: ['**/*'], exclude: ['src/llm/gateway/**'] },
  snippet: { contextBefore: 0, contextAfter: 0 },
  message: 'Call OpenAI only through the approved LLM gateway.',
};

export const compiledRecord = {
  id: COMPILE_V2_ID, policyId: POLICY_ID, requestedBy: `user:${AUTHOR_ID}`, status: 'compiled' as const,
  inputText: 'No new code may reference the retired gpt-4-32k model anywhere.', inputHash: HASH('c'), promptVersion: 1,
  provider: 'openai', model: 'gpt-4o-mini', rejection: null,
  suggestion: { expressible: true as const, suggestedKey: 'corp.no-gpt-4-32k', title: 'Do not use gpt-4-32k', suggestedTier: 'review-required' as const, rationale: 'A line pattern decides it.', limitations: ['Only literal mentions.'] },
  compiledRule: rule('The gpt-4-32k model is retired; use an approved model.'), compiledRuleHash: HASH('d'),
  examples: { violating: [{ path: 'src/models.ts', code: "export const m = 'gpt-4-32k';\n" }], compliant: [{ path: 'src/ok.ts', code: "export const m = 'gpt-4o';\n" }] },
  exampleResults: [
    { kind: 'violating' as const, index: 0, path: 'src/models.ts', expected: 'finding' as const, findings: 1, lines: [1], passed: true, note: null },
    { kind: 'compliant' as const, index: 0, path: 'src/ok.ts', expected: 'no_finding' as const, findings: 0, lines: [], passed: true, note: null },
  ],
  tokensIn: 1200, tokensOut: 210, createdAt: T2,
};

export const unexpressibleRecord = {
  ...compiledRecord, id: '6ac27384-95a6-47b8-a0c3-3142536475a2', policyId: null, status: 'rejected_unexpressible' as const,
  inputText: 'Every AI integration must be well designed and show good taste.',
  rejection: { code: 'rejected_unexpressible', reasons: ['Requires a judgement about design quality, which a deterministic rule cannot make.'] },
  suggestion: { expressible: false as const, reason: 'Requires a judgement about design quality, which a deterministic rule cannot make.', closestExpressible: null },
  compiledRule: null, compiledRuleHash: null, exampleResults: null,
};

export const examplesRecord = {
  ...compiledRecord, id: '7bd38495-a6b7-48c9-b1d4-4253647586a3', policyId: null, status: 'rejected_examples' as const,
  rejection: { code: 'rejected_examples', reasons: ['violating example 1 (src/util.ts) produced no finding'] },
  compiledRule: null, compiledRuleHash: null,
  exampleResults: [{ kind: 'violating' as const, index: 0, path: 'src/util.ts', expected: 'finding' as const, findings: 0, lines: [], passed: false, note: null }],
};

const version = (over: Record<string, unknown>) => ({
  id: V1_ID, version: 1, kind: 'define' as const, status: 'active' as const, title: 'Do not use gpt-4-32k', plainText: 'No new code may reference gpt-4-32k.',
  tier: 'review-required' as const, owningBoards: [{ id: BOARD_AI_ID, name: 'AI Review Board' }], rule: rule('The gpt-4-32k model is retired for new code.'),
  ruleHash: HASH('e'), compileRecordId: COMPILE_V1_ID, editedFromCompile: false, graceDays: 14, enforceFromRequested: null,
  enforceFrom: '2026-10-22T08:00:00.000Z', activatedAt: '2026-10-08T08:00:00.000Z', signature: SIG, createdBy: `user:${AUTHOR_ID}`, createdAt: T,
  ...over,
});

export const policyHead = {
  policyId: POLICY_ID, policyKey: 'corp.no-gpt-4-32k', state: 'active' as const, title: 'Do not use gpt-4-32k', tier: 'review-required' as const,
  owningBoards: [{ id: BOARD_AI_ID, name: 'AI Review Board' }], activeVersion: 1, enforceFrom: '2026-10-22T08:00:00.000Z', inGracePeriod: true,
  pendingVersionId: V2_ID, pendingVersion: 2, latestVersion: 2, createdAt: T, createdBy: `user:${AUTHOR_ID}`, updatedAt: T2,
};

export const policyDetail = {
  policy: policyHead,
  versions: [
    version({}),
    version({
      id: V2_ID, version: 2, status: 'pending', tier: 'prohibited', owningBoards: [{ id: BOARD_AI_ID, name: 'AI Review Board' }, { id: BOARD_LEGAL_ID, name: 'Legal Board' }],
      rule: compiledRecord.compiledRule, ruleHash: HASH('d'), compileRecordId: COMPILE_V2_ID, graceDays: 0, enforceFrom: null, activatedAt: null, signature: null, createdAt: T2,
    }),
  ],
  events: [
    { id: '8ce495a6-b7c8-49da-82e5-5364758697a4', versionId: V1_ID, version: 1, event: 'proposed' as const, actor: `user:${AUTHOR_ID}`, details: { editedFromCompile: false }, createdAt: T },
    { id: '9df5a6b7-c8d9-4aeb-93f6-64758697a8b5', versionId: V1_ID, version: 1, event: 'approved' as const, actor: 'system:quorum', details: { quorumConfigVersion: 1 }, createdAt: '2026-10-08T08:00:00.000Z' },
    { id: 'a006b7c8-d9ea-4bfc-a407-758697a8b9c6', versionId: V1_ID, version: 1, event: 'activated' as const, actor: 'system:quorum', details: { enforceFrom: '2026-10-22T08:00:00.000Z', quorumConfigVersion: 1, signature: SIG }, createdAt: '2026-10-08T08:00:00.000Z' },
    { id: 'b117c8d9-eafb-4c0d-b518-8697a8b9cad7', versionId: V2_ID, version: 2, event: 'proposed' as const, actor: `user:${AUTHOR_ID}`, details: { editedFromCompile: false }, createdAt: T2 },
  ],
  votes: [
    { id: 'c228d9ea-fb0c-4d1e-8629-97a8b9cadbe8', versionId: V1_ID, voterUserId: APPROVER_ID, voterName: 'Approver Four', vote: 'approve' as const, comment: 'Looks right', quorumConfigVersion: 1, createdAt: '2026-10-08T08:00:00.000Z' },
  ],
  compileRecords: [
    { id: COMPILE_V2_ID, status: 'compiled', requestedBy: `user:${AUTHOR_ID}`, createdAt: T2 },
    { id: COMPILE_V1_ID, status: 'compiled', requestedBy: `user:${AUTHOR_ID}`, createdAt: T },
  ],
  requiredApprovals: 1,
};

const scope = (approvals: number, coverage: 'all_owning' | 'any_owning', perm: 'exception.approve' | null, max: number, def: number) => ({
  allowed: true as const, approvals, boardCoverage: coverage, extraBoardIds: [] as string[], requiredPermission: perm, maxExpiryDays: max, defaultExpiryDays: def,
});

export const quorumConfig = {
  schemaVersion: 1 as const,
  tiers: {
    advisory: { blocking: false as const },
    'review-required': { snippet: scope(1, 'any_owning', null, 180, 90), bulk: scope(1, 'any_owning', null, 180, 90), standing: scope(1, 'any_owning', 'exception.approve', 90, 30) },
    prohibited: { snippet: scope(2, 'all_owning', null, 90, 30), bulk: { allowed: false as const }, standing: scope(2, 'all_owning', 'exception.approve', 90, 30) },
  },
  policyOverrides: {} as Record<string, never>,
  policyApproval: { approvals: 1 },
  standingExceptions: { maxExpiryDays: 90, defaultExpiryDays: 30, allowOrgWideRepoPatterns: false },
  gracePeriod: { newPolicyDefaultDays: 14, newVersionDefaultDays: 0 },
  proposalLapseDays: 30,
};

export const quorumVersion = {
  version: 2, config: quorumConfig, configHash: HASH('f'), changeNote: 'Longer proposal window', createdAt: T, createdBy: `user:${OWNER_ID}`, signature: SIG,
};
