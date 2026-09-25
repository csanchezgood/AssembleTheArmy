// POST /graph/callback — Graph cloud communications notifications for the bot's calls.
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { AuditEvents } from '../domain/audit.js';
import type { Incident } from '../domain/types.js';
import { graphEnv } from '../infra/env.js';
import { emptyResponse, getHeader, parseJsonBody, type HttpResponse } from '../infra/http.js';
import { filterHumanParticipants, type GraphParticipant } from '../graph/client.js';
import { bearerToken, classifyNotification, parseNotifications, verifyBotFrameworkToken } from '../graph/notifications.js';
import { createContext, type HandlerContext } from '../services/context.js';
import { closeIncident } from '../services/incident-close.js';
import { syncParticipants } from '../services/roster-sync.js';

export async function handler(event: APIGatewayProxyEventV2): Promise<HttpResponse> {
  const env = graphEnv();
  const token = bearerToken(getHeader(event, 'authorization'));
  if (!token) return emptyResponse(401);
  try {
    await verifyBotFrameworkToken(token, { audience: env.clientId });
  } catch {
    return emptyResponse(401);
  }

  const ctx = createContext('graph-callback');
  const incidentId = event.queryStringParameters?.['incident_id'];
  const notifications = parseNotifications(parseJsonBody(event));
  if (!incidentId) {
    ctx.log.warn('Notificación de Graph sin incident_id en la query string');
    return emptyResponse(202);
  }
  try {
    await processNotifications(ctx, incidentId, notifications);
  } catch (err) {
    // Never let Graph retry storms build up: log and acknowledge.
    ctx.log.error('Error procesando notificación de Graph', { incident_id: incidentId, error: String(err) });
  }
  return emptyResponse(202);
}

export async function processNotifications(ctx: HandlerContext, incidentId: string, notifications: ReturnType<typeof parseNotifications>): Promise<void> {
  if (notifications.length === 0) return;
  let incident = await ctx.repos.incidents.get(incidentId);
  if (!incident) {
    ctx.log.warn('Notificación para un incidente inexistente', { incident_id: incidentId });
    return;
  }
  for (const n of notifications) {
    const classified = classifyNotification(n);
    if (classified.kind === 'other') continue;
    if (incident.room_call_id && incident.room_call_id !== classified.callId) {
      ctx.log.info('Notificación de una llamada distinta a la sala del incidente; ignorada', { incident_id: incidentId, call_id: classified.callId });
      continue;
    }
    if (classified.kind === 'participants') {
      const humans = filterHumanParticipants(classified.participants as GraphParticipant[], incident.bot_participant_id);
      incident = await syncParticipants(ctx, incident, humans, 'graph');
      continue;
    }
    if (classified.kind === 'call' && classified.state === 'terminated') {
      incident = await handleTerminated(ctx, incident);
    }
  }
}

async function handleTerminated(ctx: HandlerContext, incident: Incident): Promise<Incident> {
  if (incident.status === 'closed') return incident;
  ctx.log.info('La llamada de la sala terminó', { incident_id: incident.incident_id, ever_connected: incident.ever_connected });
  if (incident.ever_connected) {
    const closed = await closeIncident(ctx, incident, { reason: 'call_terminated', actor: 'graph', leaveRoom: false });
    const updated = await ctx.repos.incidents.update(incident.incident_id, { room_call_id: null, bot_participant_id: null });
    return updated ?? closed ?? incident;
  }
  await ctx.audit({ incident_id: incident.incident_id, event_type: AuditEvents.graph_error, actor: 'graph', system_id: incident.system_id, details: { operation: 'call_terminated', message: 'La llamada de la sala terminó antes de que alguien se conectara' } });
  const updated = await ctx.repos.incidents.update(incident.incident_id, { room_call_id: null, bot_participant_id: null });
  return updated ?? { ...incident, room_call_id: undefined, bot_participant_id: undefined };
}
