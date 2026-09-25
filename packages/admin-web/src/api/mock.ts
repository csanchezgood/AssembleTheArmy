/**
 * Implementación simulada de `AdminApi` en memoria con datos de ejemplo.
 * Se activa con `VITE_MOCK_API=1` y permite ejecutar el panel sin Azure ni backend.
 */
import { ApiError } from './client';
import type {
  AdminApi,
  AuditEvent,
  AvailabilityItem,
  Incident,
  Member,
  RosterItem,
  SeverityRule,
  SystemSummary,
  TeamId,
} from './types';

export const MOCK_ACCOUNT = { name: 'Administrador de Guardia', upn: 'admin@contoso.com' };

const ADMIN_ACTOR = `admin:${MOCK_ACCOUNT.upn}`;

const USERS: Member[] = [
  { id: '7f1c2a10-0001-4c7e-9a5b-0d3f1e2a1001', upn: 'ana.garcia@contoso.com', name: 'Ana García' },
  { id: '7f1c2a10-0002-4c7e-9a5b-0d3f1e2a1002', upn: 'beto.ramirez@contoso.com', name: 'Beto Ramírez' },
  { id: '7f1c2a10-0003-4c7e-9a5b-0d3f1e2a1003', upn: 'carla.mendez@contoso.com', name: 'Carla Méndez' },
  { id: '7f1c2a10-0004-4c7e-9a5b-0d3f1e2a1004', upn: 'diego.torres@contoso.com', name: 'Diego Torres' },
  { id: '7f1c2a10-0005-4c7e-9a5b-0d3f1e2a1005', upn: 'elena.rojas@contoso.com', name: 'Elena Rojas' },
  { id: '7f1c2a10-0006-4c7e-9a5b-0d3f1e2a1006', upn: 'felipe.castro@contoso.com', name: 'Felipe Castro' },
  { id: '7f1c2a10-0007-4c7e-9a5b-0d3f1e2a1007', upn: 'gabriela.soto@contoso.com', name: 'Gabriela Soto' },
  { id: '7f1c2a10-0008-4c7e-9a5b-0d3f1e2a1008', upn: 'hector.vega@contoso.com', name: 'Héctor Vega' },
  { id: '7f1c2a10-0009-4c7e-9a5b-0d3f1e2a1009', upn: 'irene.luna@contoso.com', name: 'Irene Luna' },
  { id: '7f1c2a10-0010-4c7e-9a5b-0d3f1e2a1010', upn: 'javier.pinto@contoso.com', name: 'Javier Pinto' },
  { id: '7f1c2a10-0011-4c7e-9a5b-0d3f1e2a1011', upn: 'karla.reyes@contoso.com', name: 'Karla Reyes' },
  { id: '7f1c2a10-0012-4c7e-9a5b-0d3f1e2a1012', upn: 'luis.ortega@contoso.com', name: 'Luis Ortega' },
  { id: '7f1c2a10-0013-4c7e-9a5b-0d3f1e2a1013', upn: 'maria.paz@contoso.com', name: 'María Paz' },
  { id: '7f1c2a10-0014-4c7e-9a5b-0d3f1e2a1014', upn: 'nicolas.bravo@contoso.com', name: 'Nicolás Bravo' },
  { id: '7f1c2a10-0015-4c7e-9a5b-0d3f1e2a1015', upn: 'olga.fuentes@contoso.com', name: 'Olga Fuentes' },
  { id: '7f1c2a10-0016-4c7e-9a5b-0d3f1e2a1016', upn: 'pablo.herrera@contoso.com', name: 'Pablo Herrera' },
  { id: '7f1c2a10-0017-4c7e-9a5b-0d3f1e2a1017', upn: 'rocio.salas@contoso.com', name: 'Rocío Salas' },
  { id: '7f1c2a10-0018-4c7e-9a5b-0d3f1e2a1018', upn: 'sergio.molina@contoso.com', name: 'Sergio Molina' },
];

