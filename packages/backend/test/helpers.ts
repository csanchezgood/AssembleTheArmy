import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { mockClient } from 'aws-sdk-client-mock';
import type { APIGatewayProxyEventV2, APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { vi } from 'vitest';
import type { Incident, RosterItem, SeverityRule } from '../src/domain/types.js';
import { clearSecretCache } from '../src/infra/secrets.js';
import { resetGraphClient } from '../src/services/context.js';
import { FakeDynamo } from './fake-dynamo.js';

export const TABLES = {
  roster: 'ata-test-roster',
  availability: 'ata-test-availability',
  severity: 'ata-test-severity',
  incidents: 'ata-test-incidents',
  audit: 'ata-test-audit',
} as const;

export const WEBHOOK_SECRET = 'super-secret-value';
export const GRAPH_CLIENT_ID = '11111111-2222-3333-4444-555555555555';
export const JOIN_URL =
  'https://teams.microsoft.com/l/meetup-join/19%3ameeting_ABC123%40thread.v2/0?context=%7b%22Tid%22%3a%22tenant-1%22%2c%22Oid%22%3a%22organizer-1%22%7d';

export function setBaseEnv(): void {
  vi.stubEnv('PROJECT', 'ata');
  vi.stubEnv('ENV', 'test');
  vi.stubEnv('LOG_LEVEL', 'error');
  vi.stubEnv('ROSTER_TABLE', TABLES.roster);
  vi.stubEnv('AVAILABILITY_TABLE', TABLES.availability);
  vi.stubEnv('SEVERITY_TABLE', TABLES.severity);
  vi.stubEnv('INCIDENTS_TABLE', TABLES.incidents);
  vi.stubEnv('AUDIT_TABLE', TABLES.audit);
  vi.stubEnv('GRAPH_TENANT_ID', 'tenant-1');
  vi.stubEnv('GRAPH_CLIENT_ID', GRAPH_CLIENT_ID);
  vi.stubEnv('GRAPH_SECRET_ARN', 'arn:aws:secretsmanager:us-east-1:000000000000:secret:graph');
  vi.stubEnv('GRAPH_CALLBACK_URL', 'https://api.example.com/graph/callback');
  vi.stubEnv('WEBHOOK_SECRET_ARN', 'arn:aws:secretsmanager:us-east-1:000000000000:secret:webhook');
  vi.stubEnv('STATE_MACHINE_ARN', 'arn:aws:states:us-east-1:000000000000:stateMachine:ata-test-convocation');
  vi.stubEnv('ALERTS_TOPIC_ARN', 'arn:aws:sns:us-east-1:000000000000:ata-test-alerts');
  vi.stubEnv('ADMIN_GROUP_ID', 'admin-group');
  vi.stubEnv('ADMIN_ALLOWED_ORIGIN', 'https://admin.example.com');
  vi.stubEnv('AWS_REGION', 'us-east-1');
  clearSecretCache();
  resetGraphClient();
}

export function createFakeDynamo(): FakeDynamo {
  return new FakeDynamo({
    [TABLES.roster]: { pk: 'system_id', sk: 'roster_key', indexes: { by_member: { pk: 'member_id', sk: 'system_id' } } },
    [TABLES.availability]: { pk: 'member_id', sk: 'valid_from' },
    [TABLES.severity]: { pk: 'severity' },
    [TABLES.incidents]: { pk: 'pk', sk: 'sk', indexes: { by_system: { pk: 'system_id', sk: 'opened_at' }, by_status: { pk: 'status', sk: 'opened_at' } } },
    [TABLES.audit]: { pk: 'incident_id', sk: 'event_key' },
  });
}

export function mockSecrets(): void {
  const sm = mockClient(SecretsManagerClient);
  sm.on(GetSecretValueCommand).callsFake((input: { SecretId: string }) => ({
    SecretString: input.SecretId.endsWith(':webhook') ? JSON.stringify({ secret: WEBHOOK_SECRET }) : JSON.stringify({ clientSecret: 'graph-client-secret' }),
  }));
}

// ---------------------------------------------------------------------------
// fetch mocking
// ---------------------------------------------------------------------------

export interface Route {
  method?: string;
  match: string | RegExp;
  reply: (url: string, init: RequestInit | undefined, callIndex: number) => Response | Promise<Response>;
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

export const tokenRoute: Route = { method: 'POST', match: /oauth2\/v2\.0\/token/, reply: () => json(200, { access_token: 'test-token', expires_in: 3600 }) };

export function mockFetch(routes: Route[]) {
  const counts = new Map<Route, number>();
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const route = routes.find((r) => (!r.method || r.method.toUpperCase() === method) && (typeof r.match === 'string' ? url.includes(r.match) : r.match.test(url)));
    if (!route) throw new Error(`fetch inesperado: ${method} ${url}`);
    const n = counts.get(route) ?? 0;
    counts.set(route, n + 1);
    return route.reply(url, init, n);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

export function fetchCalls(fn: ReturnType<typeof mockFetch>): { method: string; url: string; body?: unknown }[] {
  return fn.mock.calls.map(([input, init]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === 'string' && init.headers && (init.headers as Record<string, string>)['content-type']?.includes('json') ? JSON.parse(init.body) : init?.body;
    return { method: (init?.method ?? 'GET').toUpperCase(), url, body };
  });
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export function apiEvent(init: { method?: string; path?: string; headers?: Record<string, string>; body?: unknown; query?: Record<string, string> }): APIGatewayProxyEventV2 {
  const method = init.method ?? 'POST';
  const path = init.path ?? '/';
  return {
    version: '2.0',
    routeKey: `${method} ${path}`,
    rawPath: path,
    rawQueryString: new URLSearchParams(init.query ?? {}).toString(),
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    queryStringParameters: init.query,
    requestContext: {
      accountId: '000000000000',
      apiId: 'api',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: { method, path, protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'vitest' },
      requestId: 'req',
      routeKey: `${method} ${path}`,
      stage: '$default',
      time: '',
      timeEpoch: Date.now(),
    },
    body: init.body === undefined ? undefined : typeof init.body === 'string' ? init.body : JSON.stringify(init.body),
    isBase64Encoded: false,
  };
}

export function adminEvent(init: { method?: string; path: string; body?: unknown; query?: Record<string, string>; claims?: Record<string, unknown> }): APIGatewayProxyEventV2WithJWTAuthorizer {
  const base = apiEvent({ method: init.method ?? 'GET', path: init.path, body: init.body, query: init.query });
  const claims = init.claims ?? { preferred_username: 'ana@example.com', name: 'Ana Admin', groups: '[admin-group other-group]' };
  return {
    ...base,
    requestContext: { ...base.requestContext, authorizer: { principalId: 'p', integrationLatency: 0, jwt: { claims: claims as Record<string, string>, scopes: [] } } },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export function rule(overrides: Partial<SeverityRule> = {}): SeverityRule {
  return {
    severity: 'critical',
    team_id: 'N3',
    notify_webhook_urls: [],
    enabled: true,
    updated_at: '2026-09-24T00:00:00.000Z',
    updated_by: 'admin:ana@example.com',
    ...overrides,
  };
}

export function rosterItem(overrides: Partial<RosterItem> = {}): RosterItem {
  const team = overrides.team_id ?? 'N3';
  const prio = overrides.priority_order ?? 1;
  const member = overrides.member_id ?? 'oid-1';
  return {
    system_id: 'payments-api',
    roster_key: `${team}#${String(prio).padStart(3, '0')}#${member}`,
    team_id: team,
    priority_order: prio,
    member_id: member,
    member_upn: overrides.member_upn ?? `${member}@example.com`,
    member_name: overrides.member_name ?? `Persona ${member}`,
    room_join_url: JOIN_URL,
    updated_at: '2026-09-24T00:00:00.000Z',
    updated_by: 'admin:ana@example.com',
    ...overrides,
  };
}

export function incident(overrides: Partial<Incident> = {}): Incident {
  return {
    incident_id: overrides.incident_id ?? '01J0000000000000000000INC1',
    system_id: 'payments-api',
    severity: 'critical',
    team_id: 'N3',
    initial_team_id: 'N3',
    status: 'convoking',
    opened_at: '2026-09-24T10:00:00.000Z',
    room_join_url: JOIN_URL,
    participants: [],
    participant_count: 0,
    ever_connected: false,
    escalation_count: 0,
    last_alert_at: '2026-09-24T10:00:00.000Z',
    echo_count: 0,
    ...overrides,
  };
}

export function seedIncident(db: FakeDynamo, inc: Incident, withLock = true): void {
  db.seed(TABLES.incidents, [{ ...inc, pk: `INC#${inc.incident_id}`, sk: 'META' }]);
  if (withLock) db.seed(TABLES.incidents, [{ pk: `LOCK#${inc.system_id}`, sk: 'META', incident_id: inc.incident_id, created_at: inc.opened_at, ttl: 9999999999 }]);
}

export function auditTypes(db: FakeDynamo, incidentId?: string): string[] {
  return db
    .items(TABLES.audit)
    .filter((e) => !incidentId || e['incident_id'] === incidentId)
    .sort((a, b) => String(a['event_key']).localeCompare(String(b['event_key'])))
    .map((e) => String(e['event_type']));
}

export function participant(id: string, name = `Usuario ${id}`, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: `p-${id}`, isInLobby: false, info: { identity: { user: { id, displayName: name } } }, ...extra };
}
