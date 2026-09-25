import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { NavLink, useNavigate, useParams } from 'react-router-dom';
import { useApi } from '../api/ApiContext';
import type { Member, RosterItem, SystemSummary, TeamId } from '../api/types';
import { TeamBadge } from '../components/Badges';
import { ConfirmDialog, Dialog } from '../components/Dialog';
import { EmptyState, ErrorMessage, FieldError, Loading } from '../components/States';
import { UserPicker } from '../components/UserPicker';
import { formatDateTime } from '../lib/dates';
import { TEAM_IDS } from '../lib/labels';
import { errorMessage, useAsync } from '../lib/useAsync';
import { validateRosterForm, validateSystemId, type FieldErrors, type RosterFormField } from '../lib/validation';

export function SystemsPage() {
  const api = useApi();
  const navigate = useNavigate();
  const { systemId } = useParams<{ systemId: string }>();
  const systems = useAsync(() => api.listSystems(), [api]);
  const [newOpen, setNewOpen] = useState(false);

  const known = useMemo(() => new Set((systems.data ?? []).map((s) => s.system_id)), [systems.data]);

  return (
    <div className="page page-systems">
      <div className="page-header">
        <h1>Sistemas y guardias</h1>
        <button type="button" className="btn btn-primary" onClick={() => setNewOpen(true)}>
          Nuevo sistema
        </button>
      </div>
      <div className="systems-layout">
        <aside className="systems-list" aria-label="Sistemas">
          {systems.loading && <Loading label="Cargando sistemas…" />}
          {systems.error && <ErrorMessage message={systems.error} onRetry={systems.reload} />}
          {systems.data && systems.data.length === 0 && (
            <EmptyState title="Aún no hay sistemas con guardia">
              <p>Crea uno con «Nuevo sistema».</p>
            </EmptyState>
          )}
          {systems.data && systems.data.length > 0 && (
            <ul className="system-nav">
              {systems.data.map((s) => (
                <SystemNavItem key={s.system_id} system={s} />
              ))}
              {systemId && !known.has(systemId) && (
                <li>
                  <NavLink to={`/sistemas/${encodeURIComponent(systemId)}`} className="system-nav-link active">
                    <span className="system-id">{systemId}</span>
                    <span className="system-meta">nuevo · sin guardias</span>
                  </NavLink>
                </li>
              )}
            </ul>
          )}
        </aside>
        <section className="systems-detail">
          {systemId ? (
            <RosterPanel systemId={systemId} onChanged={systems.reload} />
          ) : (
            <EmptyState title="Selecciona un sistema">
              <p>Elige un sistema de la lista para ver y editar su guardia N2 / N3.</p>
            </EmptyState>
          )}
        </section>
      </div>
      <NewSystemDialog
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onCreate={(id) => {
          setNewOpen(false);
          navigate(`/sistemas/${encodeURIComponent(id)}`);
        }}
      />
    </div>
  );
}

function SystemNavItem({ system }: { system: SystemSummary }) {
  return (
    <li>
      <NavLink
        to={`/sistemas/${encodeURIComponent(system.system_id)}`}
        className={({ isActive }) => (isActive ? 'system-nav-link active' : 'system-nav-link')}
      >
        <span className="system-id">{system.system_id}</span>
        <span className="system-meta">
          {system.teams.join(' · ') || 'sin equipos'} · {system.member_count}{' '}
          {system.member_count === 1 ? 'miembro' : 'miembros'}
        </span>
      </NavLink>
    </li>
  );
}

function NewSystemDialog({
  open,
  onClose,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (systemId: string) => void;
}) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setValue('');
      setError(null);
    }
  }, [open]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const id = value.trim().toLowerCase();
    const err = validateSystemId(id);
    if (err) {
      setError(err);
      return;
    }
    onCreate(id);
  };

  return (
    <Dialog open={open} title="Nuevo sistema" onClose={onClose} width={480}>
      <form onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor="new-system-id" className="label">
            Identificador del sistema (system_tag de New Relic) *
          </label>
          <input
            id="new-system-id"
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="payments-api"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'new-system-id-error' : 'new-system-id-hint'}
          />
          <p id="new-system-id-hint" className="hint">
            Se guarda en minúsculas. Debe coincidir con el tag que envía New Relic.
          </p>
          <FieldError id="new-system-id-error" message={error ?? undefined} />
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary">
            Continuar
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/* ------------------------------ Roster panel ------------------------------ */

