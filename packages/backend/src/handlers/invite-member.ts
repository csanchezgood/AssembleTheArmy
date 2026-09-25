// Step Functions task: rings one member by inviting them to the room call.
import { AuditEvents } from '../domain/audit.js';
import type { InviteMemberInput, InviteMemberOutput } from '../domain/types.js';
import { GraphError } from '../graph/client.js';
import { createContext, getGraphClient, type HandlerContext } from '../services/context.js';

export class RoomCallGone extends Error {
  constructor(message = 'La llamada de la sala ya no existe') {
    super(message);
    this.name = 'RoomCallGone';
  }
}

export async function handler(input: InviteMemberInput): Promise<InviteMemberOutput> {
  return inviteMember(createContext('invite-member', { incident_id: input.incident_id }), input);
}

export async function inviteMember(ctx: HandlerContext, input: InviteMemberInput): Promise<InviteMemberOutput> {
  const graph = getGraphClient();
  const base = { slot: input.slot, attempt: input.attempt, using_backup: input.using_backup, member: input.member, room_call_id: input.room_call_id };
  try {
    await graph.inviteParticipant(input.room_call_id, input.member.id, input.member.name);
    await ctx.audit({ incident_id: input.incident_id, event_type: AuditEvents.invite_sent, actor: 'sfn', details: { ...base, motivo: `Timbre ${input.attempt} a ${input.member.name}` } });
    return { invited: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof GraphError && err.isNotFound) {
      const call = await safeGetCall(input.room_call_id);
      if (!call) {
        await ctx.audit({ incident_id: input.incident_id, event_type: AuditEvents.invite_failed, actor: 'sfn', details: { ...base, error: message, reason: 'room_call_gone' } });
        throw new RoomCallGone();
      }
    }
    await ctx.audit({ incident_id: input.incident_id, event_type: AuditEvents.invite_failed, actor: 'sfn', details: { ...base, error: message, status: err instanceof GraphError ? err.status : undefined, code: err instanceof GraphError ? err.code : undefined } });
    ctx.log.warn('Fallo al invitar al miembro', { member_id: input.member.id, error: message });
    return { invited: false, error: message };
  }
}

async function safeGetCall(callId: string): Promise<unknown> {
  try {
    return await getGraphClient().getCall(callId);
  } catch {
    return {}; // unknown state: do not claim the room is gone
  }
}
