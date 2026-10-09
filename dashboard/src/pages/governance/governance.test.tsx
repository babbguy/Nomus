import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { OverviewView } from './GovernanceOverview';
import { SettingsView } from './GovernanceSettings';
import { AuditTable, ChainStatus } from './GovernanceAudit';
import { UsersTable } from './access/UsersPanel';
import { RoleMatrix } from './access/RolesPanel';
import { TeamsTable } from './access/TeamsPanel';
import { orgOnlyPermissions, parsePatterns, permissionGroups, rolePatch } from './access/helpers';
import * as fx from '../../test/cpg-fixtures';

/** Render to static HTML and return its visible text. */
function text(node: React.ReactElement): string {
  const html = renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
  return html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
}

function expectClean(t: string) {
  for (const re of fx.BROKEN) expect(t).not.toMatch(re);
}

const noop = () => {};
const teamsById = new Map(fx.teams.map((t) => [t.id, t]));
const names = {
  users: new Map(fx.users.map((u) => [u.id, { name: u.name, email: u.email }])),
  roles: new Map(fx.roles.map((r) => [r.id, r.name])),
  teams: new Map(fx.teams.map((t) => [t.id, t.name])),
};

describe('Governance overview', () => {
  it('shows status, the pages the user can open and their permissions', () => {
    const t = text(<OverviewView me={fx.me()} orgName="Example Org" denied={null} />);
    expect(t).toContain('Corporate policy governance is off for Example Org');
    expect(t).toContain('You can turn it on in Settings');
    for (const label of ['Access', 'Audit log', 'Settings']) expect(t).toContain(label);
    expect(t).toContain('rbac.users.manage');
    expectClean(t);
  });

  it('explains a redirect and names the missing permission', () => {
    const t = text(<OverviewView me={fx.me({ permissions: [] })} orgName={null} denied={{ from: '/governance/access', missing: ['rbac.users.manage or rbac.roles.manage'] }} />);
    expect(t).toContain("You don't have access to Access.");
    expect(t).toContain('rbac.users.manage or rbac.roles.manage');
    expect(t).toContain('your organization');
    expect(t).toContain('You hold no governance permissions');
    expectClean(t);
  });

  it('platform administrators get an explanation instead of an empty page', () => {
    const t = text(<OverviewView me={fx.me({ permissions: [], isPlatformAdmin: true })} orgName="Example Org" denied={null} />);
    expect(t).toContain('Platform administrators get no organization role');
  });

  it('shows team names for team-scoped permissions when known, the id otherwise', () => {
    const scoped = fx.me({ permissions: [{ key: 'case.read', scope: 'team', scopeId: fx.TEAM_ID }, { key: 'case.read', scope: 'repo', scopeId: 'example-org/api' }] });
    expect(text(<OverviewView me={scoped} orgName="X" denied={null} teamNames={new Map([[fx.TEAM_ID, 'Payments']])} />))
      .toContain('case.read team Payments, repository example-org/api');
    expect(text(<OverviewView me={scoped} orgName="X" denied={null} />)).toContain(`team ${fx.TEAM_ID}`);
  });
});

describe('Governance settings', () => {
  it('discloses that snippets go to the configured LLM provider (D1)', () => {
    const t = text(<SettingsView settings={fx.settings} canManage saving={false} actorName="System (initial setup)" onToggleEnabled={noop} onToggleReviewerContext={noop} />);
    expect(t).toContain('snippets of flagged code are sent to the LLM provider configured for this Nomus instance');
    expect(t).toContain('An LLM provider is configured on this instance');
    expect(t).toContain('Turn on');
    expect(t).toContain('by System (initial setup)');
    expect(t).not.toContain('Read only');
    expectClean(t);
  });

  it('says nothing is sent without a provider, and is read-only without org.settings.manage', () => {
    const html = renderToStaticMarkup(
      <SettingsView settings={{ ...fx.settings, llmProviderConfigured: false, reviewerContextLlm: false, rbacMigratedAt: null }} canManage={false} saving={false} actorName="x" onToggleEnabled={noop} onToggleReviewerContext={noop} />,
    );
    expect(html).toContain('No LLM provider is configured on this instance, so nothing is sent');
    expect(html).toContain('Read only');
    expect(html).not.toContain('Turn on');
    expect(html).toMatch(/role="switch" aria-checked="false"[^>]*disabled/);
    expect(html).toContain('Not yet');
  });
});

