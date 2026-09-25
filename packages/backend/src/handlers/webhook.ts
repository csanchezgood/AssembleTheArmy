// POST /webhook/newrelic — validates the shared secret, deduplicates and starts a convocation.
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { ulid } from 'ulid';
import { AuditEvents, systemAuditPk } from '../domain/audit.js';
import { decideBeforeLock, decideOnLock, lockTtlFor, type IgnoreReason } from '../domain/dedupe.js';
import { normalizeSeverity, normalizeSystemId } from '../domain/rules.js';
import type { ConvocationPolicy, Incident, StateMachineInput, WebhookPayload, WebhookResponseBody } from '../domain/types.js';
import { webhookEnv } from '../infra/env.js';
import { constantTimeEqual, emptyResponse, errorResponse, getHeader, jsonResponse, parseJsonBody, type HttpResponse } from '../infra/http.js';
import { emitConfigError } from '../infra/metrics.js';
import { getSecretJsonField } from '../infra/secrets.js';
import { GraphError } from '../graph/client.js';
import { createContext, getGraphClient, type HandlerContext } from '../services/context.js';
import { closeIncident } from '../services/incident-close.js';

let sfnClient: SFNClient | undefined;
function getSfn(): SFNClient {
  if (!sfnClient) sfnClient = new SFNClient({});
  return sfnClient;
}

export function parseWebhookPayload(body: unknown): WebhookPayload | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const b = body as Record<string, unknown>;
  const str = (k: string): string | undefined => (typeof b[k] === 'string' && (b[k] as string).trim() !== '' ? (b[k] as string) : undefined);
  const system_tag = str('system_tag');
  const severity = str('severity');
  const current_state = str('current_state');
  if (!system_tag || !severity || !current_state) return undefined;
  const payload: WebhookPayload = { system_tag, severity, current_state };
  const monitor_name = str('monitor_name');
  const condition_name = str('condition_name');
  const timestamp = str('timestamp');
  const issue_id = str('issue_id');
  const issue_url = str('issue_url');
  if (monitor_name) payload.monitor_name = monitor_name;
  if (condition_name) payload.condition_name = condition_name;
  if (timestamp) payload.timestamp = timestamp;
  if (issue_id) payload.issue_id = issue_id;
  if (issue_url) payload.issue_url = issue_url;
  return payload;
}

export async function handler(event: APIGatewayProxyEventV2): Promise<HttpResponse> {
  const env = webhookEnv();
  const expected = await getSecretJsonField(env.webhookSecretArn, 'secret');
  if (!constantTimeEqual(getHeader(event, 'x-webhook-secret'), expected)) {
    return emptyResponse(401);
  }
  const payload = parseWebhookPayload(parseJsonBody(event));
  if (!payload) return errorResponse(400, 'Cuerpo inválido: se requieren system_tag, severity y current_state');

  const ctx = createContext('webhook');
  const body = await processAlert(ctx, payload, env);
  return jsonResponse(200, body);
}

