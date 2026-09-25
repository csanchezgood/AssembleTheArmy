import { useState, type FormEvent } from 'react';
import { useApi } from '../api/ApiContext';
import type { AvailabilityItem, AvailabilityStatus, Member } from '../api/types';
import { AvailabilityBadge } from '../components/Badges';
import { ConfirmDialog, Dialog } from '../components/Dialog';
import { EmptyState, ErrorMessage, FieldError, Loading } from '../components/States';
import { UserPicker } from '../components/UserPicker';
import { formatDateTime, fromLocalInputValue, isWithin, toLocalInputValue } from '../lib/dates';
import { AVAILABILITY_STATUS_LABELS } from '../lib/labels';
import { errorMessage, useAsync } from '../lib/useAsync';
import { useMemberDirectory } from '../lib/useMemberDirectory';
import { validateAvailabilityForm, type AvailabilityFormField, type FieldErrors } from '../lib/validation';

export function AvailabilityPage() {
  const api = useApi();
  const windows = useAsync(() => api.listAvailability(), [api]);
  const directory = useMemberDirectory();
  const [editing, setEditing] = useState<AvailabilityItem | null | 'new'>(null);
  const [toDelete, setToDelete] = useState<AvailabilityItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const memberOf = (id: string): Member => directory.data?.get(id) ?? { id, upn: id, name: id };

  const confirmDelete = async () => {
    if (!toDelete) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.deleteAvailability(toDelete.member_id, toDelete.valid_from);
      setToDelete(null);
      windows.reload();
    } catch (err) {
      setDeleteError(errorMessage(err));
    } finally {
      setDeleting(false);
    }
  };

  const now = new Date();

  return (
    <div className="page page-availability">
      <div className="page-header">
        <h1>Disponibilidad</h1>
        <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>
          Marcar no disponible
        </button>
      </div>
      <p className="page-intro">
        Mientras una persona está de vacaciones o no disponible, la convocatoria llama directamente a su backup. Si el
        backup tampoco está disponible, se pasa al siguiente de la guardia.
      </p>
      {windows.loading && <Loading label="Cargando ventanas de disponibilidad…" />}
      {windows.error && <ErrorMessage message={windows.error} onRetry={windows.reload} />}
      {windows.data && windows.data.length === 0 && (
        <EmptyState title="No hay ventanas de disponibilidad registradas">
          <p>Todos los miembros se consideran disponibles.</p>
        </EmptyState>
      )}
      {windows.data && windows.data.length > 0 && (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Miembro</th>
                <th scope="col">Estado</th>
                <th scope="col">Desde</th>
                <th scope="col">Hasta</th>
                <th scope="col">Backup</th>
                <th scope="col">Nota</th>
                <th scope="col">
                  <span className="sr-only">Acciones</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {windows.data.map((w) => {
                const m = memberOf(w.member_id);
                const active = isWithin(w.valid_from, w.valid_until, now);
                return (
                  <tr key={`${w.member_id}#${w.valid_from}`} className={active ? 'row-active' : undefined}>
                    <td>
                      <span className="member-name">{m.name}</span>
                      <span className="member-upn">{m.upn}</span>
                    </td>
                    <td>
                      <AvailabilityBadge status={w.status} />
                      {active && <span className="badge badge-now">ahora</span>}
                    </td>
                    <td>{formatDateTime(w.valid_from)}</td>
                    <td>{formatDateTime(w.valid_until)}</td>
                    <td>
                      {w.backup_id ? (
                        <>
                          <span className="member-name">{w.backup_name ?? memberOf(w.backup_id).name}</span>
                          <span className="member-upn">{w.backup_upn ?? memberOf(w.backup_id).upn}</span>
                        </>
                      ) : (
                        <span className="muted">Sin backup</span>
                      )}
                    </td>
                    <td className="cell-note">{w.note ?? ''}</td>
                    <td className="cell-actions">
                      <button type="button" className="btn btn-link" onClick={() => setEditing(w)}>
                        Editar
                      </button>
                      <button
                        type="button"
                        className="btn btn-link btn-danger-link"
                        onClick={() => {
                          setDeleteError(null);
                          setToDelete(w);
                        }}
                      >
                        Eliminar
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {editing !== null && (
        <AvailabilityDialog
          item={editing === 'new' ? null : editing}
          resolveMember={memberOf}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            windows.reload();
          }}
        />
      )}

      <ConfirmDialog
        open={toDelete !== null}
        title="Eliminar ventana de disponibilidad"
        message={
          toDelete && (
            <p>
              ¿Eliminar el estado «{AVAILABILITY_STATUS_LABELS[toDelete.status]}» de{' '}
              <strong>{memberOf(toDelete.member_id).name}</strong> del {formatDateTime(toDelete.valid_from)} al{' '}
              {formatDateTime(toDelete.valid_until)}?
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

function AvailabilityDialog({
  item,
  resolveMember,
  onClose,
  onSaved,
}: {
  item: AvailabilityItem | null;
  resolveMember: (id: string) => Member;
  onClose: () => void;
  onSaved: () => void;
}) {
  const api = useApi();
  const [member, setMember] = useState<Member | null>(item ? resolveMember(item.member_id) : null);
  const [backup, setBackup] = useState<Member | null>(
    item?.backup_id
      ? { id: item.backup_id, upn: item.backup_upn ?? '', name: item.backup_name ?? item.backup_id }
      : null,
  );
  const [status, setStatus] = useState<string>(item?.status ?? 'vacation');
  const [from, setFrom] = useState(toLocalInputValue(item?.valid_from));
  const [until, setUntil] = useState(toLocalInputValue(item?.valid_until));
  const [note, setNote] = useState(item?.note ?? '');
  const [errors, setErrors] = useState<FieldErrors<AvailabilityFormField>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const validFrom = fromLocalInputValue(from) ?? '';
    const validUntil = fromLocalInputValue(until) ?? '';
    const errs = validateAvailabilityForm({
      member_id: member?.id ?? '',
      status,
      valid_from: validFrom,
      valid_until: validUntil,
      backup_id: backup?.id ?? '',
    });
    setErrors(errs);
    if (Object.keys(errs).length > 0 || !member) return;
    setSaving(true);
    setSubmitError(null);
    try {
      await api.putAvailability({
        member_id: member.id,
        valid_from: validFrom,
        valid_until: validUntil,
        status: status as AvailabilityStatus,
        ...(backup ? { backup_id: backup.id, backup_upn: backup.upn, backup_name: backup.name } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      // Si cambió miembro o inicio, la clave es otra: borrar la fila anterior.
      if (item && (item.member_id !== member.id || item.valid_from !== validFrom)) {
        await api.deleteAvailability(item.member_id, item.valid_from);
      }
      onSaved();
    } catch (err) {
      setSubmitError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open title={item ? 'Editar disponibilidad' : 'Marcar como no disponible'} onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} noValidate className="form-grid">
        <UserPicker id="avail-member" label="Miembro" value={member} onChange={setMember} required error={errors.member_id} />
        <div className="field">
          <label htmlFor="avail-status" className="label">
            Estado *
          </label>
          <select id="avail-status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="vacation">{AVAILABILITY_STATUS_LABELS.vacation}</option>
            <option value="unavailable">{AVAILABILITY_STATUS_LABELS.unavailable}</option>
          </select>
          <FieldError id="avail-status-error" message={errors.status} />
        </div>
        <div className="field-row">
          <div className="field">
            <label htmlFor="avail-from" className="label">
              Desde (hora local) *
            </label>
            <input
              id="avail-from"
              type="datetime-local"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              aria-invalid={errors.valid_from ? true : undefined}
              aria-describedby={errors.valid_from ? 'avail-from-error' : undefined}
            />
            <FieldError id="avail-from-error" message={errors.valid_from} />
          </div>
          <div className="field">
            <label htmlFor="avail-until" className="label">
              Hasta (hora local) *
            </label>
            <input
              id="avail-until"
              type="datetime-local"
              value={until}
              onChange={(e) => setUntil(e.target.value)}
              aria-invalid={errors.valid_until ? true : undefined}
              aria-describedby={errors.valid_until ? 'avail-until-error' : undefined}
            />
            <FieldError id="avail-until-error" message={errors.valid_until} />
          </div>
        </div>
        <UserPicker id="avail-backup" label="Backup (recomendado)" value={backup} onChange={setBackup} error={errors.backup_id} />
        <p className="hint">Sin backup, el slot de esta persona se omite durante la ventana.</p>
        <div className="field">
          <label htmlFor="avail-note" className="label">
            Nota
          </label>
          <input id="avail-note" type="text" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
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