const SYSTEM_IDS = [
  'payments-api',
  'checkout-web',
  'orders-service',
  'inventory-api',
  'catalog-service',
  'search-api',
  'notifications-service',
  'auth-gateway',
  'user-profile-api',
  'billing-engine',
  'shipping-tracker',
  'fraud-detector',
  'pricing-engine',
  'recommendations-api',
  'mobile-bff',
  'admin-portal',
  'reporting-etl',
  'cdn-edge',
  'messaging-hub',
  'loyalty-service',
];

const SEED_TS = '2026-09-01T09:00:00.000Z';

export const rosterKey = (team: TeamId, priority: number, memberId: string): string =>
  `${team}#${String(priority).padStart(3, '0')}#${memberId}`;

const roomUrl = (systemId: string, team: TeamId): string =>
  `https://teams.microsoft.com/l/meetup-join/19%3ameeting_${team.toLowerCase()}_${systemId.replace(/-/g, '')}%40thread.v2/0?context=%7b%22Tid%22%3a%22tenant%22%2c%22Oid%22%3a%22org%22%7d`;

const user = (i: number): Member => {
  const u = USERS[((i % USERS.length) + USERS.length) % USERS.length];
  if (!u) throw new Error('unreachable');
  return u;
};

function seedRoster(): RosterItem[] {
  const items: RosterItem[] = [];
  SYSTEM_IDS.forEach((systemId, idx) => {
    const n2Count = 2 + (idx % 2);
    const n2: Member[] = [];
    for (let p = 0; p < n2Count; p++) n2.push(user(idx * 2 + p));
    const n3: Member[] = [user(idx + 7), user(idx + 11)];
    const push = (team: TeamId, members: Member[]) => {
      members.forEach((m, i) => {
        items.push({
          system_id: systemId,
          roster_key: rosterKey(team, i + 1, m.id),
          team_id: team,
          priority_order: i + 1,
          member_id: m.id,
          member_upn: m.upn,
          member_name: m.name,
          room_join_url: roomUrl(systemId, team),
          updated_at: SEED_TS,
          updated_by: ADMIN_ACTOR,
        });
      });
    };
    push('N2', n2);
    push('N3', n3);
  });
  return items;
}

function seedAvailability(): AvailabilityItem[] {
  const ana = user(0);
  const beto = user(1);
  const diego = user(3);
  const elena = user(4);
  const hector = user(7);
  const irene = user(8);
  return [
    {
      member_id: ana.id,
      valid_from: '2026-09-21T00:00:00.000Z',
      valid_until: '2026-10-05T00:00:00.000Z',
      status: 'vacation',
      backup_id: beto.id,
      backup_upn: beto.upn,
      backup_name: beto.name,
      note: 'Vacaciones de primavera',
      updated_at: SEED_TS,
      updated_by: ADMIN_ACTOR,
    },
    {
      member_id: diego.id,
      valid_from: '2026-09-24T12:00:00.000Z',
      valid_until: '2026-09-25T02:00:00.000Z',
      status: 'unavailable',
      backup_id: elena.id,
      backup_upn: elena.upn,
      backup_name: elena.name,
      note: 'Viaje sin conectividad',
      updated_at: SEED_TS,
      updated_by: ADMIN_ACTOR,
    },
    {
      member_id: hector.id,
      valid_from: '2026-10-10T00:00:00.000Z',
      valid_until: '2026-10-17T00:00:00.000Z',
      status: 'vacation',
      backup_id: irene.id,
      backup_upn: irene.upn,
      backup_name: irene.name,
      updated_at: SEED_TS,
      updated_by: ADMIN_ACTOR,
    },
  ];
}

