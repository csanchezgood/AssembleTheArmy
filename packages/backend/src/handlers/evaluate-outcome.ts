// Step Functions task: closes a team cycle and decides connected / escalate / unanswered.
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { AuditEvents } from '../domain/audit.js';
import { decideOutcome } from '../domain/outcome.js';
import { escalationTargetFor } from '../domain/rules.js';
import type { EvaluateOutcomeInput, EvaluateOutcomeOutput, Incident } from '../domain/types.js';
import { alertsTopicArn } from '../infra/env.js';
import { buildIncidentCard, postCard } from '../graph/cards.js';
import { createContext, type HandlerContext } from '../services/context.js';

let snsClient: SNSClient | undefined;
function getSns(): SNSClient {
  if (!snsClient) snsClient = new SNSClient({});
  return snsClient;
}

export async function handler(input: EvaluateOutcomeInput): Promise<EvaluateOutcomeOutput> {
  return evaluateOutcome(createContext('evaluate-outcome', { incident_id: input.incident_id }), input);
}

export async function evaluateOutcome(ctx: HandlerContext, input: EvaluateOutcomeInput): Promise<EvaluateOutcomeOutput> {
  const incident = await ctx.repos.incidents.get(input.incident_id);
  if (!incident) throw new Error(`Incidente ${input.incident_id} no encontrado`);
  const slotResults = Array.isArray(input.slot_results) ? input.slot_results : [];

  // When the machine skipped ResolveRoster (no eligible members) the rule fields are missing: reload them.
  let escalateTo = input.escalate_to_team_id;
  let notifyUrls = input.notify_webhook_urls;
  if (escalateTo === undefined || escalateTo === null || notifyUrls === undefined || notifyUrls === null) {
    const rule = await ctx.repos.severity.get(input.severity);
    if (escalateTo === undefined || escalateTo === null) escalateTo = escalationTargetFor(rule, input.team_id);
    if (notifyUrls === undefined || notifyUrls === null) notifyUrls = rule?.notify_webhook_urls ?? [];
  }

  for (const r of slotResults) {
    if (r.outcome === 'joined') continue;
    await ctx.audit({ incident_id: input.incident_id, event_type: AuditEvents.slot_exhausted, actor: 'sfn', system_id: input.system_id, details: { slot: r.slot, member: r.member, outcome: r.outcome, attempt: r.attempt, using_backup: r.using_backup, error: r.error, team_id: input.team_id } });
  }

  const decision = decideOutcome({
    slot_results: slotResults,
    escalate_to_team_id: escalateTo,
    escalation_count: input.escalation_count,
    max_escalations: input.policy?.max_escalations ?? 1,
    force_unanswered: input.failure === 'room_join_failed',
  });
  const nowIso = ctx.now().toISOString();
  const detailsBase = { team_id: input.team_id, escalation_count: input.escalation_count, joined: decision.joined_count, slots: slotResults.length, failure: input.failure ?? undefined };

  if (decision.outcome === 'connected') {
    await ctx.repos.incidents.update(input.incident_id, { status: 'connected', ever_connected: true });
    await ctx.audit({ incident_id: input.incident_id, event_type: AuditEvents.convocation_connected, actor: 'sfn', system_id: input.system_id, details: { ...detailsBase, motivo: `${decision.joined_count} miembro(s) conectado(s) en la sala` } });
  } else if (decision.outcome === 'escalate' && decision.next_team_id) {
    await ctx.repos.incidents.update(input.incident_id, { team_id: decision.next_team_id, escalation_count: decision.escalation_count });
    await ctx.audit({ incident_id: input.incident_id, event_type: AuditEvents.team_escalated, actor: 'sfn', system_id: input.system_id, details: { ...detailsBase, from_team_id: input.team_id, to_team_id: decision.next_team_id, new_escalation_count: decision.escalation_count, motivo: `Sin respuesta de ${input.team_id}; se escala a ${decision.next_team_id}` } });
  } else {
    await ctx.repos.incidents.update(input.incident_id, { status: 'unanswered' });
    await ctx.audit({ incident_id: input.incident_id, event_type: AuditEvents.convocation_unanswered, actor: 'sfn', system_id: input.system_id, details: { ...detailsBase, motivo: 'Nadie se conectó a la sala; requiere escalamiento manual' } });
    await publishUnanswered(ctx, incident, input);
  }

  await notifyOnce(ctx, { ...incident, team_id: input.team_id }, input, decision.outcome, decision.next_team_id, notifyUrls ?? []);

  const output: EvaluateOutcomeOutput = { outcome: decision.outcome, escalation_count: decision.escalation_count };
  if (decision.next_team_id) output.next_team_id = decision.next_team_id;
  return output;
}

async function notifyOnce(ctx: HandlerContext, incident: Incident, input: EvaluateOutcomeInput, outcome: EvaluateOutcomeOutput['outcome'], nextTeam: string | undefined, urls: string[]): Promise<void> {
  if (urls.length === 0 || incident.notification_sent_at) return;
  const card = buildIncidentCard({
    incident_id: incident.incident_id,
    system_id: incident.system_id,
    severity: incident.severity,
    team_id: input.team_id,
    monitor_name: incident.monitor_name,
    condition_name: incident.condition_name,
    opened_at: incident.opened_at,
    outcome,
    next_team_id: nextTeam,
    room_join_url: incident.room_join_url,
    participants: incident.participants ?? [],
  });
  const results = await postCard(urls, card);
  const nowIso = ctx.now().toISOString();
  await ctx.repos.incidents.update(incident.incident_id, { notification_sent_at: nowIso });
  await ctx.audit({ incident_id: incident.incident_id, event_type: AuditEvents.notification_sent, actor: 'sfn', system_id: incident.system_id, details: { outcome, results, motivo: 'Tarjeta informativa enviada a los webhooks de Teams' } });
}

async function publishUnanswered(ctx: HandlerContext, incident: Incident, input: EvaluateOutcomeInput): Promise<void> {
  const topic = alertsTopicArn();
  if (!topic) return;
  const subject = `[AssembleTheArmy] Sin respuesta: ${incident.system_id} (${incident.severity})`.slice(0, 100);
  const message = [
    `Convocatoria sin respuesta para el sistema ${incident.system_id}.`,
    `Severidad: ${incident.severity}`,
    `Equipo(s) convocado(s): ${incident.initial_team_id}${input.team_id !== incident.initial_team_id ? ` -> ${input.team_id}` : ''}`,
    `Monitor: ${incident.monitor_name ?? '-'}`,
    `Condición: ${incident.condition_name ?? '-'}`,
    `Incidente: ${incident.incident_id}`,
    `Abierto: ${incident.opened_at}`,
    incident.room_join_url ? `Sala: ${incident.room_join_url}` : '',
    'Requiere escalamiento manual.',
  ].filter(Boolean).join('\n');
  try {
    await getSns().send(new PublishCommand({ TopicArn: topic, Subject: subject, Message: message }));
  } catch (err) {
    ctx.log.error('No se pudo publicar en SNS', { error: String(err) });
  }
}
