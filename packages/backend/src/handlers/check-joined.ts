// Step Functions task: did the member join the room? Uses the incident roster, refreshing it from
// Graph when it is older than 20 s.
import { hasParticipant } from '../domain/participants.js';
import type { CheckJoinedInput, CheckJoinedOutput } from '../domain/types.js';
import { GraphError } from '../graph/client.js';
import { AuditEvents } from '../domain/audit.js';
import { createContext, getGraphClient, type HandlerContext } from '../services/context.js';
import { isRosterStale, syncParticipants } from '../services/roster-sync.js';

export function elapsedMinutes(cycleStartedAt: string, now: Date): number {
  const start = Date.parse(cycleStartedAt);
  if (Number.isNaN(start)) return 0;
  return Math.max(0, Math.round(((now.getTime() - start) / 60000) * 100) / 100);
}

export async function handler(input: CheckJoinedInput): Promise<CheckJoinedOutput> {
  return checkJoined(createContext('check-joined', { incident_id: input.incident_id }), input);
}

export async function checkJoined(ctx: HandlerContext, input: CheckJoinedInput): Promise<CheckJoinedOutput> {
  const now = ctx.now();
  let incident = await ctx.repos.incidents.get(input.incident_id);
  if (!incident) throw new Error(`Incidente ${input.incident_id} no encontrado`);

  let joined = hasParticipant(incident.participants ?? [], input.member.id);
  if (!joined && isRosterStale(incident, now)) {
    const callId = incident.room_call_id ?? input.room_call_id;
    try {
      const humans = await getGraphClient().listParticipants(callId, incident.bot_participant_id);
      incident = await syncParticipants(ctx, incident, humans, 'sfn');
      joined = hasParticipant(incident.participants, input.member.id);
    } catch (err) {
      ctx.log.warn('No se pudo refrescar el roster desde Graph', { error: String(err) });
      await ctx.audit({ incident_id: input.incident_id, event_type: AuditEvents.graph_error, actor: 'sfn', system_id: incident.system_id, details: { operation: 'listParticipants', message: err instanceof Error ? err.message : String(err), status: err instanceof GraphError ? err.status : undefined } });
    }
  }

  const elapsed = elapsedMinutes(input.cycle_started_at, now);
  const limit = input.escalate_after_minutes;
  const timeExceeded = typeof limit === 'number' && limit > 0 && elapsed >= limit;
  return { joined, elapsed_minutes: elapsed, time_exceeded: timeExceeded };
}
