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

/** Every event-type name that may be broadcast to SSE clients. */
export type BroadcastEventType = SSEEventType | OperationalSSEEventType;

/**
 * Wire envelope broadcast to subscribed SSE clients by the engine's
 * broadcastEvent(). `data` is intentionally `unknown` because each event
 * type carries a distinct, pipeline-specific payload; consumers narrow on
 * `type` before reading `data`.
 */
export interface BroadcastEvent {
  id: string;
  type: BroadcastEventType;
  data: unknown;
  jurisdiction: string;
}
