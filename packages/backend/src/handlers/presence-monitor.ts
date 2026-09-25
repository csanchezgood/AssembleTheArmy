// EventBridge Scheduler (rate 1 minute): keeps incident rosters fresh, closes empty rooms,
// expires unanswered incidents and cleans up orphaned convocations.
import { DescribeExecutionCommand, SFNClient } from '@aws-sdk/client-sfn';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import type { Incident } from '../domain/types.js';
import { alertsTopicArn, unansweredTtlMinutes } from '../infra/env.js';
import { GraphError } from '../graph/client.js';
import { AuditEvents } from '../domain/audit.js';
import { createContext, getGraphClient, type HandlerContext } from '../services/context.js';
import { closeIncident } from '../services/incident-close.js';
import { syncParticipants } from '../services/roster-sync.js';

let sfnClient: SFNClient | undefined;
let snsClient: SNSClient | undefined;
function getSfn(): SFNClient {
  if (!sfnClient) sfnClient = new SFNClient({});
  return sfnClient;
}
function getSns(): SNSClient {
  if (!snsClient) snsClient = new SNSClient({});
  return snsClient;
}

export interface PresenceSummary {
  checked: number;
  closed: string[];
  errors: string[];
}

export async function handler(): Promise<PresenceSummary> {
  return monitorPresence(createContext('presence-monitor'));
}

export async function monitorPresence(ctx: HandlerContext): Promise<PresenceSummary> {
  const summary: PresenceSummary = { checked: 0, closed: [], errors: [] };
  const [convoking, connected, unanswered] = await Promise.all([
    ctx.repos.incidents.listAllByStatus('convoking'),
    ctx.repos.incidents.listAllByStatus('connected'),
    ctx.repos.incidents.listAllByStatus('unanswered'),
  ]);

  for (const incident of [...convoking, ...connected]) {
    summary.checked += 1;
    try {
      const closed = await checkActive(ctx, incident);
      if (closed) summary.closed.push(incident.incident_id);
    } catch (err) {
      summary.errors.push(incident.incident_id);
      ctx.log.error('Error comprobando presencia', { incident_id: incident.incident_id, error: String(err) });
    }
  }

  const ttlMs = unansweredTtlMinutes() * 60 * 1000;
  const now = ctx.now().getTime();
  for (const incident of unanswered) {
    summary.checked += 1;
    try {
      const reference = Date.parse(incident.last_alert_at ?? incident.opened_at);
      if (!Number.isNaN(reference) && now - reference >= ttlMs) {
        await closeIncident(ctx, incident, { reason: 'unanswered_ttl', actor: 'system', leaveRoom: true });
        summary.closed.push(incident.incident_id);
      }
    } catch (err) {
      summary.errors.push(incident.incident_id);
      ctx.log.error('Error cerrando incidente sin respuesta', { incident_id: incident.incident_id, error: String(err) });
    }
  }
  ctx.log.info('Monitor de presencia', { ...summary });
  return summary;
}

/** Returns true when the incident was closed. */
async function checkActive(ctx: HandlerContext, incident: Incident): Promise<boolean> {
  let current = incident;
  if (current.room_call_id) {
    try {
      const humans = await getGraphClient().listParticipants(current.room_call_id, current.bot_participant_id);
      current = await syncParticipants(ctx, current, humans, 'system');
    } catch (err) {
      if (err instanceof GraphError && err.isNotFound) {
        current = await syncParticipants(ctx, current, [], 'system');
        current = (await ctx.repos.incidents.update(current.incident_id, { room_call_id: null, bot_participant_id: null })) ?? { ...current, room_call_id: undefined };
      } else {
        await ctx.audit({ incident_id: current.incident_id, event_type: AuditEvents.graph_error, actor: 'system', system_id: current.system_id, details: { operation: 'listParticipants', message: err instanceof Error ? err.message : String(err) } });
        throw err;
      }
    }
  }

  if (current.ever_connected && current.participant_count === 0) {
    await closeIncident(ctx, current, { reason: 'room_empty', actor: 'system', leaveRoom: true });
    return true;
  }

  if (current.status === 'convoking' && current.execution_arn) {
    const status = await executionStatus(current.execution_arn);
    if (status && status !== 'RUNNING') {
      await closeIncident(ctx, current, { reason: 'execution_ended', actor: 'system', leaveRoom: true, details: { execution_status: status } });
      await notifyOrphan(ctx, current, status);
      return true;
    }
  }
  return false;
}

async function executionStatus(executionArn: string): Promise<string | undefined> {
  try {
    const res = await getSfn().send(new DescribeExecutionCommand({ executionArn }));
    return res.status;
  } catch (err) {
    if (typeof err === 'object' && err !== null && (err as { name?: string }).name === 'ExecutionDoesNotExist') return 'ABORTED';
    return undefined;
  }
}

async function notifyOrphan(ctx: HandlerContext, incident: Incident, status: string): Promise<void> {
  const topic = alertsTopicArn();
  if (!topic) return;
  try {
    await getSns().send(
      new PublishCommand({
        TopicArn: topic,
        Subject: `[AssembleTheArmy] Convocatoria interrumpida: ${incident.system_id}`.slice(0, 100),
        Message: [
          `La convocatoria del sistema ${incident.system_id} terminó sin resultado (estado de la ejecución: ${status}).`,
          `Incidente: ${incident.incident_id}`,
          `Severidad: ${incident.severity}`,
          `Equipo: ${incident.team_id}`,
          'El incidente fue cerrado por el monitor de presencia. Revise la ejecución en Step Functions.',
        ].join('\n'),
      }),
    );
  } catch (err) {
    ctx.log.error('No se pudo publicar en SNS', { error: String(err) });
  }
}
