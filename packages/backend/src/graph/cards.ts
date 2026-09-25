// Adaptive Card payload for Teams Workflows / Incoming Webhook notifications (Spanish text).

export interface IncidentCardInput {
  incident_id: string;
  system_id: string;
  severity: string;
  team_id: string;
  monitor_name?: string;
  condition_name?: string;
  opened_at: string;
  outcome: 'connected' | 'escalate' | 'unanswered';
  next_team_id?: string;
  room_join_url?: string;
  participants: { display_name: string }[];
}

const OUTCOME_TEXT: Record<IncidentCardInput['outcome'], string> = {
  connected: 'Equipo conectado en la sala',
  escalate: 'Sin respuesta, escalando al siguiente equipo',
  unanswered: 'Sin respuesta del equipo (requiere atención manual)',
};

export function buildIncidentCard(input: IncidentCardInput): Record<string, unknown> {
  const facts: { title: string; value: string }[] = [
    { title: 'Sistema', value: input.system_id },
    { title: 'Severidad', value: input.severity.toUpperCase() },
    { title: 'Equipo convocado', value: input.team_id },
    { title: 'Resultado', value: OUTCOME_TEXT[input.outcome] + (input.next_team_id ? ` (${input.next_team_id})` : '') },
    { title: 'Abierto', value: input.opened_at },
    { title: 'Incidente', value: input.incident_id },
  ];
  if (input.monitor_name) facts.push({ title: 'Monitor', value: input.monitor_name });
  if (input.condition_name) facts.push({ title: 'Condición', value: input.condition_name });
  if (input.participants.length) {
    facts.push({ title: 'En la sala', value: input.participants.map((p) => p.display_name).filter(Boolean).join(', ') });
  }

  const body: Record<string, unknown>[] = [
    { type: 'TextBlock', size: 'Large', weight: 'Bolder', text: `Convocatoria automática: ${input.system_id}`, wrap: true },
    { type: 'TextBlock', text: OUTCOME_TEXT[input.outcome], wrap: true, spacing: 'Small', isSubtle: true },
    { type: 'FactSet', facts },
  ];
  const actions: Record<string, unknown>[] = [];
  if (input.room_join_url) actions.push({ type: 'Action.OpenUrl', title: 'Unirse a la sala', url: input.room_join_url });

  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          msteams: { width: 'Full' },
          body,
          ...(actions.length ? { actions } : {}),
        },
      },
    ],
  };
}

export interface CardDeliveryResult {
  url: string;
  ok: boolean;
  status?: number;
  error?: string;
}

/** Posts the card to each webhook; never throws (results reported per URL). */
export async function postCard(urls: readonly string[], payload: Record<string, unknown>, fetchImpl: typeof fetch = fetch): Promise<CardDeliveryResult[]> {
  const results: CardDeliveryResult[] = [];
  for (const url of urls) {
    try {
      const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      results.push({ url, ok: res.ok, status: res.status });
    } catch (err) {
      results.push({ url, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}
