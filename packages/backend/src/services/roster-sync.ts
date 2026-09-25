// Applies a list of humans in the room to an incident: diff-audits member_joined/member_left and
// persists participants, participant_count, ever_connected and participants_updated_at.
import { AuditEvents, type Actor } from '../domain/audit.js';
import { diffParticipants, type HumanParticipant } from '../domain/participants.js';
import type { Incident } from '../domain/types.js';
import type { HandlerContext } from './context.js';

export const ROSTER_STALE_MS = 20 * 1000;

export function isRosterStale(incident: Incident, now: Date): boolean {
  if (!incident.participants_updated_at) return true;
  const updated = Date.parse(incident.participants_updated_at);
  return Number.isNaN(updated) || now.getTime() - updated > ROSTER_STALE_MS;
}

export async function syncParticipants(ctx: HandlerContext, incident: Incident, humans: readonly HumanParticipant[], actor: Actor): Promise<Incident> {
  const nowIso = ctx.now().toISOString();
  const diff = diffParticipants(incident.participants ?? [], humans, nowIso);
  for (const p of diff.joined) {
    await ctx.audit({
      incident_id: incident.incident_id,
      event_type: AuditEvents.member_joined,
      actor,
      system_id: incident.system_id,
      details: { member_id: p.id, display_name: p.display_name, participant_count: diff.participants.length },
    });
  }
  for (const p of diff.left) {
    await ctx.audit({
      incident_id: incident.incident_id,
      event_type: AuditEvents.member_left,
      actor,
      system_id: incident.system_id,
      details: { member_id: p.id, display_name: p.display_name, participant_count: diff.participants.length },
    });
  }
  const everConnected = incident.ever_connected || diff.participants.length > 0;
  const updated = await ctx.repos.incidents.update(incident.incident_id, {
    participants: diff.participants,
    participant_count: diff.participants.length,
    ever_connected: everConnected,
    participants_updated_at: nowIso,
  });
  return updated ?? { ...incident, participants: diff.participants, participant_count: diff.participants.length, ever_connected: everConnected, participants_updated_at: nowIso };
}