describe('Governance audit', () => {
  it('lists events with resolved actors and targets', () => {
    const t = text(<AuditTable items={fx.auditEvents} names={names} />);
    expect(t).toContain('grant.created');
    expect(t).toContain('owner@example.org');
    expect(t).toContain('grant repo_reader to dev@example.org');
    expect(t).toContain('System (upgrade migration)');
    expect(t).toContain('organization');
    expectClean(t);
  });

  it('falls back to full ids when names are unavailable', () => {
    const t = text(<AuditTable items={fx.auditEvents} names={null} />);
    expect(t).toContain(`User ${fx.OWNER_ID}`);
    expect(t).toContain(`user ${fx.DEV_ID}`);
  });

  it('shows the chain status, loudly when broken', () => {
    expect(text(<ChainStatus valid />)).toContain('Chain verified');
    expect(text(<ChainStatus valid={false} />)).toContain('Chain broken');
  });
});

describe('Access: users, roles, teams', () => {
  it('users table: grants with their scope, status, and actions only for managers', () => {
    const managed = text(<UsersTable users={fx.users} meUserId={fx.OWNER_ID} canManage teamsById={teamsById} onGrant={noop} onRevoke={noop} onDeactivate={noop} onReactivate={noop} />);
    expect(managed).toContain('dev@example.org');
    expect(managed).toContain('Team Payments');
    expect(managed).toContain('Repository example-org/api');
    expect(managed).toContain('Inactive');
    expect(managed).toContain('Temporary password');
    expect(managed).toContain('(you)');
    expect(managed).toContain('Reactivate');
    expectClean(managed);
    const readOnly = text(<UsersTable users={fx.users} meUserId={fx.OWNER_ID} canManage={false} teamsById={teamsById} onGrant={noop} onRevoke={noop} onDeactivate={noop} onReactivate={noop} />);
    expect(readOnly).not.toContain('Grant role');
    expect(readOnly).not.toContain('Reactivate');
  });

  it('users table: an empty organization gets an empty state', () => {
    expect(text(<UsersTable users={[]} meUserId={fx.OWNER_ID} canManage teamsById={teamsById} onGrant={noop} onRevoke={noop} onDeactivate={noop} onReactivate={noop} />))
      .toContain('No users in this organization');
  });

  it('role matrix: one column per active role, a mark per held permission, archive only for custom roles', () => {
    const html = renderToStaticMarkup(<RoleMatrix roles={fx.roles} permissions={fx.permissions} canManage onEdit={noop} onArchive={noop} />);
    expect(html).toContain('aria-label="Org Admin has rbac.users.manage"');
    expect(html).toContain('aria-label="Developer does not have rbac.users.manage"');
    expect(html).toContain('aria-label="Archive role Repo Reader"');
    expect(html).not.toContain('aria-label="Archive role Org Admin"');
    const archived = text(<RoleMatrix roles={[...fx.roles.slice(0, 2), { ...fx.roles[2], archivedAt: '2026-10-08T12:00:00.000Z', archivedBy: 'user:x' }]} permissions={fx.permissions} canManage={false} onEdit={noop} onArchive={noop} />);
    expect(archived).toContain('Archived roles');
    expect(archived).toContain('Archived Oct 8, 2026');
    expect(archived).not.toContain('Edit');
    expectClean(archived);
  });

  it('teams table and its empty state', () => {
    const t = text(<TeamsTable teams={[...fx.teams, { ...fx.teams[0], id: 'x', key: 'old', name: 'Old', repoPatterns: [], archivedAt: '2026-10-08T12:00:00.000Z' }]} canManage onEdit={noop} onArchive={noop} />);
    expect(t).toContain('example-org/payments-*');
    expect(t).toContain('matches no repository');
    expect(t).toContain('Restore');
    expectClean(t);
    expect(text(<TeamsTable teams={[]} canManage={false} onEdit={noop} onArchive={noop} />)).toContain('No teams yet');
  });

  it('helpers: role patch holds only changes; patterns are cleaned; org-only permissions detected', () => {
    const role = fx.roles[2];
    expect(rolePatch(role, { name: role.name, description: '', permissions: ['case.read'] })).toBeNull();
    expect(rolePatch(role, { name: ' Readers ', description: '', permissions: ['case.read', 'case.comment', 'case.read'] }))
      .toEqual({ name: 'Readers', permissions: ['case.comment', 'case.read'] });
    expect(parsePatterns(' a/b \n\na/b\r\na/c-*\n')).toEqual(['a/b', 'a/c-*']);
    expect(orgOnlyPermissions(fx.roles[1], fx)).toEqual(['org.members.read', 'policy.read']);
    expect(orgOnlyPermissions(fx.roles[2], fx)).toEqual([]);
    expect(permissionGroups(fx.permissions).map(([c]) => c)).toEqual(['org', 'rbac', 'policy', 'case', 'audit']);
  });
});
