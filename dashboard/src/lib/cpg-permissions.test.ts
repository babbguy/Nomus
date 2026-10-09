import { describe, it, expect } from 'vitest';
import {
  ACCESS_REQUIREMENT, describeScope, formatActor, guardDecision, hasOrgPermission, isCanonicalRepo, meetsRequirement,
  missingPermissions, showGovernanceNav, visibleGovernancePages,
} from './cpg-permissions';
import { auditFilterQuery } from './cpg-audit';
import { cpgErrorCode, cpgErrorMessage } from './cpg-errors';
import { me, OWNER_ID, TEAM_ID } from '../test/cpg-fixtures';

const developer = me({
  permissions: ['case.comment', 'case.create', 'case.read', 'ci.read', 'org.members.read', 'policy.read'].map((key) => ({ key, scope: 'org' as const, scopeId: null })),
});

describe('permission checks', () => {
  it('counts only org-scoped grants, as the engine does without a repository', () => {
    const scoped = me({ permissions: [{ key: 'audit.read', scope: 'repo', scopeId: 'example-org/api' }] });
    expect(hasOrgPermission(scoped, 'audit.read')).toBe(false);
    expect(hasOrgPermission(me(), 'audit.read')).toBe(true);
    expect(hasOrgPermission(null, 'audit.read')).toBe(false);
  });

  it('reports what a requirement lacks', () => {
    expect(missingPermissions(developer, ACCESS_REQUIREMENT)).toEqual(['rbac.users.manage or rbac.roles.manage or rbac.teams.manage']);
    expect(missingPermissions(developer, { all: ['audit.read', 'policy.read'] })).toEqual(['audit.read']);
    expect(meetsRequirement(me(), ACCESS_REQUIREMENT)).toBe(true);
    expect(meetsRequirement(developer, {})).toBe(true);
  });

  it('guards: loading until /cpg/me is in, error on failure, then allow or deny', () => {
    expect(guardDecision({ status: 'idle', me: null }, {})).toBe('loading');
    expect(guardDecision({ status: 'loading', me: null }, {})).toBe('loading');
    expect(guardDecision({ status: 'error', me: null }, {})).toBe('error');
    expect(guardDecision({ status: 'ready', me: developer }, ACCESS_REQUIREMENT)).toBe('deny');
    expect(guardDecision({ status: 'ready', me: me() }, ACCESS_REQUIREMENT)).toBe('allow');
  });

  it('shows the Governance group only with permissions and (enabled or able to enable)', () => {
    expect(showGovernanceNav(me())).toBe(true); // Org Admin, governance off
    expect(showGovernanceNav(developer)).toBe(false); // off, cannot enable
    expect(showGovernanceNav({ ...developer, cpgEnabled: true })).toBe(true);
    expect(showGovernanceNav(me({ permissions: [], isPlatformAdmin: true, cpgEnabled: true }))).toBe(false);
  });

  it('lists only the pages the user can open', () => {
    expect(visibleGovernancePages(me()).map((p) => p.to)).toEqual([
      '/governance', '/governance/policies', '/governance/boards', '/governance/quorum', '/governance/access', '/governance/audit', '/governance/settings',
    ]);
    expect(visibleGovernancePages(developer).map((p) => p.to)).toEqual(['/governance', '/governance/policies', '/governance/cases', '/governance/boards', '/governance/quorum', '/governance/settings']);
    expect(visibleGovernancePages(me({ permissions: [] })).map((p) => p.to)).toEqual(['/governance']);
  });
});

describe('display helpers', () => {
  it('names audit actors; unknown users keep their full id', () => {
    const users = new Map([[OWNER_ID, { name: 'Owner One', email: 'owner@example.org' }]]);
    expect(formatActor(`user:${OWNER_ID}`, users)).toBe('owner@example.org');
    expect(formatActor('user:1c7d2e3f-4051-4263-9b74-8c9d0e1f2031')).toBe('User 1c7d2e3f-4051-4263-9b74-8c9d0e1f2031');
    expect(formatActor('system:seed')).toBe('System (initial setup)');
    expect(formatActor('system:rbac-migration')).toBe('System (upgrade migration)');
    expect(formatActor('system:quorum')).toBe('System (quorum reached)');
    expect(formatActor('system:lapse')).toBe('System (proposal lapsed)');
    expect(formatActor('system:other')).toBe('System (other)');
    expect(formatActor('')).toBe('Unknown');
  });

  it('describes grant scopes', () => {
    const teams = new Map([[TEAM_ID, { name: 'Payments', key: 'payments' }]]);
    expect(describeScope({ scopeType: 'org', scopeId: null })).toBe('Organization');
    expect(describeScope({ scopeType: 'team', scopeId: TEAM_ID }, teams)).toBe('Team Payments');
    expect(describeScope({ scopeType: 'team', scopeId: TEAM_ID })).toBe(`Team ${TEAM_ID}`);
    expect(describeScope({ scopeType: 'repo', scopeId: 'example-org/api' })).toBe('Repository example-org/api');
  });

  it('accepts only canonical repository ids (mirrors the engine)', () => {
    expect(isCanonicalRepo('example-org/api')).toBe(true);
    expect(isCanonicalRepo('host.example/org/api')).toBe(true);
    expect(isCanonicalRepo('Example-Org/api')).toBe(false);
    expect(isCanonicalRepo('example-org')).toBe(false);
    expect(isCanonicalRepo('example-org/..')).toBe(false);
    expect(isCanonicalRepo(`a/${'b'.repeat(200)}`)).toBe(false);
  });

  it('turns the audit date filters into UTC day bounds and rejects a reversed range', () => {
    expect(auditFilterQuery({ action: 'grant.created', since: '2026-10-01', until: '2026-10-08' })).toEqual({
      limit: 50, action: 'grant.created', since: '2026-10-01T00:00:00.000Z', until: '2026-10-08T23:59:59.999Z',
    });
    expect(auditFilterQuery({ action: '', since: '', until: '' })).toEqual({ limit: 50 });
    expect(auditFilterQuery({ action: '', since: '2026-10-09', until: '2026-10-01' })).toHaveProperty('error');
  });

  it('error messages: server envelope with details, contract errors as they are', () => {
    const apiErr = { response: { data: { error: 'Invalid input', code: 'invalid_input', details: [{ path: ['email'], message: 'Invalid email' }] } } };
    expect(cpgErrorMessage(apiErr, 'fallback')).toBe('Invalid input (email: Invalid email)');
    expect(cpgErrorCode(apiErr)).toBe('invalid_input');
    const contract = Object.assign(new Error('Unexpected response from GET /cpg/me (orgId: Invalid uuid)'), { name: 'CpgContractError' });
    expect(cpgErrorMessage(contract, 'fallback')).toBe('Unexpected response from GET /cpg/me (orgId: Invalid uuid)');
    expect(cpgErrorMessage(new Error('network'), 'fallback')).toBe('fallback');
    expect(cpgErrorCode(null)).toBeNull();
  });
});