function seedSeverityRules(): SeverityRule[] {
  return [
    {
      severity: 'critical',
      team_id: 'N3',
      notify_webhook_urls: ['https://contoso.webhook.office.com/webhookb2/n2-critical-notify'],
      enabled: true,
      updated_at: SEED_TS,
      updated_by: ADMIN_ACTOR,
    },
    {
      severity: 'high',
      team_id: 'N2',
      escalate_to_team_id: 'N3',
      escalate_after_minutes: 10,
      notify_webhook_urls: [],
      enabled: true,
      updated_at: SEED_TS,
      updated_by: ADMIN_ACTOR,
    },
    {
      severity: 'warning',
      team_id: 'N2',
      notify_webhook_urls: [],
      enabled: false,
      updated_at: SEED_TS,
      updated_by: ADMIN_ACTOR,
    },
  ];
}

interface SeedIncident {
  incident: Incident;
  events: AuditEvent[];
}

let ulidCounter = 0;
const fakeUlid = (): string => `01J8Q${String(++ulidCounter).padStart(21, '0')}`.slice(0, 26);

const addMinutes = (iso: string, minutes: number): string =>
  new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();

function makeEvent(
  incidentId: string,
  ts: string,
  eventType: string,
  actor: string,
  systemId: string,
  details: Record<string, unknown>,
): AuditEvent {
  return {
    incident_id: incidentId,
    event_key: `${ts}#${fakeUlid()}`,
    ts,
    event_type: eventType,
    actor,
    system_id: systemId,
    details,
  };
}

