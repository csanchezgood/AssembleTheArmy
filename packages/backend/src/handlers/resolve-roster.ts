// Step Functions task: resolves team roster, availability and backups into call targets.
import { AuditEvents } from '../domain/audit.js';
import { escalationTargetFor, resolveTargets } from '../domain/rules.js';
import type { ResolveRosterOutput, StateMachineInput } from '../domain/types.js';
import { emitConfigError } from '../infra/metrics.js';
import { createContext, type HandlerContext } from '../services/context.js';

export class NoEligibleMembers extends Error {
  constructor(message = 'No hay miembros elegibles en el roster') {
    super(message);
    this.name = 'NoEligibleMembers';
  }
}

export async function handler(input: StateMachineInput): Promise<ResolveRosterOutput> {
  return resolveRoster(createContext('resolve-roster', { incident_id: input.incident_id }), input);
}

export async function resolveRoster(ctx: HandlerContext, input: StateMachineInput): Promise<ResolveRosterOutput> {
  const nowIso = ctx.now().toISOString();
  const [rule, roster] = await Promise.all([ctx.repos.severity.get(input.severity), ctx.repos.roster.listBySystemAndTeam(input.system_id, input.team_id)]);

  const memberIds = new Set<string>(roster.map((r) => r.member_id));
  const availability = await ctx.repos.availability.listByMembers(memberIds);
  // Backups may not be roster members: load their availability too.
  const backupIds = new Set<string>();
  for (const records of availability.values()) {
    for (const r of records) if (r.backup_id && !availability.has(r.backup_id)) backupIds.add(r.backup_id);
  }
  if (backupIds.size) {
    const extra = await ctx.repos.availability.listByMembers(backupIds);
    for (const [k, v] of extra) availability.set(k, v);
  }

  const resolution = resolveTargets(roster, availability, nowIso);
  const roomJoinUrl = roster.find((r) => r.room_join_url)?.room_join_url ?? '';

  for (const s of resolution.substituted) {
    await ctx.audit({ incident_id: input.incident_id, event_type: AuditEvents.backup_substituted, actor: 'sfn', system_id: input.system_id, details: { slot: s.slot, team_id: input.team_id, member: s.member, backup: s.backup, motivo: 'Titular no disponible; se llama directamente al backup' } });
  }
  for (const s of resolution.skipped) {
    await ctx.audit({ incident_id: input.incident_id, event_type: AuditEvents.member_skipped_unavailable, actor: 'sfn', system_id: input.system_id, details: { slot: s.slot, team_id: input.team_id, member: s.member, backup: s.backup, reason: s.reason, motivo: s.reason === 'member_and_backup_unavailable' ? 'Titular y backup no disponibles; se pasa al siguiente del roster' : 'Titular no disponible sin backup; se pasa al siguiente del roster' } });
  }
  await ctx.audit({
    incident_id: input.incident_id,
    event_type: AuditEvents.roster_resolved,
    actor: 'sfn',
    system_id: input.system_id,
    details: { team_id: input.team_id, escalation_count: input.escalation_count, roster_size: roster.length, targets: resolution.targets, skipped: resolution.skipped.length, room_join_url: roomJoinUrl },
  });

  if (roster.length === 0) emitConfigError('no_roster', { system_id: input.system_id, team_id: input.team_id, incident_id: input.incident_id });

  // Keep the incident in sync with the team being convoked (matters on escalation).
  await ctx.repos.incidents.update(input.incident_id, { team_id: input.team_id, ...(roomJoinUrl ? { room_join_url: roomJoinUrl } : {}) });

  if (resolution.targets.length === 0) throw new NoEligibleMembers();
  if (!roomJoinUrl) {
    emitConfigError('invalid_join_url', { system_id: input.system_id, team_id: input.team_id, incident_id: input.incident_id });
  }

  return {
    incident_id: input.incident_id,
    system_id: input.system_id,
    severity: input.severity,
    team_id: input.team_id,
    room_join_url: roomJoinUrl,
    targets: resolution.targets,
    escalate_to_team_id: escalationTargetFor(rule, input.team_id),
    escalate_after_minutes: typeof rule?.escalate_after_minutes === 'number' ? rule.escalate_after_minutes : null,
    notify_webhook_urls: rule?.notify_webhook_urls ?? [],
    cycle_started_at: nowIso,
  };
}
