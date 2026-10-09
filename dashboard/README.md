# Nomus Dashboard

The web frontend for Nomus: administration and organization views for regulatory monitoring, rule management, code scan results, attestations, radar, benchmarks and more.

Built with React 19, Vite, Tailwind CSS, Zustand (state management), and React Router.

## Quick Start

```bash
# From the repository root
npm install
npm run build:packages
npm run dev:engine        # in one terminal: http://localhost:3100
npm run dev:dashboard     # in another: http://localhost:5173
```

The Vite dev server proxies `/api` and `/.well-known` to `http://localhost:3100` (see `vite.config.ts`). In the engine's `.env`, `NOMUS_CORS_ORIGIN` should be `http://localhost:5173` (the `.env.example` default).

With Docker Compose (`docker compose up --build`) the dashboard is served by nginx on `http://localhost:8080` and proxies `/api/` to the engine container; see `Dockerfile.dashboard` (repository root) and `infra/nginx-dashboard.conf`.

The first login uses the admin account created from `NOMUS_ADMIN_EMAIL` / `NOMUS_ADMIN_PASSWORD` in the engine configuration.

## Pages

Routes are defined in `src/App.tsx`.

### Admin pages (`src/pages/admin/`, role `platform_admin`)

| Page | Purpose |
|------|---------|
| `AdminDashboard` | Platform overview and metrics |
| `SourceList` / `SourceAudit` / `DiffViewer` | Manage regulatory sources, audit them, and review text diffs |
| `PipelineHistory` | Source pipeline run history and status |
| `TenantList` / `TenantDetail` | Organization management |
| `UserList` | User account administration |
| `ScoutFeeds` / `ScoutReview` | Regulatory prediction feeds and review |
| `ScanAdmin` | Code scan administration |
| `OntologyManage` | Regulatory ontology/taxonomy management |
| `RadarManage` | Regulatory radar configuration |
| `FeedbackReview` | Review submitted rule quality feedback |
| `LLMSettings` | LLM provider and model configuration |
| `NotificationSettings` | Email, Slack and ntfy notification configuration |
| `IntegrityCheck` | Database and rule integrity verification |
| `SystemStatus` | System health monitoring |
| `ModusIntegration` | Optional Modus integration settings |

### Organization pages (`src/pages/customer/`)

| Page | Purpose |
|------|---------|
| `CustomerDashboard` | Organization overview |
| `Policies` / `Templates` | Applicable regulatory rules and rule templates |
| `Scans` / `ScanRepo` | Code scan results |
| `Attestations` | Attestation records |
| `CompliancePosture` | Overall regulatory posture |
| `Benchmarks` | AI model benchmarking results (COMPL-AI) |
| `Simulator` / `Simulations` | Scenario simulation |
| `Radar` / `RadarV2` / `BillDetail` | Regulatory change radar and tracked bills |
| `GraphExplorer` | Regulatory knowledge graph |
| `ClauseMap` | Clause-level mapping |
| `AiBom` | AI Bill of Materials |
| `AuditExport` | Audit log export |
| `BadgePage` | Badge embed codes |
| `FeedbackSubmit` | Submit rule quality feedback |
| `Team` | Team member management |
| `Profile` / `Settings` | User profile and organization settings (API keys only with `org.api_keys.manage`) |

### Governance pages (`src/pages/governance/`)

Shown according to the user's organization permissions from `GET /api/v1/cpg/me`.

