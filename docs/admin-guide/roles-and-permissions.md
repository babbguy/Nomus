# Roles and permissions

Each organization in Nomus has its own role-based access control (RBAC). It controls who can
manage the organization's users, roles, teams and settings, and, as corporate policy governance
features arrive, who can write, approve and review corporate policies.

This page covers the access model. For the endpoints, see the
[Governance API reference](../api-reference/governance.md).

> Corporate policy governance is **opt-in**. Until an Org Admin turns it on
> (dashboard: **Governance, Settings**; API: `PATCH /api/v1/cpg/settings {"enabled": true}`), an organization behaves exactly as it did in
> v1.1.0. Roles and permissions exist from the moment you upgrade, so you can set up access first
> and enable governance later.

---

## Concepts

| Term | Meaning |
|------|---------|
| **Permission** | One capability, such as `rbac.users.manage` or `case.review`. The catalog is fixed by Nomus. |
| **Role** | A named set of permissions, defined per organization. Seven **system roles** are created for every organization; Org Admins can add **custom roles**. |
| **Grant** | Assigns a role to a user, either org-wide or limited to a **team** or a single **repository**. |
| **Team** | A named set of repository patterns (for example `acme/payments-*`), used to scope grants. |

Permissions are checked on every request. Revoking a grant, deactivating a user, archiving a role
or archiving a team takes effect on the user's next request; nothing is cached between requests.

## The system roles

| Role | Key | For |
|------|-----|-----|
| Org Admin | `org_admin` | Manages users, roles, teams, boards, quorum, integrations and settings. **Approves nothing by itself.** |
| Policy Author | `policy_author` | Writes and proposes corporate policies. |
| Policy Approver | `policy_approver` | Approves or rejects policy versions written by someone else. |
| Case Reviewer | `case_reviewer` | Reviews cases for the review boards they belong to; may add policies from inside a case. |
| Exception Approver | `exception_approver` | Proposes, approves and revokes standing exceptions. |
| Developer | `developer` | Requests reviews and justifies findings. Keeps the v1.1.0 member abilities. |
| Auditor | `auditor` | Read-only access to governance records, plus export. |

An Org Admin who also needs to approve something must hold a second role, such as Policy
Approver. That second grant is visible in the audit log.

### Permissions held by each system role

| Permission | Org Admin | Policy Author | Policy Approver | Case Reviewer | Exception Approver | Developer | Auditor |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `org.profile.update` | ● | | | | | ● (legacy) | |
| `org.api_keys.manage` | ● | | | | | ● (legacy) | |
| `org.members.read` | ● | ● | ● | ● | ● | ● | ● |
| `org.settings.manage` | ● | | | | | | |
| `rbac.users.manage` | ● | | | | | | |
| `rbac.roles.manage` | ● | | | | | | |
| `rbac.teams.manage` | ● | | | | | | |
| `boards.manage` | ● | | | | | | |
| `quorum.manage` | ● | | | | | | |
| `integrations.manage` | ● | | | | | | |
| `policy.read` | ● | ● | ● | ● | ● | ● | ● |
| `policy.author` | | ● | | ● | | | |
| `policy.approve` | | | ● | | | | |
| `case.create` | | | | | | ● | |
| `case.read` | ● | ● | ● | ● | ● | ● | ● |
| `case.comment` | | ● | ● | ● | ● | ● | |
| `case.review` | | | | ● | | | |
| `case.close` | ● | | | ● | | | |
| `exception.propose` | | | | ● | ● | | |
| `exception.approve` | | | | | ● | | |
| `decision.revoke` | | | | | ● | | |
| `audit.read` | ● | | | | | | ● |
| `audit.export` | | | | | | | ● |
| `ci.read` | ● | ● | ● | ● | ● | ● | ● |

`GET /api/v1/cpg/permissions` lists the catalog with a description of each permission.

**Legacy grants on Developer.** In v1.1.0 every member could update the organization profile and
create organization API keys. Developer keeps `org.profile.update` and `org.api_keys.manage` so
nothing changes on upgrade. To tighten this, an Org Admin removes them from the Developer role
(`PATCH /api/v1/cpg/roles/:id`); the change applies immediately to every Developer.

### Editing system roles

Org Admins can change the permissions of system roles, with two safeguards that prevent an
organization from locking itself out:

- The Org Admin role always keeps `rbac.users.manage` and `rbac.roles.manage` (`409 last_org_admin`
  if you try to remove them). The database enforces this as well.
- The last active Org Admin grant cannot be revoked, and the last active Org Admin cannot be
  deactivated (`409 last_org_admin`).

System roles cannot be archived. Custom roles can be archived; their grants then stop conferring
anything, and an archived role can no longer be granted or edited.

## Scoping grants to teams and repositories

A grant has a scope:

| Scope | `scopeId` | Applies to |
|-------|-----------|------------|
| `org` | none | Everything in the organization |
| `team` | team id | Repositories matching any of the team's patterns |
| `repo` | canonical repository id, for example `acme/payments-api` or `ghe.example.com/acme/api` | That repository only |

Only **scopable** permissions (the `case.*`, `exception.*`, `decision.revoke` and `ci.read`
permissions) can be granted per team or repository. A role that contains any non-scopable
permission can only be granted org-wide; granting it with a team or repository scope returns
`422 role_not_scopable`.

When a request does not concern a specific repository (for example listing cases), only org-wide
grants count; team- and repository-scoped holders see results filtered to their repositories.

### Team repository patterns

Patterns are lowercase globs matched against the canonical repository id. A leading `github.com/`
host is dropped (`github.com/acme/*` is stored as `acme/*`), because github.com repositories are
identified as `owner/name`:

- `*` matches any characters except `/`; `?` matches exactly one character except `/`.
- `**` is a whole path segment and matches zero or more segments, for example `ghe.example.com/**`.
- `{api,web}` alternation (not nested, at most 10 options).
- Character classes, `!` negation and extglobs are not supported. Patterns may not start with `./`
  or `/` or contain `\`.
- At most 200 characters per pattern and 50 patterns per team. An invalid pattern returns
  `422 invalid_glob`.

## Who gets which role on upgrade

The first time v1.2.0 starts, every existing organization is migrated once:

- The **owner**, the earliest-created active `member` of the organization, gets **Org Admin** and
  **Developer**. If no member is active, the earliest inactive member is the owner. Ties on
  creation time go to the lowest user id.
- Every other `member` gets **Developer**.
- `platform_admin` users get **nothing**: they keep operating the instance but hold no
  organization permission (see below).

The migration is recorded in the organization's audit log (`rbac.migrated`). After it, new users
follow these rules:

- A user created by a platform administrator (`POST /api/v1/users`, role `member`) gets Developer.
  If the organization has no active Org Admin at that moment, the user also gets Org Admin, so the
  first user invited into a new organization administers it.
- A user invited by an Org Admin (`POST /api/v1/cpg/users`) gets Developer plus any roles named in
  `roleKeys`.
- A user moved to another organization (`PATCH /api/v1/users/:id` with `orgId`) loses every grant
  in the old organization and gets the new-user grants in the new one.

## Platform administrators

`platform_admin` remains the instance operator: tenants, users, settings and the admin pages work
as before. It is **not** an organization role and confers no governance permission in any
organization. Two exceptions keep v1.1.0 behaviour and give the operator a recovery path:

- On the self-service `/api/v1/org` routes, a platform administrator session keeps its v1.1.0
  access.
- `POST /api/v1/tenants/:id/org-admins {"userId": "..."}` grants Org Admin to a user of that
  organization. Use it when an organization has no Org Admin left (for example after the last one
  was moved or deactivated by a platform administrator). It is audited in the organization's log.

## Temporary passwords

A user with a temporary password (newly invited, or after an administrator reset) can only change
the password, read `GET /api/v1/auth/me` and sign out. Every governance endpoint answers
`403 password_change_required` until the password is changed. This applies to the user's
VS Code key as well.

## VS Code sign-in: one key per user

The VS Code extension signs in through the browser and receives an API key **bound to the user who
signed in**. The key acts as that user: it stops working when the user is deactivated or moved to
another organization, and it is refused with `403 password_change_required` while the user has a
temporary password.

Signing in again replaces only that user's previous extension key. (In v1.1.0, a second developer
signing in to the same organization revoked the first developer's key.) Extension keys created
before the upgrade are not bound to a user; they keep working for scanning, and governance
endpoints refuse them with `403 user_identity_required`. Signing in again issues a user-bound key.

## Managing access in the dashboard

Org Admins manage access under **Governance, Access** (`/governance/access`). The page needs
`org.members.read` plus at least one of `rbac.users.manage`, `rbac.roles.manage` and
`rbac.teams.manage`; anyone else who opens it is sent to **Governance, Overview**, which names the
missing permission. Each control appears only for the permission that allows it, and the engine
checks every change again.

**Users tab** (changes need `rbac.users.manage`)

- **Invite user:** email, name and optional extra roles (granted org-wide; everyone also gets
  Developer). The temporary password is shown once, with a copy button, and is also emailed when
  email delivery is configured. The user must change it at first sign-in.
- **Grant role:** pick a role and a scope: the whole organization, one team or one repository
  (lowercase `owner/name`). A role that contains an org-only permission can only be granted to the
  whole organization; the dialog says which permissions prevent a narrower scope. Granting a role
  the user already holds with the same scope changes nothing.
- **Revoke** (the × on a role): asks for a reason, which is recorded in the audit log. A revocation
  cannot be undone; grant the role again instead. The last Org Admin grant cannot be revoked.
- **Deactivate / Reactivate:** a deactivated user cannot sign in and their VS Code key stops
  working; their grants are kept. You cannot deactivate yourself or the last Org Admin.
- Each user shows **Active** or **Inactive**, and **Temporary password** until they have changed
  it. Team- and repository-scoped grants show their scope next to the role name.

**Roles tab** (changes need `rbac.roles.manage`)

- A permission matrix shows every active role (columns) against every permission (rows, grouped
  by area); permissions marked *org only* cannot be granted per team or repository.
- **New role** creates a custom role (its key cannot be changed later). **Edit** changes a role's
  name, description and permissions; the Org Admin role always keeps `rbac.users.manage` and
  `rbac.roles.manage` (shown locked). **Archive** (custom roles only) removes the role's
  permissions from everyone who holds it; it cannot be undone.

**Teams tab** (changes need `rbac.teams.manage`)

- Create a team with a key, a name and repository patterns, one per line (see
  [Team repository patterns](#team-repository-patterns)). Edit the name and patterns, or archive a
  team, which stops its grants from applying; **Restore** brings it back.

Every change made on these tabs appears in **Governance, Audit log**.

## The audit log

Every RBAC and settings change is written to the organization's governance audit log: role
creation, edits (with the full before and after permission sets), archiving, grants and
revocations, invitations, user changes, team changes and settings changes. Each event records the
acting user, the time (UTC) and a hash that chains it to the previous event. The database refuses
any update or deletion of audit events.

`GET /api/v1/cpg/audit` (Org Admins and Auditors) returns the events newest first, together with
`chainValid`, the result of re-verifying the whole chain. `chainValid: false` means the log was
altered outside Nomus, for example by editing the database file directly.

In the dashboard, **Governance, Audit log** (`/governance/audit`, needs `audit.read`) shows the same
events with a banner: **Chain verified**, or **Chain broken** in red when verification fails. You
can filter by action and by UTC date range, load older events, and expand an event to see its
details, actor id, exact UTC time and hashes. Users and roles are shown by name when you hold
`org.members.read`, otherwise by id.

## Settings

| Setting | Default | Meaning |
|---------|---------|---------|
| `enabled` | `false` | Turns corporate policy governance on for the organization. |
| `reviewerContextLlm` | `true` when the instance has an LLM provider configured, otherwise `false` | Generates plain-English context for flagged snippets for reviewers. When on, flagged snippets are sent to the LLM provider configured for this instance. Generated context is always labelled as generated. An Org Admin can turn it off. |

Read them with `GET /api/v1/cpg/settings` and change them with `PATCH /api/v1/cpg/settings`
(Org Admin). Every change is audited.

In the dashboard, **Governance, Settings** (`/governance/settings`) shows both settings to anyone
with `policy.read` and lets Org Admins (`org.settings.manage`) change them. Turning governance on or
off asks for confirmation. The reviewer-context switch sits next to a disclosure that states what
leaves the instance: when it is on, snippets of flagged code are sent to the LLM provider configured
for this instance. The page also says whether a provider is configured; without one, nothing is
sent.