function seedIncidents(): SeedIncident[] {
  const ana = user(0);
  const beto = user(1);
  const carla = user(2);
  const hector = user(7);
  const irene = user(8);
  const luis = user(11);
  const list: SeedIncident[] = [];

  // 1. Incidente crítico cerrado (conectado, con eco y salida de participantes).
  {
    const id = '01J8QAZ3M7K9X2V5B4N6P8R1T0';
    const sys = 'payments-api';
    const opened = '2026-09-23T18:03:11.000Z';
    const closed = addMinutes(opened, 47);
    const t = (m: number) => addMinutes(opened, m);
    list.push({
      incident: {
        incident_id: id,
        system_id: sys,
        severity: 'critical',
        team_id: 'N3',
        initial_team_id: 'N3',
        status: 'closed',
        monitor_name: 'Payments API - error rate',
        condition_name: 'Error rate > 5% for 5 min',
        opened_at: opened,
        closed_at: closed,
        room_join_url: roomUrl(sys, 'N3'),
        room_call_id: 'call-5a1f-0001',
        participants: [],
        participant_count: 0,
        ever_connected: true,
        execution_arn: `arn:aws:states:us-east-1:123456789012:execution:ata-dev-convocation:${id}`,
        escalation_count: 0,
        last_alert_at: t(6),
        echo_count: 2,
        close_reason: 'room_empty',
      },
      events: [
        makeEvent(id, t(0), 'alert_received', 'system', sys, {
          severity: 'critical',
          monitor_name: 'Payments API - error rate',
          current_state: 'open',
        }),
        makeEvent(id, t(0), 'incident_opened', 'system', sys, { team_id: 'N3', severity: 'critical' }),
        makeEvent(id, t(0.1), 'roster_resolved', 'sfn', sys, {
          team_id: 'N3',
          targets: 2,
          members: [hector.upn, irene.upn],
        }),
        makeEvent(id, t(0.3), 'room_joined', 'sfn', sys, { room_call_id: 'call-5a1f-0001' }),
        makeEvent(id, t(0.4), 'invite_sent', 'sfn', sys, { member_upn: hector.upn, slot: 1, attempt: 1 }),
        makeEvent(id, t(0.4), 'invite_sent', 'sfn', sys, { member_upn: irene.upn, slot: 2, attempt: 1 }),
        makeEvent(id, t(1.2), 'invite_sent', 'sfn', sys, { member_upn: hector.upn, slot: 1, attempt: 2 }),
        makeEvent(id, t(1.5), 'member_joined', 'graph', sys, { member_id: irene.id, display_name: irene.name }),
        makeEvent(id, t(2.1), 'member_joined', 'graph', sys, { member_id: hector.id, display_name: hector.name }),
        makeEvent(id, t(2.2), 'convocation_connected', 'sfn', sys, { joined: 2, team_id: 'N3' }),
        makeEvent(id, t(2.3), 'notification_sent', 'sfn', sys, {
          webhook_url: 'https://contoso.webhook.office.com/webhookb2/n2-critical-notify',
          ok: true,
        }),
        makeEvent(id, t(4), 'alert_echo', 'system', sys, { echo_count: 1 }),
        makeEvent(id, t(6), 'alert_echo', 'system', sys, { echo_count: 2 }),
        makeEvent(id, t(41), 'member_left', 'graph', sys, { member_id: irene.id, display_name: irene.name }),
        makeEvent(id, t(46.5), 'member_left', 'graph', sys, { member_id: hector.id, display_name: hector.name }),
        makeEvent(id, t(47), 'incident_closed', 'system', sys, { close_reason: 'room_empty', duration_minutes: 47 }),
      ],
    });
  }

  // 2. Incidente high conectado actualmente, con sustitución de backup.
  {
    const id = '01J8QB7H2D4F6G8J0K1L3M5N7P';
    const sys = 'checkout-web';
    const opened = '2026-09-24T14:20:45.000Z';
    const t = (m: number) => addMinutes(opened, m);
    list.push({
      incident: {
        incident_id: id,
        system_id: sys,
        severity: 'high',
        team_id: 'N2',
        initial_team_id: 'N2',
        status: 'connected',
        monitor_name: 'Checkout Web - latency p95',
        condition_name: 'p95 > 2500 ms for 10 min',
        opened_at: opened,
        room_join_url: roomUrl(sys, 'N2'),
        room_call_id: 'call-5a1f-0002',
        participants: [
          { id: beto.id, display_name: beto.name, joined_at: t(1.8) },
          { id: carla.id, display_name: carla.name, joined_at: t(2.4) },
        ],
        participant_count: 2,
        ever_connected: true,
        execution_arn: `arn:aws:states:us-east-1:123456789012:execution:ata-dev-convocation:${id}`,
        escalation_count: 0,
        last_alert_at: t(9),
        echo_count: 1,
      },
      events: [
        makeEvent(id, t(0), 'alert_received', 'system', sys, { severity: 'high', current_state: 'open' }),
        makeEvent(id, t(0), 'incident_opened', 'system', sys, { team_id: 'N2', severity: 'high' }),
        makeEvent(id, t(0.1), 'backup_substituted', 'sfn', sys, {
          member_upn: ana.upn,
          backup_upn: beto.upn,
          reason: 'vacation',
        }),
        makeEvent(id, t(0.1), 'roster_resolved', 'sfn', sys, { team_id: 'N2', targets: 2 }),
        makeEvent(id, t(0.3), 'room_joined', 'sfn', sys, { room_call_id: 'call-5a1f-0002' }),
        makeEvent(id, t(0.4), 'invite_sent', 'sfn', sys, { member_upn: beto.upn, slot: 1, attempt: 1, using_backup: true }),
        makeEvent(id, t(0.4), 'invite_sent', 'sfn', sys, { member_upn: carla.upn, slot: 2, attempt: 1 }),
        makeEvent(id, t(1.8), 'member_joined', 'graph', sys, { member_id: beto.id, display_name: beto.name }),
        makeEvent(id, t(2.4), 'member_joined', 'graph', sys, { member_id: carla.id, display_name: carla.name }),
        makeEvent(id, t(2.5), 'convocation_connected', 'sfn', sys, { joined: 2, team_id: 'N2' }),
        makeEvent(id, t(9), 'alert_echo', 'system', sys, { echo_count: 1 }),
      ],
    });
  }

  // 3. Incidente sin respuesta con escalación N2 → N3.
  {
    const id = '01J8QC0Q9R8S7T6U5V4W3X2Y1Z';
    const sys = 'orders-service';
    const opened = '2026-09-22T03:12:00.000Z';
    const closed = addMinutes(opened, 85);
    const t = (m: number) => addMinutes(opened, m);
    list.push({
      incident: {
        incident_id: id,
        system_id: sys,
        severity: 'high',
        team_id: 'N3',
        initial_team_id: 'N2',
        status: 'closed',
        monitor_name: 'Orders Service - queue depth',
        condition_name: 'Queue depth > 10k for 15 min',
        opened_at: opened,
        closed_at: closed,
        room_join_url: roomUrl(sys, 'N3'),
        participants: [],
        participant_count: 0,
        ever_connected: false,
        execution_arn: `arn:aws:states:us-east-1:123456789012:execution:ata-dev-convocation:${id}`,
        escalation_count: 1,
        last_alert_at: opened,
        echo_count: 0,
        close_reason: 'unanswered_ttl',
      },
      events: [
        makeEvent(id, t(0), 'alert_received', 'system', sys, { severity: 'high', current_state: 'open' }),
        makeEvent(id, t(0), 'incident_opened', 'system', sys, { team_id: 'N2', severity: 'high' }),
        makeEvent(id, t(0.1), 'roster_resolved', 'sfn', sys, { team_id: 'N2', targets: 2 }),
        makeEvent(id, t(0.3), 'room_joined', 'sfn', sys, { room_call_id: 'call-5a1f-0003' }),
        makeEvent(id, t(0.4), 'invite_sent', 'sfn', sys, { member_upn: user(4).upn, slot: 1, attempt: 1 }),
        makeEvent(id, t(0.4), 'invite_failed', 'sfn', sys, {
          member_upn: user(5).upn,
          slot: 2,
          attempt: 1,
          error: 'Graph 404: user has no Teams license',
        }),
        makeEvent(id, t(1.2), 'invite_sent', 'sfn', sys, { member_upn: user(4).upn, slot: 1, attempt: 2 }),
        makeEvent(id, t(2.0), 'invite_sent', 'sfn', sys, { member_upn: user(4).upn, slot: 1, attempt: 3 }),
        makeEvent(id, t(2.8), 'invite_sent', 'sfn', sys, { member_upn: user(4).upn, slot: 1, attempt: 4 }),
        makeEvent(id, t(3.6), 'invite_sent', 'sfn', sys, { member_upn: user(4).upn, slot: 1, attempt: 5 }),
        makeEvent(id, t(4.4), 'slot_exhausted', 'sfn', sys, { member_upn: user(4).upn, slot: 1, attempts: 5 }),
        makeEvent(id, t(4.5), 'team_escalated', 'sfn', sys, { from_team_id: 'N2', to_team_id: 'N3', escalation_count: 1 }),
        makeEvent(id, t(4.6), 'roster_resolved', 'sfn', sys, { team_id: 'N3', targets: 2 }),
        makeEvent(id, t(4.8), 'invite_sent', 'sfn', sys, { member_upn: user(9).upn, slot: 1, attempt: 1 }),
        makeEvent(id, t(4.8), 'invite_sent', 'sfn', sys, { member_upn: luis.upn, slot: 2, attempt: 1 }),
        makeEvent(id, t(9), 'slot_exhausted', 'sfn', sys, { member_upn: user(9).upn, slot: 1, attempts: 5 }),
        makeEvent(id, t(9), 'slot_exhausted', 'sfn', sys, { member_upn: luis.upn, slot: 2, attempts: 5 }),
        makeEvent(id, t(9.1), 'convocation_unanswered', 'sfn', sys, { teams_tried: ['N2', 'N3'], sns_published: true }),
        makeEvent(id, t(85), 'incident_closed', 'system', sys, { close_reason: 'unanswered_ttl' }),
      ],
    });
  }

  // 4. Incidente convocando ahora mismo.
  {
    const id = '01J8QD5E4F3G2H1J0K9L8M7N6P';
    const sys = 'auth-gateway';
    const opened = '2026-09-24T16:58:02.000Z';
    const t = (m: number) => addMinutes(opened, m);
    list.push({
      incident: {
        incident_id: id,
        system_id: sys,
        severity: 'critical',
        team_id: 'N3',
        initial_team_id: 'N3',
        status: 'convoking',
        monitor_name: 'Auth Gateway - availability',
        condition_name: 'Synthetic check failing (3 locations)',
        opened_at: opened,
        room_join_url: roomUrl(sys, 'N3'),
        room_call_id: 'call-5a1f-0004',
        participants: [],
        participant_count: 0,
        ever_connected: false,
        execution_arn: `arn:aws:states:us-east-1:123456789012:execution:ata-dev-convocation:${id}`,
        escalation_count: 0,
        last_alert_at: opened,
        echo_count: 0,
      },
      events: [
        makeEvent(id, t(0), 'alert_received', 'system', sys, { severity: 'critical', current_state: 'open' }),
        makeEvent(id, t(0), 'incident_opened', 'system', sys, { team_id: 'N3', severity: 'critical' }),
        makeEvent(id, t(0.1), 'member_skipped_unavailable', 'sfn', sys, {
          member_upn: user(3).upn,
          backup_upn: user(4).upn,
          reason: 'both_unavailable',
        }),
        makeEvent(id, t(0.1), 'roster_resolved', 'sfn', sys, { team_id: 'N3', targets: 1 }),
        makeEvent(id, t(0.3), 'room_joined', 'sfn', sys, { room_call_id: 'call-5a1f-0004' }),
        makeEvent(id, t(0.4), 'invite_sent', 'sfn', sys, { member_upn: user(18).upn, slot: 1, attempt: 1 }),
      ],
    });
  }

  // 5. Incidente warning cerrado sin conexión (regla deshabilitada después).
  {
    const id = '01J8QE9A8B7C6D5E4F3G2H1J0K';
    const sys = 'search-api';
    const opened = '2026-09-20T11:40:00.000Z';
    const closed = addMinutes(opened, 63);
    const t = (m: number) => addMinutes(opened, m);
    list.push({
      incident: {
        incident_id: id,
        system_id: sys,
        severity: 'warning',
        team_id: 'N2',
        initial_team_id: 'N2',
        status: 'unanswered',
        monitor_name: 'Search API - slow queries',
        condition_name: 'Slow queries > 200/min',
        opened_at: opened,
        closed_at: closed,
        room_join_url: roomUrl(sys, 'N2'),
        participants: [],
        participant_count: 0,
        ever_connected: false,
        escalation_count: 0,
        last_alert_at: t(20),
        echo_count: 3,
      },
      events: [
        makeEvent(id, t(0), 'alert_received', 'system', sys, { severity: 'warning', current_state: 'open' }),
        makeEvent(id, t(0), 'incident_opened', 'system', sys, { team_id: 'N2', severity: 'warning' }),
        makeEvent(id, t(0.2), 'roster_resolved', 'sfn', sys, { team_id: 'N2', targets: 2 }),
        makeEvent(id, t(0.5), 'graph_error', 'sfn', sys, { operation: 'join_room', status: 503, retry: 1 }),
        makeEvent(id, t(0.9), 'room_joined', 'sfn', sys, { room_call_id: 'call-5a1f-0005' }),
        makeEvent(id, t(1), 'invite_sent', 'sfn', sys, { member_upn: user(10).upn, slot: 1, attempt: 1 }),
        makeEvent(id, t(1), 'invite_sent', 'sfn', sys, { member_upn: user(11).upn, slot: 2, attempt: 1 }),
        makeEvent(id, t(5), 'alert_echo', 'system', sys, { echo_count: 1 }),
        makeEvent(id, t(6), 'slot_exhausted', 'sfn', sys, { member_upn: user(10).upn, slot: 1, attempts: 5 }),
        makeEvent(id, t(6), 'slot_exhausted', 'sfn', sys, { member_upn: user(11).upn, slot: 2, attempts: 5 }),
        makeEvent(id, t(6.1), 'convocation_unanswered', 'sfn', sys, { teams_tried: ['N2'], sns_published: true }),
        makeEvent(id, t(12), 'alert_echo', 'system', sys, { echo_count: 2 }),
        makeEvent(id, t(20), 'alert_echo', 'system', sys, { echo_count: 3 }),
      ],
    });
  }

  return list;
}

