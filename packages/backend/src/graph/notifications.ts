// Bot Framework notification verification (jose + remote JWKS) and Graph notification parsing.
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';

export const BOT_FRAMEWORK_OPENID_CONFIG = 'https://api.aps.skype.com/v1/.well-known/OpenIdConfiguration';
export const BOT_FRAMEWORK_ISSUER = 'https://api.botframework.com';

let cachedKeyResolver: JWTVerifyGetKey | undefined;
let keyResolverOverride: JWTVerifyGetKey | undefined;

/** Test hook: inject a key resolver (e.g. `createLocalJWKSet`). Pass undefined to restore. */
export function setKeyResolverForTests(resolver: JWTVerifyGetKey | undefined): void {
  keyResolverOverride = resolver;
}

async function discoverJwksUri(fetchImpl: typeof fetch): Promise<string> {
  const res = await fetchImpl(BOT_FRAMEWORK_OPENID_CONFIG);
  if (!res.ok) throw new Error(`No se pudo leer la configuración OpenID de Bot Framework (${res.status})`);
  const json = (await res.json()) as { jwks_uri?: string };
  if (!json.jwks_uri) throw new Error('La configuración OpenID de Bot Framework no contiene jwks_uri');
  return json.jwks_uri;
}

export async function getKeyResolver(fetchImpl: typeof fetch = fetch): Promise<JWTVerifyGetKey> {
  if (keyResolverOverride) return keyResolverOverride;
  if (!cachedKeyResolver) {
    const jwksUri = await discoverJwksUri(fetchImpl);
    cachedKeyResolver = createRemoteJWKSet(new URL(jwksUri));
  }
  return cachedKeyResolver;
}

export interface VerifyOptions {
  audience: string;
  issuer?: string;
  getKey?: JWTVerifyGetKey;
}

/** Extracts the bearer token from an Authorization header value. */
export function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m?.[1]?.trim() || undefined;
}

/** Verifies a Bot Framework JWT (issuer api.botframework.com, audience = Graph app client id). */
export async function verifyBotFrameworkToken(token: string, options: VerifyOptions): Promise<JWTPayload> {
  const getKey = options.getKey ?? (await getKeyResolver());
  const { payload } = await jwtVerify(token, getKey, {
    issuer: options.issuer ?? BOT_FRAMEWORK_ISSUER,
    audience: options.audience,
    clockTolerance: 300,
  });
  return payload;
}

// ---------------------------------------------------------------------------
// Notification payloads
// ---------------------------------------------------------------------------

export interface GraphNotification {
  changeType: string;
  resource: string;
  resourceUrl?: string;
  resourceData?: unknown;
}

export function parseNotifications(body: unknown): GraphNotification[] {
  if (!body || typeof body !== 'object') return [];
  const value = (body as { value?: unknown }).value;
  if (!Array.isArray(value)) return [];
  const out: GraphNotification[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const n = raw as Record<string, unknown>;
    const resource = typeof n['resource'] === 'string' ? (n['resource'] as string) : typeof n['resourceUrl'] === 'string' ? (n['resourceUrl'] as string) : undefined;
    if (!resource) continue;
    out.push({
      changeType: typeof n['changeType'] === 'string' ? (n['changeType'] as string) : 'updated',
      resource,
      resourceUrl: typeof n['resourceUrl'] === 'string' ? (n['resourceUrl'] as string) : undefined,
      resourceData: n['resourceData'],
    });
  }
  return out;
}

export type ClassifiedNotification =
  | { kind: 'participants'; callId: string; participants: unknown[] }
  | { kind: 'call'; callId: string; state: string | undefined; call: Record<string, unknown> }
  | { kind: 'other'; resource: string };

const PARTICIPANTS_RE = /\/(?:app|communications)\/calls\/([^/]+)\/participants(?:\/[^/]+)?\/?$/i;
const CALL_RE = /\/(?:app|communications)\/calls\/([^/]+)\/?$/i;

/** Classifies a notification by its resource path. */
export function classifyNotification(n: GraphNotification): ClassifiedNotification {
  const resource = n.resource;
  const participants = PARTICIPANTS_RE.exec(resource);
  if (participants?.[1]) {
    const data = n.resourceData;
    const list = Array.isArray(data) ? data : data && typeof data === 'object' ? [data] : [];
    return { kind: 'participants', callId: decodeURIComponent(participants[1]), participants: list };
  }
  const call = CALL_RE.exec(resource);
  if (call?.[1]) {
    const data = n.resourceData && typeof n.resourceData === 'object' ? (n.resourceData as Record<string, unknown>) : {};
    const state = typeof data['state'] === 'string' ? (data['state'] as string) : undefined;
    return { kind: 'call', callId: decodeURIComponent(call[1]), state, call: data };
  }
  return { kind: 'other', resource };
}
