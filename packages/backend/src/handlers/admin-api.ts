// ANY /admin/{proxy+} — configuration CRUD, incident/audit queries and Graph user search.
// Authentication is done by the API Gateway JWT authorizer; this handler enforces the admin group.
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { ADMIN_AUDIT_PK, AuditEvents } from '../domain/audit.js';
import { isTeamId, normalizeSeverity, normalizeSystemId, parseJoinUrl } from '../domain/rules.js';
import { AVAILABILITY_STATUSES, INCIDENT_STATUSES, type AvailabilityItem, type AvailabilityStatus, type Incident, type IncidentStatus, type RosterItem, type SeverityRule } from '../domain/types.js';
import { rosterKey } from '../infra/dynamo.js';
import { adminEnv } from '../infra/env.js';
import { corsHeaders, errorResponse, jsonResponse, parseJsonBody, type HttpResponse } from '../infra/http.js';
import { createContext, getGraphClient, type HandlerContext } from '../services/context.js';

type Claims = Record<string, unknown>;

export interface AdminUser {
  upn: string;
  name: string;
  is_admin: boolean;
}

/** API Gateway HTTP API renders array claims as the string "[a b]"; accept both forms. */
export function claimAsList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string') return [];
  const trimmed = value.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed
      .slice(1, -1)
      .split(/[\s,]+/)
      .map((s) => s.replace(/^"|"$/g, ''))
      .filter(Boolean);
  }
  return trimmed ? [trimmed] : [];
}

export function userFromClaims(claims: Claims, adminGroupId: string): AdminUser {
  const upn = firstString(claims, ['preferred_username', 'upn', 'email', 'unique_name']) ?? firstString(claims, ['oid', 'sub']) ?? 'desconocido';
  const name = firstString(claims, ['name']) ?? upn;
  const memberships = [...claimAsList(claims['groups']), ...claimAsList(claims['roles'])];
  const is_admin = adminGroupId === '' || memberships.includes(adminGroupId);
  return { upn, name, is_admin };
}

function firstString(claims: Claims, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = claims[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return undefined;
}

class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<HttpResponse> {
  const env = adminEnv();
  const cors = corsHeaders(env.allowedOrigin);
  const method = event.requestContext?.http?.method ?? 'GET';
  if (method === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };

  const claims = (event.requestContext?.authorizer?.jwt?.claims ?? {}) as Claims;
  const user = userFromClaims(claims, env.adminGroupId);
  if (!user.is_admin) return errorResponse(403, 'No autorizado: el usuario no pertenece al grupo de administración', cors);

  const ctx = createContext('admin-api', { upn: user.upn });
  try {
    const res = await route(ctx, event, user);
    return { ...res, headers: { ...(res.headers ?? {}), ...cors } };
  } catch (err) {
    if (err instanceof HttpError) return errorResponse(err.status, err.message, cors);
    ctx.log.error('Error no controlado en admin-api', { error: String(err) });
    return errorResponse(500, 'Error interno', cors);
  }
}

function pathOf(event: APIGatewayProxyEventV2WithJWTAuthorizer): string {
  let p = event.rawPath || '/';
  const stage = event.requestContext?.stage;
  if (stage && stage !== '$default' && p.startsWith(`/${stage}/`)) p = p.slice(stage.length + 1);
  return p.replace(/\/+$/, '') || '/';
}

async function route(ctx: HandlerContext, event: APIGatewayProxyEventV2WithJWTAuthorizer, user: AdminUser): Promise<HttpResponse> {
  const method = event.requestContext.http.method.toUpperCase();
  const path = pathOf(event);
  const qs = event.queryStringParameters ?? {};
  const key = `${method} ${path}`;

  if (key === 'GET /admin/me') return jsonResponse(200, user);
  if (key === 'GET /admin/systems') return listSystems(ctx);
  if (key === 'GET /admin/roster') return listRoster(ctx, qs);
  if (key === 'PUT /admin/roster') return putRoster(ctx, parseJsonBody(event), user);
  if (key === 'DELETE /admin/roster') return deleteRoster(ctx, qs, user);
  if (key === 'GET /admin/availability') return listAvailability(ctx, qs);
  if (key === 'PUT /admin/availability') return putAvailability(ctx, parseJsonBody(event), user);
  if (key === 'DELETE /admin/availability') return deleteAvailability(ctx, qs, user);
  if (key === 'GET /admin/severity-rules') return listSeverity(ctx);
  if (key === 'PUT /admin/severity-rules') return putSeverity(ctx, parseJsonBody(event), user);
  if (key === 'DELETE /admin/severity-rules') return deleteSeverity(ctx, qs, user);
  if (key === 'GET /admin/incidents') return listIncidents(ctx, qs);
  if (method === 'GET' && path.startsWith('/admin/incidents/')) return getIncident(ctx, decodeURIComponent(path.slice('/admin/incidents/'.length)));
  if (key === 'GET /admin/users') return searchUsers(qs);
  if (key === 'GET /admin/audit') return listAudit(ctx, qs);
  throw new HttpError(404, `Ruta no encontrada: ${key}`);
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function asObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Cuerpo JSON inválido');
  return body as Record<string, unknown>;
}

function reqString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== 'string' || v.trim() === '') throw new HttpError(400, `El campo ${key} es obligatorio`);
  return v.trim();
}