function seedAdminAudit(): AuditEvent[] {
  return [
    makeEvent('ADMIN', '2026-09-01T09:00:00.000Z', 'config_changed', ADMIN_ACTOR, 'payments-api', {
      table: 'roster',
      action: 'put',
      roster_key: rosterKey('N2', 1, user(0).id),
    }),
    makeEvent('ADMIN', '2026-09-15T15:12:00.000Z', 'config_changed', ADMIN_ACTOR, '', {
      table: 'severity_rules',
      action: 'put',
      severity: 'warning',
      enabled: false,
    }),
  ];
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export interface MockApiOptions {
  /** Retardo artificial por llamada (ms). 0 en pruebas. */
  latencyMs?: number;
  /** Reloj inyectable para `updated_at` y auditoría. */
  now?: () => Date;
}

export function createMockApi(options: MockApiOptions = {}): AdminApi {
  const latency = options.latencyMs ?? 150;
  const now = options.now ?? (() => new Date());

  const roster: RosterItem[] = seedRoster();
  const availability: AvailabilityItem[] = seedAvailability();
  const severityRules: SeverityRule[] = seedSeverityRules();
  const incidents: SeedIncident[] = seedIncidents();
  const audit: AuditEvent[] = seedAdminAudit();

  const wait = (): Promise<void> =>
    latency > 0 ? new Promise((resolve) => setTimeout(resolve, latency)) : Promise.resolve();

  const stamp = () => ({ updated_at: now().toISOString(), updated_by: ADMIN_ACTOR });

  const auditChange = (systemId: string, details: Record<string, unknown>) => {
    audit.push(makeEvent('ADMIN', now().toISOString(), 'config_changed', ADMIN_ACTOR, systemId, details));
  };

  return {
    async getMe() {
      await wait();
      return { upn: MOCK_ACCOUNT.upn, name: MOCK_ACCOUNT.name, is_admin: true };
    },

    async listSystems() {
      await wait();
      const map = new Map<string, SystemSummary>();
      for (const item of roster) {
        const entry = map.get(item.system_id) ?? { system_id: item.system_id, teams: [], member_count: 0 };
        if (!entry.teams.includes(item.team_id)) entry.teams.push(item.team_id);
        entry.member_count += 1;
        map.set(item.system_id, entry);
      }
      return [...map.values()]
        .map((s) => ({ ...s, teams: [...s.teams].sort() }))
        .sort((a, b) => a.system_id.localeCompare(b.system_id));
    },

    async listRoster(systemId) {
      await wait();
      return clone(
        roster
          .filter((r) => r.system_id === systemId)
          .sort((a, b) => a.roster_key.localeCompare(b.roster_key)),
      );
    },

    async putRoster(input) {
      await wait();
      if (!input.system_id || !input.member_id || !input.room_join_url) {
        throw new ApiError(400, 'system_id, member_id y room_join_url son obligatorios');
      }
      const key = rosterKey(input.team_id, input.priority_order, input.member_id);
      const item: RosterItem = { ...clone(input), roster_key: key, ...stamp() };
      const idx = roster.findIndex((r) => r.system_id === item.system_id && r.roster_key === key);
      if (idx >= 0) roster[idx] = item;
      else roster.push(item);
      auditChange(item.system_id, { table: 'roster', action: 'put', roster_key: key });
      return clone(item);
    },

    async deleteRoster(systemId, key) {
      await wait();
      const idx = roster.findIndex((r) => r.system_id === systemId && r.roster_key === key);
      if (idx < 0) throw new ApiError(404, 'Miembro de guardia no encontrado');
      roster.splice(idx, 1);
      auditChange(systemId, { table: 'roster', action: 'delete', roster_key: key });
    },

    async listAvailability(memberId) {
      await wait();
      const items = memberId ? availability.filter((a) => a.member_id === memberId) : availability;
      return clone([...items].sort((a, b) => a.valid_from.localeCompare(b.valid_from)));
    },

    async putAvailability(input) {
      await wait();
      if (input.valid_from >= input.valid_until) {
        throw new ApiError(400, 'valid_from debe ser anterior a valid_until');
      }
      const item: AvailabilityItem = { ...clone(input), ...stamp() };
      const idx = availability.findIndex(
        (a) => a.member_id === item.member_id && a.valid_from === item.valid_from,
      );
      if (idx >= 0) availability[idx] = item;
      else availability.push(item);
      auditChange('', { table: 'availability', action: 'put', member_id: item.member_id, valid_from: item.valid_from });
      return clone(item);
    },

    async deleteAvailability(memberId, validFrom) {
      await wait();
      const idx = availability.findIndex((a) => a.member_id === memberId && a.valid_from === validFrom);
      if (idx < 0) throw new ApiError(404, 'Ventana de disponibilidad no encontrada');
      availability.splice(idx, 1);
      auditChange('', { table: 'availability', action: 'delete', member_id: memberId, valid_from: validFrom });
    },

    async listSeverityRules() {
      await wait();
      return clone([...severityRules].sort((a, b) => a.severity.localeCompare(b.severity)));
    },

    async putSeverityRule(input) {
      await wait();
      if (!/^[a-z0-9_-]+$/.test(input.severity)) {
        throw new ApiError(400, 'severity debe ir en minúsculas sin espacios');
      }
      const item: SeverityRule = { ...clone(input), ...stamp() };
      const idx = severityRules.findIndex((r) => r.severity === item.severity);
      if (idx >= 0) severityRules[idx] = item;
      else severityRules.push(item);
      auditChange('', { table: 'severity_rules', action: 'put', severity: item.severity, enabled: item.enabled });
      return clone(item);
    },

    async deleteSeverityRule(severity) {
      await wait();
      const idx = severityRules.findIndex((r) => r.severity === severity);
      if (idx < 0) throw new ApiError(404, 'Regla de severidad no encontrada');
      severityRules.splice(idx, 1);
      auditChange('', { table: 'severity_rules', action: 'delete', severity });
    },

    async listIncidents(params = {}) {
      await wait();
      let items = incidents.map((i) => i.incident);
      if (params.system_id) items = items.filter((i) => i.system_id === params.system_id);
      if (params.status) items = items.filter((i) => i.status === params.status);
      items = [...items].sort((a, b) => b.opened_at.localeCompare(a.opened_at));
      const limit = params.limit ?? 50;
      const start = params.cursor ? Number.parseInt(params.cursor, 10) || 0 : 0;
      const page = items.slice(start, start + limit);
      const next = start + limit < items.length ? String(start + limit) : undefined;
      return next ? { items: clone(page), cursor: next } : { items: clone(page) };
    },

    async getIncident(incidentId) {
      await wait();
      const found = incidents.find((i) => i.incident.incident_id === incidentId);
      if (!found) throw new ApiError(404, `Incidente ${incidentId} no encontrado`);
      return clone({
        incident: found.incident,
        events: [...found.events].sort((a, b) => a.event_key.localeCompare(b.event_key)),
      });
    },

    async searchUsers(search) {
      await wait();
      const q = search.trim().toLowerCase();
      if (!q) return [];
      return clone(
        USERS.filter((u) => u.name.toLowerCase().includes(q) || u.upn.toLowerCase().includes(q)).slice(0, 10),
      );
    },

    async listAudit(params = {}) {
      await wait();
      const id = params.incident_id ?? 'ADMIN';
      const source =
        id === 'ADMIN' ? audit : (incidents.find((i) => i.incident.incident_id === id)?.events ?? []);
      const sorted = [...source].sort((a, b) => b.event_key.localeCompare(a.event_key));
      return clone(params.limit ? sorted.slice(0, params.limit) : sorted);
    },
  };
}

/** Usuarios de ejemplo (útiles en pruebas). */
export const MOCK_USERS: readonly Member[] = USERS;
export const MOCK_SYSTEM_IDS: readonly string[] = SYSTEM_IDS;
