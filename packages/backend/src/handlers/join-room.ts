// Step Functions task: the bot joins the team's persistent meeting (or reuses the live call).
import { AuditEvents } from '../domain/audit.js';
import type { JoinRoomInput, JoinRoomOutput } from '../domain/types.js';
import { graphEnv } from '../infra/env.js';
import { GraphError } from '../graph/client.js';
import { createContext, getGraphClient, type HandlerContext } from '../services/context.js';

export class RoomJoinFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoomJoinFailed';
  }
}

export function buildCallbackUri(baseUrl: string, incidentId: string): string {
  const sep = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${sep}incident_id=${encodeURIComponent(incidentId)}`;
}

export async function handler(input: JoinRoomInput): Promise<JoinRoomOutput> {
  return joinRoom(createContext('join-room', { incident_id: input.incident_id }), input);
}

export async function joinRoom(ctx: HandlerContext, input: JoinRoomInput): Promise<JoinRoomOutput> {
  const graph = getGraphClient();
  const incident = await ctx.repos.incidents.get(input.incident_id);
  if (!incident) throw new RoomJoinFailed(`Incidente ${input.incident_id} no encontrado`);
  const joinUrl = input.room_join_url || incident.room_join_url;

  if (incident.room_call_id) {
    try {
      const call = await graph.getCall(incident.room_call_id);
      if (call && call.state !== 'terminated') {
        ctx.log.info('Reutilizando la llamada existente de la sala', { room_call_id: incident.room_call_id });
        return { room_call_id: incident.room_call_id, bot_participant_id: incident.bot_participant_id ?? call.myParticipantId ?? '' };
      }
    } catch (err) {
      ctx.log.warn('No se pudo comprobar la llamada existente; se unirá de nuevo', { error: String(err) });
    }
  }

  if (!joinUrl) throw new RoomJoinFailed('El incidente no tiene room_join_url');
  const callbackUri = buildCallbackUri(graphEnv().callbackUrl, input.incident_id);
  try {
    const result = await graph.joinMeeting(joinUrl, callbackUri);
    await ctx.repos.incidents.update(input.incident_id, { room_call_id: result.callId, bot_participant_id: result.botParticipantId, room_join_url: joinUrl });
    await ctx.audit({ incident_id: input.incident_id, event_type: AuditEvents.room_joined, actor: 'sfn', system_id: incident.system_id, details: { room_call_id: result.callId, bot_participant_id: result.botParticipantId, room_join_url: joinUrl } });
    return { room_call_id: result.callId, bot_participant_id: result.botParticipantId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await ctx.audit({ incident_id: input.incident_id, event_type: AuditEvents.graph_error, actor: 'sfn', system_id: incident.system_id, details: { operation: 'joinMeeting', message, status: err instanceof GraphError ? err.status : undefined, code: err instanceof GraphError ? err.code : undefined } });
    throw new RoomJoinFailed(message);
  }
}
