// Audit event type constants and builder. Events are immutable (PutItem only).
import { monotonicFactory } from 'ulid';
import type { AuditEvent } from './types.js';

export const AuditEvents = {
  alert_received: 'alert_received',
  alert_ignored: 'alert_ignored',
  alert_echo: 'alert_echo',
  incident_opened: 'incident_opened',
  roster_resolved: 'roster_resolved',
  backup_substituted: 'backup_substituted',
  member_skipped_unavailable: 'member_skipped_unavailable',
  room_joined: 'room_joined',
  invite_sent: 'invite_sent',
  invite_failed: 'invite_failed',
  member_joined: 'member_joined',
  member_left: 'member_left',
  slot_exhausted: 'slot_exhausted',
  team_escalated: 'team_escalated',
  notification_sent: 'notification_sent',
  convocation_connected: 'convocation_connected',
  convocation_unanswered: 'convocation_unanswered',
  incident_closed: 'incident_closed',
  graph_error: 'graph_error',
  config_changed: 'config_changed',
} as const;

export type AuditEventType = (typeof AuditEvents)[keyof typeof AuditEvents];

export type Actor = 'system' | 'graph' | 'sfn' | `admin:${string}`;

export const ADMIN_AUDIT_PK = 'ADMIN';

export function systemAuditPk(systemId: string): string {
  return `SYSTEM#${systemId}`;
}

/** Monotonic ULIDs keep events written within the same millisecond in insertion order. */
const nextUlid = monotonicFactory();

/** Audit retention: 400 days. */
const AUDIT_TTL_SECONDS = 400 * 24 * 60 * 60;

export interface BuildAuditInput {
  incident_id: string;
  event_type: AuditEventType;
  actor: Actor;
  system_id?: string;
  details?: Record<string, unknown>;
  ts?: string;
}

export function buildAuditEvent(input: BuildAuditInput): AuditEvent {
  const ts = input.ts ?? new Date().toISOString();
  const event: AuditEvent = {
    incident_id: input.incident_id,
    event_key: `${ts}#${nextUlid()}`,
    ts,
    event_type: input.event_type,
    actor: input.actor,
    details: input.details ?? {},
    ttl: Math.floor(Date.parse(ts) / 1000) + AUDIT_TTL_SECONDS,
  };
  if (input.system_id) event.system_id = input.system_id;
  return event;
}
