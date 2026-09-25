import type { AvailabilityStatus, IncidentStatus, TeamId } from '../api/types';

export const TEAM_IDS: readonly TeamId[] = ['N2', 'N3'];

export const INCIDENT_STATUS_LABELS: Record<IncidentStatus, string> = {
  convoking: 'Convocando',
  connected: 'Conectado',
  unanswered: 'Sin respuesta',
  closed: 'Cerrado',
};

export const INCIDENT_STATUSES: readonly IncidentStatus[] = ['convoking', 'connected', 'unanswered', 'closed'];

export const AVAILABILITY_STATUS_LABELS: Record<AvailabilityStatus, string> = {
  available: 'Disponible',
  vacation: 'Vacaciones',
  unavailable: 'No disponible',
};

export const EVENT_TYPE_LABELS: Record<string, string> = {
  alert_received: 'Alerta recibida',
  alert_ignored: 'Alerta ignorada',
  alert_echo: 'Alerta eco',
  incident_opened: 'Incidente abierto',
  roster_resolved: 'Guardia resuelta',
  backup_substituted: 'Backup sustituido',
  member_skipped_unavailable: 'Miembro omitido (no disponible)',
  room_joined: 'Bot unido a la sala',
  invite_sent: 'Invitación enviada',
  invite_failed: 'Invitación fallida',
  member_joined: 'Miembro conectado',
  member_left: 'Miembro salió',
  slot_exhausted: 'Intentos agotados',
  team_escalated: 'Escalado a otro equipo',
  notification_sent: 'Notificación enviada',
  convocation_connected: 'Convocatoria conectada',
  convocation_unanswered: 'Convocatoria sin respuesta',
  incident_closed: 'Incidente cerrado',
  graph_error: 'Error de Microsoft Graph',
  config_changed: 'Configuración modificada',
};

export const eventTypeLabel = (type: string): string => EVENT_TYPE_LABELS[type] ?? type;

/** Tono visual por tipo de evento (para la línea de tiempo). */
export function eventTone(type: string): 'ok' | 'warn' | 'error' | 'info' {
  switch (type) {
    case 'member_joined':
    case 'convocation_connected':
    case 'room_joined':
      return 'ok';
    case 'invite_failed':
    case 'graph_error':
    case 'convocation_unanswered':
      return 'error';
    case 'slot_exhausted':
    case 'team_escalated':
    case 'backup_substituted':
    case 'member_skipped_unavailable':
    case 'alert_echo':
    case 'member_left':
      return 'warn';
    default:
      return 'info';
  }
}

export const ACTOR_LABELS: Record<string, string> = {
  system: 'Sistema',
  graph: 'Microsoft Graph',
  sfn: 'Orquestador',
};

export function actorLabel(actor: string): string {
  if (actor.startsWith('admin:')) return actor.slice('admin:'.length);
  return ACTOR_LABELS[actor] ?? actor;
}

export const CLOSE_REASON_LABELS: Record<string, string> = {
  room_empty: 'Sala vacía',
  empty_on_new_alert: 'Sala vacía al llegar una nueva alerta',
  unanswered_ttl: 'Sin respuesta (tiempo agotado)',
  orphaned: 'Ejecución huérfana',
  call_terminated: 'Llamada terminada',
};

export const closeReasonLabel = (reason: string | undefined): string =>
  reason ? (CLOSE_REASON_LABELS[reason] ?? reason) : '—';

export const DETAIL_KEY_LABELS: Record<string, string> = {
  severity: 'Severidad',
  team_id: 'Equipo',
  from_team_id: 'Desde equipo',
  to_team_id: 'Hacia equipo',
  member_upn: 'Miembro',
  member_id: 'ID de miembro',
  backup_upn: 'Backup',
  display_name: 'Nombre',
  slot: 'Slot',
  attempt: 'Intento',
  attempts: 'Intentos',
  reason: 'Motivo',
  error: 'Error',
  targets: 'Objetivos',
  members: 'Miembros',
  joined: 'Conectados',
  echo_count: 'Ecos',
  close_reason: 'Motivo de cierre',
  duration_minutes: 'Duración (min)',
  room_call_id: 'ID de llamada',
  webhook_url: 'Webhook',
  ok: 'OK',
  using_backup: 'Usando backup',
  monitor_name: 'Monitor',
  condition_name: 'Condición',
  current_state: 'Estado de la alerta',
  escalation_count: 'Nº de escalaciones',
  teams_tried: 'Equipos intentados',
  sns_published: 'Publicado en SNS',
  operation: 'Operación',
  status: 'Estado',
  retry: 'Reintento',
  table: 'Tabla',
  action: 'Acción',
  roster_key: 'Clave de guardia',
  valid_from: 'Vigente desde',
  enabled: 'Habilitada',
};

export const detailKeyLabel = (key: string): string => DETAIL_KEY_LABELS[key] ?? key;