export async function processAlert(ctx: HandlerContext, payload: WebhookPayload, env: ReturnType<typeof webhookEnv>): Promise<WebhookResponseBody> {
  const systemId = normalizeSystemId(payload.system_tag);
  const severity = normalizeSeverity(payload.severity);
  const nowIso = ctx.now().toISOString();
  const alertDetails = {
    severity,
    current_state: payload.current_state,
    monitor_name: payload.monitor_name,
    condition_name: payload.condition_name,
    timestamp: payload.timestamp,
    issue_id: payload.issue_id,
    issue_url: payload.issue_url,
  };
  await ctx.audit({ incident_id: systemAuditPk(systemId), event_type: AuditEvents.alert_received, actor: 'system', system_id: systemId, details: alertDetails });

  const ignore = async (reason: IgnoreReason): Promise<WebhookResponseBody> => {
    await ctx.audit({ incident_id: systemAuditPk(systemId), event_type: AuditEvents.alert_ignored, actor: 'system', system_id: systemId, details: { ...alertDetails, reason } });
    if (reason === 'no_roster') emitConfigError('no_roster', { system_id: systemId, severity });
    ctx.log.info('Alerta ignorada', { system_id: systemId, severity, reason });
    return { result: 'ignored', reason };
  };

  // Steps 3-5.
  if (payload.current_state.trim().toLowerCase() !== 'open') return ignore('state_not_open');
  const rule = await ctx.repos.severity.get(severity);
  const teamId = rule?.enabled ? rule.team_id : undefined;
  const rosterCount = teamId ? (await ctx.repos.roster.listBySystemAndTeam(systemId, teamId)).length : 0;
  const pre = decideBeforeLock(payload, rule, rosterCount);
  if (pre.kind === 'ignored') return ignore(pre.reason);

  // Step 6.
  const lock = await ctx.repos.incidents.getLock(systemId);
  const existing = lock ? await ctx.repos.incidents.get(lock.incident_id) : undefined;
  let decision = decideOnLock(lock, existing);
  if (decision.kind === 'check_participants') {
    const humans = await countHumans(ctx, decision.incident);
    decision = decideOnLock(lock, existing, humans);
  }
  if (decision.kind === 'echo') {
    return echo(ctx, decision.incident, nowIso, alertDetails);
  }
  if (decision.kind === 'close_and_convoke') {
    await closeIncident(ctx, decision.incident, { reason: decision.close_reason, actor: 'system', leaveRoom: true });
  } else if (decision.kind === 'convoke' && decision.stale_lock) {
    await ctx.repos.incidents.deleteLock(systemId);
  } else if (decision.kind !== 'convoke') {
    // check_participants cannot happen here (already resolved above); treat defensively as echo.
    return echo(ctx, decision.incident, nowIso, alertDetails);
  }

  // Step 7.
  const incidentId = ulid();
  const acquired = await ctx.repos.incidents.createLock({ system_id: systemId, incident_id: incidentId, created_at: nowIso, ttl: lockTtlFor(ctx.now()) });
  if (!acquired) {
    const raceLock = await ctx.repos.incidents.getLock(systemId);
    const raceIncident = raceLock ? await ctx.repos.incidents.get(raceLock.incident_id) : undefined;
    if (raceIncident) return echo(ctx, raceIncident, nowIso, alertDetails);
    return { result: 'echo', reason: 'lock_race' };
  }

  const roomJoinUrl = (await ctx.repos.roster.listBySystemAndTeam(systemId, pre.rule.team_id)).find((r) => r.room_join_url)?.room_join_url ?? '';
  const incident: Incident = {
    incident_id: incidentId,
    system_id: systemId,
    severity,
    team_id: pre.rule.team_id,
    initial_team_id: pre.rule.team_id,
    status: 'convoking',
    ...(payload.monitor_name ? { monitor_name: payload.monitor_name } : {}),
    ...(payload.condition_name ? { condition_name: payload.condition_name } : {}),
    opened_at: nowIso,
    room_join_url: roomJoinUrl,
    participants: [],
    participant_count: 0,
    ever_connected: false,
    escalation_count: 0,
    last_alert_at: nowIso,
    echo_count: 0,
  };
  await ctx.repos.incidents.put(incident);
  await ctx.audit({ incident_id: incidentId, event_type: AuditEvents.incident_opened, actor: 'system', system_id: systemId, details: { ...alertDetails, team_id: pre.rule.team_id } });

  const policy: ConvocationPolicy = { max_attempts: env.maxAttempts, ring_timeout_seconds: env.ringTimeoutSeconds, max_escalations: env.maxEscalations };
  const input: StateMachineInput = { incident_id: incidentId, system_id: systemId, severity, team_id: pre.rule.team_id, escalation_count: 0, policy };
  const executionArn = await startExecution(env.stateMachineArn, incidentId, input);
  if (executionArn) await ctx.repos.incidents.update(incidentId, { execution_arn: executionArn });
  ctx.log.info('Convocatoria iniciada', { incident_id: incidentId, system_id: systemId, team_id: pre.rule.team_id });
  return { result: 'convoked', incident_id: incidentId };
}

async function echo(ctx: HandlerContext, incident: Incident, nowIso: string, details: Record<string, unknown>): Promise<WebhookResponseBody> {
  await ctx.repos.incidents.recordEcho(incident.incident_id, nowIso);
  await ctx.audit({ incident_id: incident.incident_id, event_type: AuditEvents.alert_echo, actor: 'system', system_id: incident.system_id, details: { ...details, status: incident.status } });
  return { result: 'echo', incident_id: incident.incident_id };
}

/** Humans in the incident room according to Graph; falls back to the stored count on Graph errors. */
async function countHumans(ctx: HandlerContext, incident: Incident): Promise<number> {
  if (!incident.room_call_id) return 0;
  try {
    const humans = await getGraphClient().listParticipants(incident.room_call_id, incident.bot_participant_id);
    return humans.length;
  } catch (err) {
    if (err instanceof GraphError && err.isNotFound) return 0;
    ctx.log.warn('No se pudo consultar participantes en Graph; se usa el conteo almacenado', { incident_id: incident.incident_id, error: String(err) });
    await ctx.audit({ incident_id: incident.incident_id, event_type: AuditEvents.graph_error, actor: 'system', system_id: incident.system_id, details: { operation: 'listParticipants', message: err instanceof Error ? err.message : String(err) } });
    return incident.participant_count ?? 0;
  }
}

async function startExecution(stateMachineArn: string, incidentId: string, input: StateMachineInput): Promise<string | undefined> {
  try {
    const res = await getSfn().send(new StartExecutionCommand({ stateMachineArn, name: incidentId, input: JSON.stringify(input) }));
    return res.executionArn;
  } catch (err) {
    if (typeof err === 'object' && err !== null && (err as { name?: string }).name === 'ExecutionAlreadyExists') return undefined;
    throw err;
  }
}
