// Domain types. The public ones (section 4.1 of ARCHITECTURE.md) are replicated by the admin panel
// in packages/admin-web/src/api/types.ts; keep them in sync.

export type TeamId = 'N2' | 'N3';

export const TEAM_IDS: readonly TeamId[] = ['N2', 'N3'] as const;

export interface Member {
  id: string;
  upn: string;
  name: string;
}

export interface RosterItem {
  system_id: string;
  roster_key: string;
  team_id: TeamId;
  priority_order: number;
  member_id: string;
  member_upn: string;
  member_name: string;
  room_join_url: string;
  updated_at: string;
  updated_by: string;
}

export type AvailabilityStatus = 'available' | 'vacation' | 'unavailable';

export const AVAILABILITY_STATUSES: readonly AvailabilityStatus[] = ['available', 'vacation', 'unavailable'] as const;

export interface AvailabilityItem {
  member_id: string;
  valid_from: string;
  valid_until: string;
  status: AvailabilityStatus;
  backup_id?: string;
  backup_upn?: string;
  backup_name?: string;
  note?: string;
  updated_at: string;
  updated_by: string;
}

export interface SeverityRule {
  severity: string;
  team_id: TeamId;
  escalate_to_team_id?: TeamId;
  escalate_after_minutes?: number;
  notify_webhook_urls: string[];
  enabled: boolean;
  updated_at: string;
  updated_by: string;
}

export type IncidentStatus = 'convoking' | 'connected' | 'unanswered' | 'closed';

export const INCIDENT_STATUSES: readonly IncidentStatus[] = ['convoking', 'connected', 'unanswered', 'closed'] as const;

export interface Participant {
  id: string;
  display_name: string;
  joined_at: string;
}

export interface Incident {
  incident_id: string;
  system_id: string;
  severity: string;
  team_id: TeamId;
  initial_team_id: TeamId;
  status: IncidentStatus;
  monitor_name?: string;
  condition_name?: string;
  opened_at: string;
  closed_at?: string;
  room_join_url: string;
  room_call_id?: string;
  bot_participant_id?: string;
  participants: Participant[];
  participant_count: number;
  ever_connected: boolean;
  execution_arn?: string;
  escalation_count: number;
  last_alert_at: string;
  echo_count: number;
  close_reason?: string;
  /** Internal: when `participants` was last synchronised with Graph (ISO). */
  participants_updated_at?: string;
  /** Internal: when the Teams cards for this incident were sent (ISO); guards "once per incident". */
  notification_sent_at?: string;
}

export interface AuditEvent {
  incident_id: string;
  event_key: string;
  ts: string;
  event_type: string;
  actor: string;
  system_id?: string;
  details: Record<string, unknown>;
  ttl?: number;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Deduplication lock item (`LOCK#${system_id}` / `META`). */
export interface LockItem {
  system_id: string;
  incident_id: string;
  created_at: string;
  ttl: number;
}

/** Payload of the New Relic workflow webhook (section 3.1). */
export interface WebhookPayload {
  system_tag: string;
  severity: string;
  monitor_name?: string;
  condition_name?: string;
  current_state: string;
  timestamp?: string;
  issue_id?: string;
  issue_url?: string;
}

export interface ConvocationPolicy {
  max_attempts: number;
  ring_timeout_seconds: number;
  max_escalations: number;
}

/** Input of the `convocation` state machine (and of resolve-roster). */
export interface StateMachineInput {
  incident_id: string;
  system_id: string;
  severity: string;
  team_id: TeamId;
  escalation_count: number;
  policy: ConvocationPolicy;
  room_call_id?: string;
}

/** One roster slot after availability/backup substitution. */
export interface Target {
  slot: number;
  member: Member;
  backup: Member | null;
  substituted: boolean;
}

export interface ResolveRosterOutput {
  incident_id: string;
  system_id: string;
  severity: string;
  team_id: TeamId;
  room_join_url: string;
  targets: Target[];
  escalate_to_team_id: TeamId | null;
  escalate_after_minutes: number | null;
  notify_webhook_urls: string[];
  cycle_started_at: string;
}

export interface JoinRoomInput {
  incident_id: string;
  room_join_url: string;
}

export interface JoinRoomOutput {
  room_call_id: string;
  bot_participant_id: string;
}

export interface InviteMemberInput {
  incident_id: string;
  room_call_id: string;
  member: Member;
  slot: number;
  attempt: number;
  using_backup: boolean;
}

export interface InviteMemberOutput {
  invited: boolean;
  error?: string;
}

export interface CheckJoinedInput {
  incident_id: string;
  room_call_id: string;
  member: Member;
  slot: number;
  attempt: number;
  cycle_started_at: string;
  escalate_after_minutes: number | null;
}

export interface CheckJoinedOutput {
  joined: boolean;
  elapsed_minutes: number;
  time_exceeded: boolean;
}

export type SlotOutcome = 'joined' | 'exhausted' | 'timed_out' | 'error';

export interface SlotResult {
  slot: number;
  member: Member;
  outcome: SlotOutcome;
  attempt?: number;
  using_backup?: boolean;
  error?: unknown;
}

export type ConvocationOutcome = 'connected' | 'escalate' | 'unanswered';

export interface EvaluateOutcomeInput {
  incident_id: string;
  system_id: string;
  severity: string;
  team_id: TeamId;
  escalation_count: number;
  policy: ConvocationPolicy;
  slot_results: SlotResult[];
  escalate_to_team_id?: TeamId | null;
  notify_webhook_urls?: string[] | null;
  /** Internal: set by the state machine when a previous step failed. */
  failure?: 'no_eligible_members' | 'room_join_failed' | null;
}

export interface EvaluateOutcomeOutput {
  outcome: ConvocationOutcome;
  next_team_id?: TeamId;
  escalation_count: number;
}

export type WebhookResult = 'convoked' | 'echo' | 'ignored';

export interface WebhookResponseBody {
  result: WebhookResult;
  incident_id?: string;
  reason?: string;
}
