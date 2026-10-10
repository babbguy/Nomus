import type { Migration } from './runner.js';
import { appendOnlyTriggers, boolCheck, immutableColumnsTrigger, isoCheck, isoOrNullCheck, noDeleteTrigger, sha256HexCheck, uuidCheck } from './sql-helpers.js';

/**
 * CPG Phase 7: integrations (design spec §2.3, migration `cpg_0006_integrations`,
 * tables T32 to T35, §12). Integration configs, the Jira issue of each
 * (case, board), the transactional delivery outbox and every delivery attempt.
 *
 * Applied once by runCpgMigrations and checksummed. NEVER edit this file
 * after it has shipped: add a new numbered migration instead.
 */

const jsonArray = (col: string) => `${col} TEXT NOT NULL CHECK (json_valid(${col}) AND json_type(${col}) = 'array')`;

export const cpg0006Integrations: Migration = {
  id: 'cpg_0006_integrations',
  statements: [
    `CREATE TABLE cpg_integrations (
      id TEXT PRIMARY KEY CHECK ${uuidCheck('id')},
      org_id TEXT NOT NULL REFERENCES organizations(id),
      kind TEXT NOT NULL CHECK (kind IN ('email','jira','webhook')),
      name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
      ${jsonArray('board_ids')},
      ${jsonArray('events')},
      config TEXT NOT NULL CHECK (json_valid(config) AND json_type(config) = 'object'),
      secret_enc TEXT NULL CHECK (secret_enc IS NULL OR secret_enc GLOB 'enc:*'),
      secret_last4 TEXT NULL CHECK (secret_last4 IS NULL OR length(secret_last4) = 4),
      enabled INTEGER NOT NULL CHECK ${boolCheck('enabled')},
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL CHECK ${isoCheck('created_at')},
      updated_by TEXT NOT NULL,
      updated_at TEXT NOT NULL CHECK ${isoCheck('updated_at')},
      CHECK ((kind = 'email') = (secret_enc IS NULL))
    )`,
    'CREATE INDEX ix_cpg_integrations_org ON cpg_integrations (org_id)',
    immutableColumnsTrigger('cpg_integrations', ['id', 'org_id', 'kind', 'created_by', 'created_at']),
    noDeleteTrigger('cpg_integrations'),

    `CREATE TABLE cpg_integration_links (
      id TEXT PRIMARY KEY CHECK ${uuidCheck('id')},
      org_id TEXT NOT NULL REFERENCES organizations(id),
      integration_id TEXT NOT NULL REFERENCES cpg_integrations(id),
      case_id TEXT NOT NULL REFERENCES cpg_cases(id),
      board_id TEXT NOT NULL REFERENCES cpg_boards(id),
      external_key TEXT NOT NULL CHECK (length(external_key) BETWEEN 1 AND 100),
      external_url TEXT NOT NULL CHECK (length(external_url) BETWEEN 1 AND 2000),
      created_at TEXT NOT NULL CHECK ${isoCheck('created_at')},
      UNIQUE (integration_id, case_id, board_id)
    )`,
    ...appendOnlyTriggers('cpg_integration_links'),

    `CREATE TABLE cpg_notification_deliveries (
      id TEXT PRIMARY KEY CHECK ${uuidCheck('id')},
      org_id TEXT NOT NULL REFERENCES organizations(id),
      integration_id TEXT NOT NULL REFERENCES cpg_integrations(id),
      channel TEXT NOT NULL CHECK (channel IN ('email','jira','webhook')),
      event TEXT NOT NULL CHECK (length(event) BETWEEN 1 AND 50),
      case_id TEXT NULL REFERENCES cpg_cases(id),
      board_id TEXT NULL REFERENCES cpg_boards(id),
      payload TEXT NOT NULL CHECK (json_valid(payload) AND json_type(payload) = 'object'),
      payload_sha256 TEXT NOT NULL CHECK ${sha256HexCheck('payload_sha256')},
      retry_of TEXT NULL REFERENCES cpg_notification_deliveries(id),
      status TEXT NOT NULL CHECK (status IN ('pending','delivered','failed','cancelled')),
      attempts INTEGER NOT NULL CHECK (attempts BETWEEN 0 AND 8),
      next_attempt_at TEXT NULL CHECK ${isoOrNullCheck('next_attempt_at')},
      created_at TEXT NOT NULL CHECK ${isoCheck('created_at')},
      updated_at TEXT NOT NULL CHECK ${isoCheck('updated_at')},
      CHECK ((status = 'pending') = (next_attempt_at IS NOT NULL))
    )`,
    'CREATE INDEX ix_cpg_deliveries_due ON cpg_notification_deliveries (status, next_attempt_at)',
    'CREATE INDEX ix_cpg_deliveries_org ON cpg_notification_deliveries (org_id, created_at)',
    immutableColumnsTrigger('cpg_notification_deliveries',
      ['id', 'org_id', 'integration_id', 'channel', 'event', 'case_id', 'board_id', 'payload', 'payload_sha256', 'retry_of', 'created_at']),
    // Queue state moves forward only: a terminal delivery never changes again, and attempts never go back.
    `CREATE TRIGGER trg_cpg_notification_deliveries_forward BEFORE UPDATE ON cpg_notification_deliveries
      WHEN OLD.status <> 'pending' OR NEW.attempts < OLD.attempts
      BEGIN SELECT RAISE(ABORT, 'cpg_notification_deliveries: a terminal delivery is final'); END`,
    noDeleteTrigger('cpg_notification_deliveries'),

    `CREATE TABLE cpg_delivery_attempts (
      id TEXT PRIMARY KEY CHECK ${uuidCheck('id')},
      delivery_id TEXT NOT NULL REFERENCES cpg_notification_deliveries(id),
      attempt INTEGER NOT NULL CHECK (attempt BETWEEN 1 AND 8),
      started_at TEXT NOT NULL CHECK ${isoCheck('started_at')},
      duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
      http_status INTEGER NULL CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
      error TEXT NULL CHECK (length(error) <= 500),
      response_excerpt TEXT NULL CHECK (length(response_excerpt) <= 500),
      UNIQUE (delivery_id, attempt)
    )`,
    ...appendOnlyTriggers('cpg_delivery_attempts'),
  ],
};
