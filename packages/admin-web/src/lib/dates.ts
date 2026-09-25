/** Utilidades de fechas: las APIs devuelven ISO 8601 UTC; la UI muestra hora local. */

export interface FormatOptions {
  locale?: string;
  timeZone?: string;
}

const EMPTY = '—';

export function parseIso(iso: string | undefined | null): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** `24/09/2026, 18:03` en la zona horaria local (o la indicada). */
export function formatDateTime(iso: string | undefined | null, opts: FormatOptions = {}): string {
  const d = parseIso(iso);
  if (!d) return EMPTY;
  return new Intl.DateTimeFormat(opts.locale ?? 'es', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: opts.timeZone,
  }).format(d);
}

/** Con segundos, para la línea de tiempo. */
export function formatTime(iso: string | undefined | null, opts: FormatOptions = {}): string {
  const d = parseIso(iso);
  if (!d) return EMPTY;
  return new Intl.DateTimeFormat(opts.locale ?? 'es', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: opts.timeZone,
  }).format(d);
}

/** Duración legible entre dos instantes: `47 min`, `1 h 25 min`, `2 d 3 h`. */
export function formatDuration(fromIso: string | undefined | null, toIso?: string | null, now: Date = new Date()): string {
  const from = parseIso(fromIso);
  if (!from) return EMPTY;
  const to = parseIso(toIso) ?? now;
  const totalMinutes = Math.max(0, Math.round((to.getTime() - from.getTime()) / 60_000));
  if (totalMinutes < 1) return '< 1 min';
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return hours > 0 ? `${days} d ${hours} h` : `${days} d`;
  if (hours > 0) return minutes > 0 ? `${hours} h ${minutes} min` : `${hours} h`;
  return `${minutes} min`;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** ISO UTC → valor para `<input type="datetime-local">` en hora local (`YYYY-MM-DDTHH:mm`). */
export function toLocalInputValue(iso: string | undefined | null): string {
  const d = parseIso(iso);
  if (!d) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Valor de `<input type="datetime-local">` (hora local) → ISO 8601 UTC. `null` si no es válido. */
export function fromLocalInputValue(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** ¿El instante `t` (por defecto ahora) cae dentro de [from, until)? */
export function isWithin(fromIso: string, untilIso: string, t: Date = new Date()): boolean {
  const from = parseIso(fromIso);
  const until = parseIso(untilIso);
  if (!from || !until) return false;
  return from.getTime() <= t.getTime() && t.getTime() < until.getTime();
}
