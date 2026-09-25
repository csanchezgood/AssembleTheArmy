import { useEffect, useState, type FormEvent } from 'react';
import { useApi } from '../api/ApiContext';
import type { SeverityRule, TeamId } from '../api/types';
import { ConfirmDialog } from '../components/Dialog';
import { EmptyState, ErrorMessage, FieldError, Loading } from '../components/States';
import { formatDateTime } from '../lib/dates';
import { TEAM_IDS } from '../lib/labels';
import { errorMessage, useAsync } from '../lib/useAsync';
import {
  splitUrls,
  validateSeverityForm,
  type FieldErrors,
  type SeverityFormField,
  type SeverityFormValues,
} from '../lib/validation';

const toForm = (rule: SeverityRule | null): SeverityFormValues => ({
  severity: rule?.severity ?? '',
  team_id: rule?.team_id ?? 'N2',
  escalate_to_team_id: rule?.escalate_to_team_id ?? '',
  escalate_after_minutes: rule?.escalate_after_minutes !== undefined ? String(rule.escalate_after_minutes) : '',
  notify_webhook_urls: rule?.notify_webhook_urls.join('\n') ?? '',
  enabled: rule?.enabled ?? true,
});

export function SeverityRulesPage() {
  const api = useApi();
  const rules = useAsync(() => api.listSeverityRules(), [api]);
  const [adding, setAdding] = useState(false);
  const [toDelete, setToDelete] = useState<SeverityRule | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const confirmDelete = async () => {
    if (!toDelete) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.deleteSeverityRule(toDelete.severity);
      setToDelete(null);
      rules.reload();
    } catch (err) {
      setDeleteError(errorMessage(err));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="page page-severity">
      <div className="page-header">
        <h1>Reglas de severidad</h1>
        <button type="button" className="btn btn-primary" onClick={() => setAdding(true)} disabled={adding}>
          Añadir severidad
        </button>
      </div>
      <p className="page-intro">
        Cada severidad (tal como llega en el payload de New Relic) define el equipo convocado, la escalación automática y
        los webhooks de Teams que reciben una tarjeta informativa. Si la regla está deshabilitada, la alerta solo se audita.
      </p>
      {rules.loading && <Loading label="Cargando reglas…" />}
      {rules.error && <ErrorMessage message={rules.error} onRetry={rules.reload} />}
      {rules.data && rules.data.length === 0 && !adding && (
        <EmptyState title="No hay reglas de severidad">
          <p>Sin reglas, ninguna alerta genera convocatoria. Añade al menos «critical» y «high».</p>
        </EmptyState>
      )}
      <div className="rule-list">
        {rules.data?.map((rule) => (
          <SeverityRuleForm
            key={rule.severity}
            rule={rule}
            onSaved={rules.reload}
            onDelete={() => {
              setDeleteError(null);
              setToDelete(rule);
            }}
          />
        ))}
        {adding && (
          <SeverityRuleForm
            rule={null}
            onSaved={() => {
              setAdding(false);
              rules.reload();
            }}
            onCancel={() => setAdding(false)}
          />
        )}
      </div>
      <ConfirmDialog
        open={toDelete !== null}
        title="Eliminar regla de severidad"
        message={
          toDelete && (
            <p>
              ¿Eliminar la regla para <strong>{toDelete.severity}</strong>? Las alertas con esa severidad dejarán de
              generar convocatorias.
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

export function SeverityRuleForm({
  rule,
  onSaved,
  onDelete,
  onCancel,
}: {
  rule: SeverityRule | null;
  onSaved: () => void;
  onDelete?: () => void;
  onCancel?: () => void;
}) {
  const api = useApi();
  const [values, setValues] = useState<SeverityFormValues>(() => toForm(rule));
  const [errors, setErrors] = useState<FieldErrors<SeverityFormField>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  useEffect(() => {
    setValues(toForm(rule));
    setErrors({});
  }, [rule]);

  const idPrefix = `sev-${rule?.severity ?? 'new'}`;
  const set = <K extends SeverityFormField>(key: K, value: SeverityFormValues[K]) =>
    setValues((v) => ({ ...v, [key]: value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs = validateSeverityForm(values);
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    setSaving(true);
    setSubmitError(null);
    setSavedAt(null);
    try {
      const minutes = values.escalate_after_minutes.trim();
      await api.putSeverityRule({
        severity: values.severity.trim(),
        team_id: values.team_id as TeamId,
        ...(values.escalate_to_team_id ? { escalate_to_team_id: values.escalate_to_team_id as TeamId } : {}),
        ...(minutes ? { escalate_after_minutes: Number(minutes) } : {}),
        notify_webhook_urls: splitUrls(values.notify_webhook_urls),
        enabled: values.enabled,
      });
      setSavedAt(new Date().toISOString());
      onSaved();
    } catch (err) {
      setSubmitError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className={`rule-card${values.enabled ? '' : ' rule-disabled'}`}
      onSubmit={(e) => void submit(e)}
      noValidate
      aria-label={rule ? `Regla ${rule.severity}` : 'Nueva regla de severidad'}
    >
      <div className="rule-grid">
        <div className="field">
          <label htmlFor={`${idPrefix}-severity`} className="label">
            Severidad *
          </label>
          {rule ? (
            <input id={`${idPrefix}-severity`} type="text" value={values.severity} readOnly aria-readonly="true" />
          ) : (
            <input
              id={`${idPrefix}-severity`}
              type="text"
              value={values.severity}
              onChange={(e) => set('severity', e.target.value)}
              placeholder="critical"
              aria-invalid={errors.severity ? true : undefined}
              aria-describedby={errors.severity ? `${idPrefix}-severity-error` : undefined}
            />
          )}
          <FieldError id={`${idPrefix}-severity-error`} message={errors.severity} />
        </div>
        <div className="field">
          <label htmlFor={`${idPrefix}-team`} className="label">
            Equipo convocado *
          </label>
          <select
            id={`${idPrefix}-team`}
            value={values.team_id}
            onChange={(e) => set('team_id', e.target.value)}
            aria-invalid={errors.team_id ? true : undefined}
            aria-describedby={errors.team_id ? `${idPrefix}-team-error` : undefined}
          >
            {TEAM_IDS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <FieldError id={`${idPrefix}-team-error`} message={errors.team_id} />
        </div>
        <div className="field">
          <label htmlFor={`${idPrefix}-escalate`} className="label">
            Escalar a
          </label>
          <select
            id={`${idPrefix}-escalate`}
            value={values.escalate_to_team_id}
            onChange={(e) => set('escalate_to_team_id', e.target.value)}
            aria-invalid={errors.escalate_to_team_id ? true : undefined}
            aria-describedby={errors.escalate_to_team_id ? `${idPrefix}-escalate-error` : undefined}
          >
            <option value="">Sin escalación</option>
            {TEAM_IDS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <FieldError id={`${idPrefix}-escalate-error`} message={errors.escalate_to_team_id} />
        </div>
        <div className="field">
          <label htmlFor={`${idPrefix}-minutes`} className="label">
            Escalar tras (min)
          </label>
          <input
            id={`${idPrefix}-minutes`}
            type="number"
            min={1}
            step={1}
            value={values.escalate_after_minutes}
            onChange={(e) => set('escalate_after_minutes', e.target.value)}
            aria-invalid={errors.escalate_after_minutes ? true : undefined}
            aria-describedby={errors.escalate_after_minutes ? `${idPrefix}-minutes-error` : undefined}
          />
          <FieldError id={`${idPrefix}-minutes-error`} message={errors.escalate_after_minutes} />
        </div>
        <div className="field field-wide">
          <label htmlFor={`${idPrefix}-webhooks`} className="label">
            Webhooks de notificación (uno por línea)
          </label>
          <textarea
            id={`${idPrefix}-webhooks`}
            rows={3}
            value={values.notify_webhook_urls}
            onChange={(e) => set('notify_webhook_urls', e.target.value)}
            placeholder="https://contoso.webhook.office.com/webhookb2/…"
            aria-invalid={errors.notify_webhook_urls ? true : undefined}
            aria-describedby={errors.notify_webhook_urls ? `${idPrefix}-webhooks-error` : undefined}
            spellCheck={false}
          />
          <FieldError id={`${idPrefix}-webhooks-error`} message={errors.notify_webhook_urls} />
        </div>
        <div className="field field-toggle">
          <label className="toggle">
            <input
              type="checkbox"
              role="switch"
              checked={values.enabled}
              onChange={(e) => set('enabled', e.target.checked)}
              aria-checked={values.enabled}
            />
            <span>{values.enabled ? 'Habilitada' : 'Deshabilitada (solo se audita)'}</span>
          </label>
        </div>
      </div>
      {submitError && (
        <p className="form-error" role="alert">
          {submitError}
        </p>
      )}
      <div className="rule-footer">
        <span className="muted">
          {rule
            ? `Actualizada ${formatDateTime(rule.updated_at)} por ${rule.updated_by.replace(/^admin:/, '')}`
            : 'Nueva regla'}
          {savedAt && <span className="saved-ok"> · Guardado</span>}
        </span>
        <span className="rule-actions">
          {onCancel && (
            <button type="button" className="btn btn-secondary btn-sm" onClick={onCancel} disabled={saving}>
              Cancelar
            </button>
          )}
          {onDelete && (
            <button type="button" className="btn btn-link btn-danger-link" onClick={onDelete} disabled={saving}>
              Eliminar
            </button>
          )}
          <button type="submit" className="btn btn-primary btn-sm" disabled={saving}>
            {saving ? 'Guardando…' : 'Guardar'}
          </button>
        </span>
      </div>
    </form>
  );
}
