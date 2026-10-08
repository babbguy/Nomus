# @nomus/shared

Shared TypeScript types, Zod schemas, and constants used across the Nomus ecosystem (engine, dashboard, scanner, GitHub Action).

This package is workspace-internal (`private: true`) and consumed via npm workspace references.

## Quick Start

```bash
# From the repository root
npm run build:shared      # or: npm run build:packages
```

No standalone dev server -- this is a library package.

## Exports

### Types (`src/types/`)

- **`policy.ts`** -- `PolicyRule`, `CompiledPolicy`, `PolicyBundle`, `PolicyEffect`, `PolicySeverity`, `PolicyCategory`, `PolicyConditions`
- **`sse-events.ts`** -- `SSEEventType`, `SSEPolicyEvent`, `SSEConflictEvent`, `SSEHeartbeat`, `SSEEvent`
- **`regulatory-source.ts`** -- `RegulatorySource`, `ParserType`, `SelectorConfig`
- **`tenant.ts`** -- `Organization`, `ApiKey`, `ApiKeyScope` (`read:policies`, `stream`, `evaluate`, `admin`)
- **`attestation.ts`** -- `AttestationResult`, `EvaluatedRule`, `AttestationReceipt`
- **`knowledge-graph.ts`** -- `GraphNode`, `GraphEdge`, `GraphNodeType`, `GraphEdgeType`, `ConflictAlert`

### Schemas (`src/schemas/`)

- **`policy-schema.ts`** -- Zod schemas for policy conditions, effects, severities, categories, LLM output parsing, and evaluate requests
- **`tenant-schema.ts`** -- Zod schemas for org creation, API key creation, and feedback submission

### Constants (`src/constants.ts`)

- `JURISDICTIONS` -- Supported jurisdiction codes (EU, US-FED, UK, CN, CA, AU, JP, KR, BR, IN, US-CA, US-CO, US-IL, US-NY, US-TX, ISO, NIST)
- `CATEGORY_LABELS` -- Display labels for policy categories (data_governance, transparency, risk_assessment, etc.)
- `API_KEY_PREFIX_LIVE` / `API_KEY_PREFIX_TEST` -- API key prefixes (`nk_live_`, `nk_test_`)
- `LEGAL_DISCLAIMER` -- Legal disclaimer included in API responses

## Usage

```typescript
import type { PolicyRule, CompiledPolicy } from '@nomus/shared';
import { policyConditionsSchema, JURISDICTIONS } from '@nomus/shared';
```

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Barrel export for all types, schemas, and constants |
| `src/types/policy.ts` | Core policy/rule type definitions |
| `src/types/tenant.ts` | Organization, API key and scope types |
| `src/schemas/policy-schema.ts` | Zod validation schemas for LLM output parsing |
| `src/constants.ts` | Jurisdiction codes, category labels, API key prefixes |