| Page | Route | Needs | Purpose |
|------|-------|-------|---------|
| `GovernanceOverview` | `/governance` | any signed-in user | Governance status, links to the pages you can open, your permissions; explains a redirect |
| `GovernanceAccess` | `/governance/access` | `org.members.read` and a `rbac.*.manage` permission | Users and grants (org, team or repository scope), role permission matrix and editor, teams |
| `GovernanceAudit` | `/governance/audit` | `audit.read` | Hash-chained governance audit log with the chain-verification result |
| `GovernanceSettings` | `/governance/settings` | `policy.read` (changes: `org.settings.manage`) | Turn governance on, reviewer-context generation with its data disclosure |
| `GovernancePolicies` | `/governance/policies` | `policy.read` | The corporate policy log: state, tier, owning boards, versions, grace period or enforcement date |
| `PolicyNew` | `/governance/policies/new` (`?policy=<id>` for a new version) | `policy.read` and `policy.author` | Plain-English authoring with code examples, compile (generated output labelled), rejection reasons, propose |
| `PolicyDetail` | `/governance/policies/:id` | `policy.read` (votes: `policy.approve`, never the author or compile requester) | Versions, votes, signatures, supersede history, version diff, four-eyes status, withdraw, new version, retirement |

### Public and auth pages

| Page | Purpose |
|------|---------|
| `PublicTransparency` | Public transparency/ledger view (`/ledger`, `/transparency`) |
| `PublicVerify` | Public attestation verification (`/verify/:verifyId`) |
| `Login` / `ForgotPassword` / `ResetPassword` / `ForceChangePassword` | Authentication flows |

## Architecture

### State management (`src/stores/`)

- `authStore.ts` -- authentication state (user, session, role-based access)
- `appStore.ts` -- global application state
- `pipelineStore.ts` -- live pipeline monitoring (Server-Sent Events)
- `cpgStore.ts` -- the signed-in user's governance identity and permissions (`GET /cpg/me`, loaded once per user)

### API layer (`src/api/`)

Typed clients built on a shared Axios base client (`client.ts`), including `admin.ts`, `auth.ts`, `dashboard.ts`, `scans.ts`, `policies.ts`, `attestations.ts`, `scout.ts`, `radar.ts`, `radar-v2.ts`, `simulate.ts`, `sources.ts`, `tenants.ts`, `diffs.ts`, `clause-map.ts`, `verify.ts` and `transparency-accuracy.ts`.

`cpg.ts` is the governance client (`/api/v1/cpg`). Every response is parsed with the zod schemas in
`cpg-schemas.ts` and `cpg-quorum.ts` before a page uses it; a response that does not match shows as
a load error naming the endpoint and field. The engine's `dashboard-api-contract.test.ts` and
`routes/cpg/dashboard-registry-contract.test.ts` parse real engine responses with the same schemas.
`cpg-quorum.ts` mirrors the engine's quorum schema (for parsing and form validation); a contract
test runs both over the same accept and reject cases. The corporate rule schema is mirrored by
structure only: the engine validates vocabularies, regex safety and globs.

### Routing

Role-based routing with `AdminRoute` and `ProtectedRoute` wrappers. Admin pages require the `platform_admin` role. Governance pages use `PermissionRoute` (`src/components/layout/PermissionRoute.tsx`), which redirects to `/governance` with an explanation when a permission is missing, so a page never makes a call the API would refuse. Users flagged `mustChangePassword` are redirected to a forced password change page.

### Optional error tracking

Browser error reporting is initialized only if `VITE_NOMUS_SENTRY_DSN` is set at build time; it is off by default.

## Build

```bash
npm run build -w dashboard      # TypeScript check + Vite production build (outputs to dashboard/dist/)
npm run lint -w dashboard       # ESLint
npm run preview -w dashboard    # Preview the production build locally
```

## Key Files

| File | Purpose |
|------|---------|
| `src/App.tsx` | Route definitions and layout |
| `src/api/client.ts` | Base Axios HTTP client (auth headers, error handling) |
| `src/stores/authStore.ts` | Auth state and session persistence |
| `src/stores/pipelineStore.ts` | SSE-driven pipeline progress tracking |
| `src/components/layout/Shell.tsx` | App shell with navigation |
| `src/components/layout/ProtectedRoute.tsx` | Auth guard for protected routes |

Nomus output is regulatory applicability information, not legal advice or a compliance certification.