function optString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw new HttpError(400, `El campo ${key} debe ser texto`);
  return v.trim();
}

function reqQuery(qs: Record<string, string | undefined>, key: string): string {
  const v = qs[key];
  if (!v || v.trim() === '') throw new HttpError(400, `El parámetro ${key} es obligatorio`);
  return v.trim();
}

function isoOrThrow(value: string, key: string): string {
  if (Number.isNaN(Date.parse(value))) throw new HttpError(400, `El campo ${key} debe ser una fecha ISO 8601`);
  return new Date(value).toISOString();
}

async function auditConfigChange(ctx: HandlerContext, user: AdminUser, details: Record<string, unknown>): Promise<void> {
  await ctx.audit({ incident_id: ADMIN_AUDIT_PK, event_type: AuditEvents.config_changed, actor: `admin:${user.upn}`, details });
}

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

async function listSystems(ctx: HandlerContext): Promise<HttpResponse> {
  const items = await ctx.repos.roster.scanAll();
  const bySystem = new Map<string, { teams: Set<string>; member_count: number }>();
  for (const item of items) {
    const entry = bySystem.get(item.system_id) ?? { teams: new Set<string>(), member_count: 0 };
    entry.teams.add(item.team_id);
    entry.member_count += 1;
    bySystem.set(item.system_id, entry);
  }
  const systems = [...bySystem.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([system_id, e]) => ({ system_id, teams: [...e.teams].sort(), member_count: e.member_count }));
  return jsonResponse(200, { systems });
}

async function listRoster(ctx: HandlerContext, qs: Record<string, string | undefined>): Promise<HttpResponse> {
  const systemId = normalizeSystemId(reqQuery(qs, 'system_id'));
  const items = (await ctx.repos.roster.listBySystem(systemId)).sort(
    (a, b) => a.team_id.localeCompare(b.team_id) || a.priority_order - b.priority_order || a.member_name.localeCompare(b.member_name),
  );
  return jsonResponse(200, { items });
}

async function putRoster(ctx: HandlerContext, body: unknown, user: AdminUser): Promise<HttpResponse> {
  const b = asObject(body);
  const system_id = normalizeSystemId(reqString(b, 'system_id'));
  const team_id = reqString(b, 'team_id');
  if (!isTeamId(team_id)) throw new HttpError(400, 'team_id debe ser N2 o N3');
  const priority = b['priority_order'];
  if (typeof priority !== 'number' || !Number.isInteger(priority) || priority < 0 || priority > 999) throw new HttpError(400, 'priority_order debe ser un entero entre 0 y 999');
  const member_id = reqString(b, 'member_id');
  const member_upn = reqString(b, 'member_upn');
  const member_name = reqString(b, 'member_name');
  const room_join_url = reqString(b, 'room_join_url');
  try {
    parseJoinUrl(room_join_url);
  } catch (err) {
    throw new HttpError(400, err instanceof Error ? err.message : 'room_join_url inválida');
  }
  const item: RosterItem = {
    system_id,
    roster_key: rosterKey(team_id, priority, member_id),
    team_id,
    priority_order: priority,
    member_id,
    member_upn,
    member_name,
    room_join_url,
    updated_at: ctx.now().toISOString(),
    updated_by: user.upn,
  };
  await ctx.repos.roster.put(item);
  await auditConfigChange(ctx, user, { table: 'roster', action: 'put', system_id, roster_key: item.roster_key, item, motivo: 'Guardia actualizada desde el panel' });
  return jsonResponse(200, { item });
}

