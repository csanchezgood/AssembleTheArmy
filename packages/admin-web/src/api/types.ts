/**
 * Tipos del contrato del admin-api (ARCHITECTURE.md §4.1). Réplica exacta de
 * `packages/backend/src/domain/types.ts`.
 */

export type TeamId = 'N2' | 'N3';

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

export interface AvailabilityItem {
  member_id: string;
  valid_from: string;
  valid_until: string;
  status: 'available' | 'vacation' | 'unavailable';
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

export interface Incident {
  incident_id: string;
  system_id: string;
  severity: string;
  team_id: TeamId;
  initial_team_id: TeamId;
  status: 'convoking' | 'connected' | 'unanswered' | 'closed';
  monitor_name?: string;
  condition_name?: string;
  opened_at: string;
  closed_at?: string;
  room_join_url: string;
  room_call_id?: string;
  participants: { id: string; display_name: string; joined_at: string }[];
  participant_count: number;
  ever_connected: boolean;
  execution_arn?: string;
  escalation_count: number;
  last_alert_at: string;
  echo_count: number;
  close_reason?: string;
}

export interface AuditEvent {
  incident_id: string;
  event_key: string;
  ts: string;
  event_type: string;
  actor: string;
  system_id?: string;
  details: Record<string, unknown>;
}

/* ---- Formas de respuesta y de entrada derivadas del contrato (§4.1) ---- */

export type IncidentStatus = Incident['status'];
export type AvailabilityStatus = AvailabilityItem['status'];

export interface MeResponse {
  upn: string;
  name: string;
  is_admin: boolean;
}

export interface SystemSummary {
  system_id: string;
  teams: TeamId[];
  member_count: number;
}

/** Cuerpo de `PUT /admin/roster`: RosterItem sin `roster_key` ni `updated_*`. */
export type RosterInput = Omit<RosterItem, 'roster_key' | 'updated_at' | 'updated_by'>;

/** Cuerpo de `PUT /admin/availability` (el backend rellena `updated_*`). */
export type AvailabilityInput = Omit<AvailabilityItem, 'updated_at' | 'updated_by'>;

/** Cuerpo de `PUT /admin/severity-rules` (el backend rellena `updated_*`). */
export type SeverityRuleInput = Omit<SeverityRule, 'updated_at' | 'updated_by'>;

export interface IncidentListParams {
  system_id?: string;
  status?: IncidentStatus;
  limit?: number;
  cursor?: string;
}

export interface IncidentListResponse {
  items: Incident[];
  cursor?: string;
}

export interface IncidentDetailResponse {
  incident: Incident;
  events: AuditEvent[];
}

export interface AuditListParams {
  incident_id?: string;
  limit?: number;
}

/** Interfaz común de la API (implementación HTTP y simulada). */
export interface AdminApi {
  getMe(): Promise<MeResponse>;
  listSystems(): Promise<SystemSummary[]>;
  listRoster(systemId: string): Promise<RosterItem[]>;
  putRoster(input: RosterInput): Promise<RosterItem>;
  deleteRoster(systemId: string, rosterKey: string): Promise<void>;
  listAvailability(memberId?: string): Promise<AvailabilityItem[]>;
  putAvailability(input: AvailabilityInput): Promise<AvailabilityItem>;
  deleteAvailability(memberId: string, validFrom: string): Promise<void>;
  listSeverityRules(): Promise<SeverityRule[]>;
  putSeverityRule(input: SeverityRuleInput): Promise<SeverityRule>;
  deleteSeverityRule(severity: string): Promise<void>;
  listIncidents(params?: IncidentListParams): Promise<IncidentListResponse>;
  getIncident(incidentId: string): Promise<IncidentDetailResponse>;
  searchUsers(search: string): Promise<Member[]>;
  listAudit(params?: AuditListParams): Promise<AuditEvent[]>;
}
