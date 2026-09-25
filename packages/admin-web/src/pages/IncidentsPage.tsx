import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useApi } from '../api/ApiContext';
import type { Incident, IncidentStatus } from '../api/types';
import { SeverityBadge, StatusBadge, TeamBadge } from '../components/Badges';
import { EmptyState, ErrorMessage, Loading } from '../components/States';
import { formatDateTime, formatDuration } from '../lib/dates';
import { INCIDENT_STATUSES, INCIDENT_STATUS_LABELS } from '../lib/labels';
import { errorMessage, useAsync } from '../lib/useAsync';

const isStatus = (v: string | null): v is IncidentStatus =>
  v !== null && (INCIDENT_STATUSES as readonly string[]).includes(v);

export function IncidentsPage() {
  const api = useApi();
  const [params, setParams] = useSearchParams();
  const systemFilter = params.get('system_id') ?? '';
  const statusParam = params.get('status');
  const statusFilter: IncidentStatus | '' = isStatus(statusParam) ? statusParam : '';

  const systems = useAsync(() => api.listSystems(), [api]);
  const list = useAsync(
    () =>
      api.listIncidents({
        ...(systemFilter ? { system_id: systemFilter } : {}),
        ...(statusFilter ? { status: statusFilter } : {}),
        limit: 50,
      }),
    [api, systemFilter, statusFilter],
  );
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);

  const update = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const loadMore = async () => {
    const cursor = list.data?.cursor;
    if (!cursor) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await api.listIncidents({
        ...(systemFilter ? { system_id: systemFilter } : {}),
        ...(statusFilter ? { status: statusFilter } : {}),
        limit: 50,
        cursor,
      });
      list.setData((prev) =>
        prev
          ? { items: [...prev.items, ...page.items], ...(page.cursor ? { cursor: page.cursor } : {}) }
          : page,
      );
    } catch (err) {
      setMoreError(errorMessage(err));
    } finally {
      setLoadingMore(false);
    }
  };

  const items: Incident[] = list.data?.items ?? [];

  return (
    <div className="page page-incidents">
      <div className="page-header">
        <h1>Incidentes</h1>
        <button type="button" className="btn btn-secondary btn-sm" onClick={list.reload} disabled={list.loading}>
          Actualizar
        </button>
      </div>
      <form className="filters" onSubmit={(e) => e.preventDefault()} aria-label="Filtros">
        <div className="field">
          <label htmlFor="filter-system" className="label">
            Sistema
          </label>
          <select id="filter-system" value={systemFilter} onChange={(e) => update('system_id', e.target.value)}>
            <option value="">Todos</option>
            {systems.data?.map((s) => (
              <option key={s.system_id} value={s.system_id}>
                {s.system_id}
              </option>
            ))}
            {systemFilter && !systems.data?.some((s) => s.system_id === systemFilter) && (
              <option value={systemFilter}>{systemFilter}</option>
            )}
          </select>
        </div>
        <div className="field">
          <label htmlFor="filter-status" className="label">
            Estado
          </label>
          <select id="filter-status" value={statusFilter} onChange={(e) => update('status', e.target.value)}>
            <option value="">Todos</option>
            {INCIDENT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {INCIDENT_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        {(systemFilter || statusFilter) && (
          <button type="button" className="btn btn-link" onClick={() => setParams({}, { replace: true })}>
            Limpiar filtros
          </button>
        )}
      </form>

      {list.loading && <Loading label="Cargando incidentes…" />}
      {list.error && <ErrorMessage message={list.error} onRetry={list.reload} />}
      {list.data && items.length === 0 && (
        <EmptyState title="No hay incidentes que coincidan con los filtros" />
      )}
      {list.data && items.length > 0 && (
        <div className="table-wrap">
          <table className="data-table incidents-table">
            <thead>
              <tr>
                <th scope="col">Incidente</th>
                <th scope="col">Sistema</th>
                <th scope="col">Severidad</th>
                <th scope="col">Estado</th>
                <th scope="col">Equipo</th>
                <th scope="col">Abierto</th>
                <th scope="col">Cerrado</th>
                <th scope="col" className="num">
                  Participantes
                </th>
                <th scope="col" className="num">
                  Ecos
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((inc) => (
                <tr key={inc.incident_id}>
                  <td>
                    <Link to={`/incidentes/${encodeURIComponent(inc.incident_id)}`} className="incident-link">
                      <span className="incident-monitor">{inc.monitor_name ?? inc.incident_id}</span>
                      <span className="incident-id muted">{inc.incident_id}</span>
                    </Link>
                  </td>
                  <td>
                    <code>{inc.system_id}</code>
                  </td>
                  <td>
                    <SeverityBadge severity={inc.severity} />
                  </td>
                  <td>
                    <StatusBadge status={inc.status} />
                  </td>
                  <td>
                    <TeamBadge team={inc.team_id} />
                    {inc.escalation_count > 0 && (
                      <span className="muted small"> (desde {inc.initial_team_id})</span>
                    )}
                  </td>
                  <td>
                    <time dateTime={inc.opened_at}>{formatDateTime(inc.opened_at)}</time>
                  </td>
                  <td>
                    {inc.closed_at ? (
                      <time dateTime={inc.closed_at}>{formatDateTime(inc.closed_at)}</time>
                    ) : (
                      <span className="muted">— ({formatDuration(inc.opened_at)} abierto)</span>
                    )}
                  </td>
                  <td className="num">{inc.participant_count}</td>
                  <td className="num">{inc.echo_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.data?.cursor && (
        <div className="load-more">
          {moreError && (
            <p className="form-error" role="alert">
              {moreError}
            </p>
          )}
          <button type="button" className="btn btn-secondary" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? 'Cargando…' : 'Cargar más'}
          </button>
        </div>
      )}
    </div>
  );
}
