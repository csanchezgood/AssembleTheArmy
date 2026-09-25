// Closes an incident: status=closed, close_reason, closed_at, bot leaves the room (best effort) and the
// system lock is removed.
import { AuditEvents, type Actor } from '../domain/audit.js';
import type { Incident } from '../domain/types.js';
import { GraphError } from '../graph/client.js';
import type { HandlerContext } from './context.js';
import { getGraphClient } from './context.js';

export interface CloseOptions {
  reason: string;
  actor: Actor;
  leaveRoom?: boolean;
  details?: Record<string, unknown>;
}

export async function closeIncident(ctx: HandlerContext, incident: Incident, options: CloseOptions): Promise<Incident | undefined> {
  const closedAt = ctx.now().toISOString();
  if (options.leaveRoom && incident.room_call_id) {
    try {
      await getGraphClient().leaveCall(incident.room_call_id);
    } catch (err) {
      ctx.log.warn('No se pudo abandonar la sala al cerrar el incidente', { incident_id: incident.incident_id, error: String(err) });
      await ctx.audit({
        incident_id: incident.incident_id,
        event_type: AuditEvents.graph_error,
        actor: options.actor,
        system_id: incident.system_id,
        details: { operation: 'leaveCall', message: err instanceof Error ? err.message : String(err), status: err instanceof GraphError ? err.status : undefined },
      });
    }
  }
  const updated = await ctx.repos.incidents.update(incident.incident_id, {
    status: 'closed',
    close_reason: options.reason,
    closed_at: closedAt,
    ...(options.leaveRoom ? { room_call_id: null, bot_participant_id: null } : {}),
  });
  // Only remove the lock if it still points at this incident (a newer incident may own it).
  const lock = await ctx.repos.incidents.getLock(incident.system_id);
  if (lock && lock.incident_id === incident.incident_id) {
    await ctx.repos.incidents.deleteLock(incident.system_id);
  }
  await ctx.audit({
    incident_id: incident.incident_id,
    event_type: AuditEvents.incident_closed,
    actor: options.actor,
    system_id: incident.system_id,
    details: { close_reason: options.reason, closed_at: closedAt, ...(options.details ?? {}) },
  });
  return updated;
}