interface EditorState {
  item: RosterItem | null;
  team: TeamId;
  priority: number;
  roomUrl: string;
}

export function RosterPanel({ systemId, onChanged }: { systemId: string; onChanged?: () => void }) {
  const api = useApi();
  const roster = useAsync(() => api.listRoster(systemId), [api, systemId]);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [toDelete, setToDelete] = useState<RosterItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const byTeam = useMemo(() => {
    const groups: Record<TeamId, RosterItem[]> = { N2: [], N3: [] };
    for (const item of roster.data ?? []) {
      groups[item.team_id].push(item);
    }
    for (const team of TEAM_IDS) {
      groups[team].sort((a, b) => a.priority_order - b.priority_order || a.member_name.localeCompare(b.member_name));
    }
    return groups;
  }, [roster.data]);

  const openAdd = (team: TeamId) => {
    const items = byTeam[team];
    const nextPriority = items.reduce((max, i) => Math.max(max, i.priority_order), 0) + 1;
    setEditor({ item: null, team, priority: nextPriority, roomUrl: items[0]?.room_join_url ?? '' });
  };

  const confirmDelete = async () => {
    if (!toDelete) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.deleteRoster(toDelete.system_id, toDelete.roster_key);
      setToDelete(null);
      roster.reload();
      onChanged?.();
    } catch (err) {
      setDeleteError(errorMessage(err));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="roster-panel">
      <div className="page-subheader">
        <h2>
          Guardia de <code>{systemId}</code>
        </h2>
      </div>
      {roster.loading && <Loading label="Cargando guardia…" />}
      {roster.error && <ErrorMessage message={roster.error} onRetry={roster.reload} />}
      {roster.data && (
        <div className="team-grid">
          {TEAM_IDS.map((team) => {
            const items = byTeam[team];
            const roomUrls = new Set(items.map((i) => i.room_join_url));
            const roomUrl = items[0]?.room_join_url;
            return (
              <section key={team} className="team-card" aria-labelledby={`team-${team}`}>
                <header className="team-card-header">
                  <h3 id={`team-${team}`}>
                    Equipo <TeamBadge team={team} />
                  </h3>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => openAdd(team)}>
                    Añadir miembro
                  </button>
                </header>
                <div className="team-room">
                  <span className="label">Sala de Teams</span>
                  {roomUrl ? (
                    <a href={roomUrl} target="_blank" rel="noreferrer" className="room-link" title={roomUrl}>
                      Abrir sala del equipo {team}
                    </a>
                  ) : (
                    <span className="muted">Sin sala (se define al añadir el primer miembro)</span>
                  )}
                  {roomUrls.size > 1 && (
                    <p className="field-error" role="alert">
                      Atención: los miembros de este equipo tienen URLs de sala distintas. Unifícalas.
                    </p>
                  )}
                </div>
                {items.length === 0 ? (
                  <p className="muted">Sin miembros en {team}.</p>
                ) : (
                  <ol className="member-list">
                    {items.map((item) => (
                      <li key={item.roster_key} className="member-row">
                        <span className="member-priority" aria-label={`Prioridad ${item.priority_order}`}>
                          {item.priority_order}
                        </span>
                        <span className="member-identity">
                          <span className="member-name">{item.member_name}</span>
                          <span className="member-upn">{item.member_upn}</span>
                          <span className="member-updated muted">
                            Actualizado {formatDateTime(item.updated_at)} por {item.updated_by.replace(/^admin:/, '')}
                          </span>
                        </span>
                        <span className="member-actions">
                          <button
                            type="button"
                            className="btn btn-link"
                            onClick={() =>
                              setEditor({
                                item,
                                team: item.team_id,
                                priority: item.priority_order,
                                roomUrl: item.room_join_url,
                              })
                            }
                            aria-label={`Editar a ${item.member_name}`}
                          >
                            Editar
                          </button>
                          <button
                            type="button"
                            className="btn btn-link btn-danger-link"
                            onClick={() => {
                              setDeleteError(null);
                              setToDelete(item);
                            }}
                            aria-label={`Eliminar a ${item.member_name}`}
                          >
                            Eliminar
                          </button>
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            );
          })}
        </div>
      )}

      {editor && (
        <RosterMemberDialog
          systemId={systemId}
          state={editor}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            roster.reload();
            onChanged?.();
          }}
        />
      )}

      <ConfirmDialog
        open={toDelete !== null}
        title="Eliminar miembro de la guardia"
        message={
          toDelete && (
            <p>
              ¿Quitar a <strong>{toDelete.member_name}</strong> ({toDelete.member_upn}) del equipo {toDelete.team_id} de{' '}
              <code>{toDelete.system_id}</code>?
            </p>
          )
        }
        busy={deleting}
        error={deleteError}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setToDelete(null)}
      />
    </div>
  );
}

/* --------------------------- Member add/edit dialog --------------------------- */

function RosterMemberDialog({
  systemId,
  state,
  onClose,
  onSaved,
}: {
  systemId: string;
  state: EditorState;
  onClose: () => void;
  onSaved: () => void;
}) {
  const api = useApi();
  const editing = state.item;
  const [member, setMember] = useState<Member | null>(
    editing ? { id: editing.member_id, upn: editing.member_upn, name: editing.member_name } : null,
  );
  const [team, setTeam] = useState<string>(state.team);
  const [priority, setPriority] = useState(String(state.priority));
  const [roomUrl, setRoomUrl] = useState(state.roomUrl);
  const [errors, setErrors] = useState<FieldErrors<RosterFormField>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const values = { member_id: member?.id ?? '', team_id: team, priority_order: priority, room_join_url: roomUrl };
    const errs = validateRosterForm(values);
    setErrors(errs);
    if (Object.keys(errs).length > 0 || !member) return;
    setSaving(true);
    setSubmitError(null);
    try {
      const saved = await api.putRoster({
        system_id: systemId,
        team_id: team as TeamId,
        priority_order: Number(priority),
        member_id: member.id,
        member_upn: member.upn,
        member_name: member.name,
        room_join_url: roomUrl.trim(),
      });
      // Si cambió equipo/prioridad/miembro la clave es otra: borrar la fila anterior.
      if (editing && editing.roster_key !== saved.roster_key) {
        await api.deleteRoster(editing.system_id, editing.roster_key);
      }
      onSaved();
    } catch (err) {
      setSubmitError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open title={editing ? 'Editar miembro de guardia' : 'Añadir miembro de guardia'} onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} noValidate className="form-grid">
        <UserPicker
          id="roster-member"
          label="Usuario"
          value={member}
          onChange={setMember}
          required
          error={errors.member_id}
        />
        <div className="field-row">
          <div className="field">
            <label htmlFor="roster-team" className="label">
              Equipo *
            </label>
            <select
              id="roster-team"
              value={team}
              onChange={(e) => setTeam(e.target.value)}
              aria-invalid={errors.team_id ? true : undefined}
              aria-describedby={errors.team_id ? 'roster-team-error' : undefined}
            >
              {TEAM_IDS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <FieldError id="roster-team-error" message={errors.team_id} />
          </div>
          <div className="field">
            <label htmlFor="roster-priority" className="label">
              Orden de prioridad *
            </label>
            <input
              id="roster-priority"
              type="number"
              min={1}
              max={999}
              step={1}
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
              aria-invalid={errors.priority_order ? true : undefined}
              aria-describedby={errors.priority_order ? 'roster-priority-error' : undefined}
            />
            <FieldError id="roster-priority-error" message={errors.priority_order} />
          </div>
        </div>
        <div className="field">
          <label htmlFor="roster-room" className="label">
            URL «Unirse» de la sala de Teams del equipo *
          </label>
          <input
            id="roster-room"
            type="url"
            value={roomUrl}
            onChange={(e) => setRoomUrl(e.target.value)}
            placeholder="https://teams.microsoft.com/l/meetup-join/…"
            aria-invalid={errors.room_join_url ? true : undefined}
            aria-describedby={errors.room_join_url ? 'roster-room-error' : 'roster-room-hint'}
          />
          <p id="roster-room-hint" className="hint">
            Todos los miembros del mismo equipo deben compartir la misma sala.
          </p>
          <FieldError id="roster-room-error" message={errors.room_join_url} />
        </div>
        {submitError && (
          <p className="form-error" role="alert">
            {submitError}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Guardando…' : 'Guardar'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
