import { Link, useParams } from 'react-router-dom';
import { useApi } from '../api/ApiContext';
import type { AuditEvent } from '../api/types';
import { SeverityBadge, StatusBadge, TeamBadge } from '../components/Badges';
import { EmptyState, ErrorMessage, Loading } from '../components/States';
import { formatDateTime, formatDuration, formatTime } from '../lib/dates';
import { actorLabel, closeReasonLabel, detailKeyLabel, eventTone, eventTypeLabel } from '../lib/labels';
import { useAsync } from '../lib/useAsync';

export function IncidentDetailPage() {
  const api = useApi();
  const { incidentId = '' } = useParams<{ incidentId: string }>();
  const detail = useAsync(() => api.getIncident(incidentId), [api, incidentId]);

  return (
    <div className="page page-incident">
      <p className="breadcrumb">
        <Link to="/incidentes">← Incidentes</Link>
      </p>
      {detail.loading && <Loading label="Cargando incidente…" />}
      {detail.error && <ErrorMessage message={detail.error} onRetry={detail.reload} />}
      {detail.data && (
        <>
          <header className="incident-header">
            <div>
              <h1>{detail.data.incident.monitor_name ?? detail.data.incident.incident_id}</h1>
              <p className="incident-subtitle">
                <code>{detail.data.incident.system_id}</code>
                {detail.data.incident.condition_name && <span> · {detail.data.incident.condition_name}</span>}
              </p>
              <p className="muted small">ID {detail.data.incident.incident_id}</p>
            </div>
            <div className="incident-badges">
              <SeverityBadge severity={detail.data.incident.severity} />
              <StatusBadge status={detail.data.incident.status} />
              <TeamBadge team={detail.data.incident.team_id} />
            </div>
          </header>

          <dl className="kv-grid">
            <div>
              <dt>Abierto</dt>
              <dd>{formatDateTime(detail.data.incident.opened_at)}</dd>
            </div>
            <div>
              <dt>Cerrado</dt>
              <dd>{detail.data.incident.closed_at ? formatDateTime(detail.data.incident.closed_at) : '— (en curso)'}</dd>
            </div>
            <div>
              <dt>Duración</dt>
              <dd>{formatDuration(detail.data.incident.opened_at, detail.data.incident.closed_at)}</dd>
            </div>
            <div>
              <dt>Equipo inicial</dt>
              <dd>
                <TeamBadge team={detail.data.incident.initial_team_id} />
                {detail.data.incident.escalation_count > 0 && (
                  <span className="muted small"> · {detail.data.incident.escalation_count} escalación(es)</span>
                )}
              </dd>
            </div>
            <div>
              <dt>Alguien conectó</dt>
              <dd>{detail.data.incident.ever_connected ? 'Sí' : 'No'}</dd>
            </div>
            <div>
              <dt>Alertas eco</dt>
              <dd>
                {detail.data.incident.echo_count} · última alerta {formatDateTime(detail.data.incident.last_alert_at)}
              </dd>
            </div>
            <div>
              <dt>Motivo de cierre</dt>
              <dd>{closeReasonLabel(detail.data.incident.close_reason)}</dd>
            </div>
            <div>
              <dt>Sala de Teams</dt>
              <dd>
                <a href={detail.data.incident.room_join_url} target="_blank" rel="noreferrer">
                  Abrir sala
                </a>
                {detail.data.incident.room_call_id && (
                  <span className="muted small"> · llamada {detail.data.incident.room_call_id}</span>
                )}
              </dd>
            </div>
            {detail.data.incident.execution_arn && (
              <div className="kv-wide">
                <dt>Ejecución (Step Functions)</dt>
                <dd>
                  <code className="wrap">{detail.data.incident.execution_arn}</code>
                </dd>
              </div>
            )}
          </dl>

          <section className="incident-section" aria-labelledby="participants-title">
            <h2 id="participants-title">
              Participantes actuales{' '}
              <span className="count-pill">{detail.data.incident.participant_count}</span>
            </h2>
            {detail.data.incident.participants.length === 0 ? (
              <p className="muted">Nadie en la sala en este momento.</p>
            ) : (
              <ul className="participant-list">
                {detail.data.incident.participants.map((p) => (
                  <li key={p.id}>
                    <span className="member-name">{p.display_name}</span>
                    <span className="muted small">desde {formatDateTime(p.joined_at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="incident-section" aria-labelledby="timeline-title">
            <h2 id="timeline-title">Línea de tiempo</h2>
            {detail.data.events.length === 0 ? (
              <EmptyState title="Sin eventos de auditoría" />
            ) : (
              <Timeline events={detail.data.events} />
            )}
          </section>
        </>
      )}
    </div>
  );
}

export function Timeline({ events }: { events: AuditEvent[] }) {
  let lastDay = '';
  return (
    <ol className="timeline">
      {events.map((ev) => {
        const day = formatDateTime(ev.ts).slice(0, 10);
        const showDay = day !== lastDay;
        lastDay = day;
        return (
          <li key={ev.event_key} className={`timeline-item tone-${eventTone(ev.event_type)}`}>
            {showDay && <div className="timeline-day">{day}</div>}
            <div className="timeline-marker" aria-hidden="true" />
            <div className="timeline-content">
              <div className="timeline-head">
                <time dateTime={ev.ts} className="timeline-time">
                  {formatTime(ev.ts)}
                </time>
                <span className="timeline-type">{eventTypeLabel(ev.event_type)}</span>
                <span className="timeline-actor muted">{actorLabel(ev.actor)}</span>
              </div>
              <DetailsList details={ev.details} />
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'sí' : 'no';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(renderValue).join(', ');
  return JSON.stringify(value);
}

function DetailsList({ details }: { details: Record<string, unknown> }) {
  const entries = Object.entries(details ?? {});
  if (entries.length === 0) return null;
  return (
    <dl className="details-list">
      {entries.map(([k, v]) => (
        <div key={k}>
          <dt>{detailKeyLabel(k)}</dt>
          <dd>{renderValue(v)}</dd>
        </div>
      ))}
    </dl>
  );
}
