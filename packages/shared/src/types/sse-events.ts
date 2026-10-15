import type { CompiledPolicy } from './policy.js';

export type SSEEventType =
  | 'policy.created'
  | 'policy.updated'
  | 'policy.revoked'
  | 'conflict.detected'
  | 'heartbeat';

export interface SSEPolicyEvent {
  id: string;
  type: SSEEventType;
  data: CompiledPolicy;
  sequence: number;
  timestamp: string;
}

export interface SSEConflictEvent {
  id: string;
  type: 'conflict.detected';
  data: {
    jurisdictionA: string;
    jurisdictionB: string;
    ruleKeyA: string;
    ruleKeyB: string;
    description: string;
  };
  sequence: number;
  timestamp: string;
}

export interface SSEHeartbeat {
  type: 'heartbeat';
  timestamp: string;
}

export type SSEEvent = SSEPolicyEvent | SSEConflictEvent | SSEHeartbeat;

/**
 * Operational (non-policy) SSE event type names emitted by the Hunter,
 * Forge, Scout, and audit pipelines through the engine's broadcastEvent().
 * These carry heterogeneous, pipeline-specific payloads (progress, status,
 * lifecycle) that are not part of the stable policy-event contract above.
 */
export type OperationalSSEEventType =
  | 'pipeline.progress'
  | 'regulation.changed'
  | 'scout.auto_promoted'
  | 'audit.result'
  | 'source.failing'
  | 'source.deactivated'
  | 'forge.started'
  | 'forge.progress'
  | 'forge.status'
  | 'forge.completed'
  | 'forge.finished'
  | 'forge.error'
  | 'forge.stopping'
  | 'forge.escalation';

/**
 * Corporate Policy Governance events. They are org-private: always broadcast
 * with `orgId`, so only that org's clients receive them, and never stored in
 * policy_events (no SSE id, no replay).
 */
export type CpgSSEEventType =
  | 'cpg.bundle.changed';

/** Every event-type name that may be broadcast to SSE clients. */
export type BroadcastEventType = SSEEventType | OperationalSSEEventType | CpgSSEEventType;

/**
 * Wire envelope broadcast to subscribed SSE clients by the engine's
 * broadcastEvent(). `data` is intentionally `unknown` because each event
 * type carries a distinct, pipeline-specific payload; consumers narrow on
 * `type` before reading `data`.
 */
export interface BroadcastEvent {
  /**
   * SSE event id (the client's Last-Event-ID). Set only for stored policy
   * events, where it is the event's sequence number; every other event is
   * ephemeral and carries no id.
   */
  id?: string;
  type: BroadcastEventType;
  data: unknown;
  jurisdiction: string;
  /**
   * When set, the event is private to this organization: only its clients
   * receive it, whatever their jurisdiction subscription. Events without an
   * orgId (the regulatory corpus and pipeline events) are unchanged.
   */
  orgId?: string;
}