async function deleteRoster(ctx: HandlerContext, qs: Record<string, string | undefined>, user: AdminUser): Promise<HttpResponse> {
  const system_id = normalizeSystemId(reqQuery(qs, 'system_id'));
  const roster_key = reqQuery(qs, 'roster_key');
  await ctx.repos.roster.delete(system_id, roster_key);
  await auditConfigChange(ctx, user, { table: 'roster', action: 'delete', system_id, roster_key, motivo: 'Guardia eliminada desde el panel' });
  return jsonResponse(200, { ok: true });
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

async function listAvailability(ctx: HandlerContext, qs: Record<string, string | undefined>): Promise<HttpResponse> {
  const memberId = qs['member_id']?.trim();
  const items = memberId ? await ctx.repos.availability.listByMember(memberId) : await ctx.repos.availability.scanAll();
  items.sort((a, b) => a.member_id.localeCompare(b.member_id) || b.valid_from.localeCompare(a.valid_from));
  return jsonResponse(200, { items });
}

async function putAvailability(ctx: HandlerContext, body: unknown, user: AdminUser): Promise<HttpResponse> {
  const b = asObject(body);
  const member_id = reqString(b, 'member_id');
  const valid_from = isoOrThrow(reqString(b, 'valid_from'), 'valid_from');
  const valid_until = isoOrThrow(reqString(b, 'valid_until'), 'valid_until');
  if (valid_until <= valid_from) throw new HttpError(400, 'valid_until debe ser posterior a valid_from');
  const status = reqString(b, 'status') as AvailabilityStatus;
  if (!AVAILABILITY_STATUSES.includes(status)) throw new HttpError(400, 'status debe ser available, vacation o unavailable');
  const backup_id = optString(b, 'backup_id');
  if (status !== 'available' && !backup_id) throw new HttpError(400, 'backup_id es obligatorio cuando el miembro no está disponible');
  if (backup_id && backup_id === member_id) throw new HttpError(400, 'El backup no puede ser el mismo miembro');
  const item: AvailabilityItem = {
    member_id,
    valid_from,
    valid_until,
    status,
    ...(backup_id ? { backup_id } : {}),
    ...(optString(b, 'backup_upn') ? { backup_upn: optString(b, 'backup_upn') } : {}),
    ...(optString(b, 'backup_name') ? { backup_name: optString(b, 'backup_name') } : {}),
    ...(optString(b, 'note') ? { note: optString(b, 'note') } : {}),
    updated_at: ctx.now().toISOString(),
    updated_by: user.upn,
  };
  await ctx.repos.availability.put(item);
  await auditConfigChange(ctx, user, { table: 'availability', action: 'put', member_id, valid_from, item, motivo: 'Disponibilidad actualizada desde el panel' });
  return jsonResponse(200, { item });
}

async function deleteAvailability(ctx: HandlerContext, qs: Record<string, string | undefined>, user: AdminUser): Promise<HttpResponse> {
  const member_id = reqQuery(qs, 'member_id');
  const valid_from = reqQuery(qs, 'valid_from');
  await ctx.repos.availability.delete(member_id, valid_from);
  await auditConfigChange(ctx, user, { table: 'availability', action: 'delete', member_id, valid_from, motivo: 'Disponibilidad eliminada desde el panel' });
  return jsonResponse(200, { ok: true });
}

// ---------------------------------------------------------------------------
// Severity rules
// ---------------------------------------------------------------------------

async function listSeverity(ctx: HandlerContext): Promise<HttpResponse> {
  const items = (await ctx.repos.severity.scanAll()).sort((a, b) => a.severity.localeCompare(b.severity));
  return jsonResponse(200, { items });
}

async function putSeverity(ctx: HandlerContext, body: unknown, user: AdminUser): Promise<HttpResponse> {
  const b = asObject(body);
  const severity = normalizeSeverity(reqString(b, 'severity'));
  const team_id = reqString(b, 'team_id');
  if (!isTeamId(team_id)) throw new HttpError(400, 'team_id debe ser N2 o N3');
  const escalate = optString(b, 'escalate_to_team_id');
  if (escalate !== undefined && !isTeamId(escalate)) throw new HttpError(400, 'escalate_to_team_id debe ser N2 o N3');
  if (escalate !== undefined && escalate === team_id) throw new HttpError(400, 'escalate_to_team_id debe ser distinto de team_id');
  const after = b['escalate_after_minutes'];
  if (after !== undefined && after !== null && (typeof after !== 'number' || after < 0)) throw new HttpError(400, 'escalate_after_minutes debe ser un número >= 0');
  const urls = b['notify_webhook_urls'] ?? [];
  if (!Array.isArray(urls) || !urls.every((u) => typeof u === 'string' && /^https:\/\//i.test(u))) throw new HttpError(400, 'notify_webhook_urls debe ser una lista de URLs https');
  const enabled = b['enabled'];
  if (typeof enabled !== 'boolean') throw new HttpError(400, 'enabled debe ser booleano');
  const item: SeverityRule = {
    severity,
    team_id,
    ...(escalate ? { escalate_to_team_id: escalate } : {}),
    ...(typeof after === 'number' ? { escalate_after_minutes: after } : {}),
    notify_webhook_urls: urls as string[],
    enabled,
    updated_at: ctx.now().toISOString(),
    updated_by: user.upn,
  };
  await ctx.repos.severity.put(item);
  await auditConfigChange(ctx, user, { table: 'severity_rules', action: 'put', severity, item, motivo: 'Regla de severidad actualizada desde el panel' });
  return jsonResponse(200, { item });
}

async function deleteSeverity(ctx: HandlerContext, qs: Record<string, string | undefined>, user: AdminUser): Promise<HttpResponse> {
  const severity = normalizeSeverity(reqQuery(qs, 'severity'));
  await ctx.repos.severity.delete(severity);
  await auditConfigChange(ctx, user, { table: 'severity_rules', action: 'delete', severity, motivo: 'Regla de severidad eliminada desde el panel' });
  return jsonResponse(200, { ok: true });
}

// ---------------------------------------------------------------------------
// Incidents / audit / users
// ---------------------------------------------------------------------------

function parseLimit(raw: string | undefined, fallback: number, max = 200): number {
  const n = raw ? Number.parseInt(raw, 10) : fallback;
  if (Number.isNaN(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

async function listIncidents(ctx: HandlerContext, qs: Record<string, string | undefined>): Promise<HttpResponse> {
  const limit = parseLimit(qs['limit'], 50);
  const cursor = qs['cursor']?.trim() || undefined;
  const systemId = qs['system_id']?.trim() ? normalizeSystemId(qs['system_id'] as string) : undefined;
  const statusRaw = qs['status']?.trim();
  let status: IncidentStatus | undefined;
  if (statusRaw) {
    if (!INCIDENT_STATUSES.includes(statusRaw as IncidentStatus)) throw new HttpError(400, 'status inválido');
    status = statusRaw as IncidentStatus;
  }
  if (systemId) {
    const page = await ctx.repos.incidents.listBySystem(systemId, { limit, cursor, status });
    return jsonResponse(200, { items: page.items, ...(page.cursor ? { cursor: page.cursor } : {}) });
  }
  if (status) {
    const page = await ctx.repos.incidents.listByStatus(status, { limit, cursor });
    return jsonResponse(200, { items: page.items, ...(page.cursor ? { cursor: page.cursor } : {}) });
  }
  // No filters: merge the newest incidents of every status (cursor not supported in this mode).
  const pages = await Promise.all(INCIDENT_STATUSES.map((s) => ctx.repos.incidents.listByStatus(s, { limit })));
  const items: Incident[] = pages.flatMap((p) => p.items).sort((a, b) => b.opened_at.localeCompare(a.opened_at)).slice(0, limit);
  return jsonResponse(200, { items });
}

async function getIncident(ctx: HandlerContext, incidentId: string): Promise<HttpResponse> {
  if (!incidentId) throw new HttpError(400, 'incident_id es obligatorio');
  const incident = await ctx.repos.incidents.get(incidentId);
  if (!incident) throw new HttpError(404, 'Incidente no encontrado');
  const events = await ctx.repos.audit.listByIncident(incidentId, { ascending: true, limit: 500 });
  return jsonResponse(200, { incident, events: events.items });
}

async function listAudit(ctx: HandlerContext, qs: Record<string, string | undefined>): Promise<HttpResponse> {
  const incidentId = qs['incident_id']?.trim() || ADMIN_AUDIT_PK;
  const limit = parseLimit(qs['limit'], 100, 500);
  const page = await ctx.repos.audit.listByIncident(incidentId, { limit, ascending: false, cursor: qs['cursor']?.trim() || undefined });
  return jsonResponse(200, { items: page.items, ...(page.cursor ? { cursor: page.cursor } : {}) });
}

async function searchUsers(qs: Record<string, string | undefined>): Promise<HttpResponse> {
  const search = qs['search']?.trim() ?? '';
  if (search.length < 2) return jsonResponse(200, { users: [] });
  const users = await getGraphClient().searchUsers(search);
  return jsonResponse(200, { users });
}
