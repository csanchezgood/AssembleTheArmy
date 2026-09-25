// Microsoft Graph cloud communications client (ARCHITECTURE.md 3.4).
// - client-credentials token cached in memory until 5 minutes before expiry;
// - retry with exponential backoff on 429/5xx (3 attempts), other 4xx are permanent errors.
import { randomUUID } from 'node:crypto';
import type { Member } from '../domain/types.js';
import { parseJoinUrl } from '../domain/rules.js';
import { createLogger, type Logger } from '../infra/logger.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface GraphClientOptions {
  tenantId: string;
  clientId: string;
  clientSecretProvider: () => Promise<string>;
  baseUrl?: string;
  loginBaseUrl?: string;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  logger?: Logger;
  maxAttempts?: number;
  /** Polling parameters for joinMeeting. */
  joinPollIntervalMs?: number;
  joinTimeoutMs?: number;
}

export class GraphError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'GraphError';
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }
}

export interface GraphIdentity {
  id?: string;
  displayName?: string;
  tenantId?: string;
}

export interface GraphIdentitySet {
  user?: GraphIdentity;
  application?: GraphIdentity;
  guest?: GraphIdentity;
  phone?: GraphIdentity;
  [key: string]: unknown;
}

export interface GraphParticipant {
  id?: string;
  isInLobby?: boolean;
  isMuted?: boolean;
  info?: { identity?: GraphIdentitySet; [key: string]: unknown };
  [key: string]: unknown;
}

export interface GraphCall {
  id?: string;
  state?: string;
  myParticipantId?: string;
  direction?: string;
  [key: string]: unknown;
}

export interface HumanParticipant {
  id: string;
  display_name: string;
}

export interface JoinResult {
  callId: string;
  botParticipantId: string;
}

interface TokenCache {
  token: string;
  expiresAt: number;
}

const TOKEN_SAFETY_MS = 5 * 60 * 1000;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A human participant: has `info.identity.user`, is not in the lobby and is not the bot itself
 * (the bot appears with `info.identity.application` and/or `myParticipantId`).
 */
export function filterHumanParticipants(participants: readonly GraphParticipant[], botParticipantId?: string): HumanParticipant[] {
  const humans: HumanParticipant[] = [];
  for (const p of participants) {
    const identity = p.info?.identity;
    const user = identity?.user;
    if (!user?.id) continue;
    if (identity?.application?.id) continue;
    if (p.isInLobby === true) continue;
    if (botParticipantId && p.id === botParticipantId) continue;
    humans.push({ id: user.id, display_name: user.displayName ?? '' });
  }
  return humans;
}

export class GraphClient {
  private readonly baseUrl: string;
  private readonly loginBaseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: Logger;
  private readonly maxAttempts: number;
  private readonly joinPollIntervalMs: number;
  private readonly joinTimeoutMs: number;
  private tokenCache: TokenCache | undefined;
  private tokenInFlight: Promise<string> | undefined;

  constructor(private readonly options: GraphClientOptions) {
    this.baseUrl = (options.baseUrl ?? 'https://graph.microsoft.com/v1.0').replace(/\/+$/, '');
    this.loginBaseUrl = (options.loginBaseUrl ?? 'https://login.microsoftonline.com').replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.sleep = options.sleep ?? defaultSleep;
    this.log = options.logger ?? createLogger({ component: 'graph' });
    this.maxAttempts = options.maxAttempts ?? 3;
    this.joinPollIntervalMs = options.joinPollIntervalMs ?? 2000;
    this.joinTimeoutMs = options.joinTimeoutMs ?? 30000;
  }

  // ---------------------------------------------------------------- token

  async getToken(): Promise<string> {
    const now = Date.now();
    if (this.tokenCache && this.tokenCache.expiresAt - TOKEN_SAFETY_MS > now) return this.tokenCache.token;
    if (!this.tokenInFlight) {
      this.tokenInFlight = this.fetchToken().finally(() => {
        this.tokenInFlight = undefined;
      });
    }
    return this.tokenInFlight;
  }

  /** Test hook / forced refresh. */
  clearTokenCache(): void {
    this.tokenCache = undefined;
  }

  private async fetchToken(): Promise<string> {
    const secret = await this.options.clientSecretProvider();
    const url = `${this.loginBaseUrl}/${this.options.tenantId}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      client_id: this.options.clientId,
      client_secret: secret,
      grant_type: 'client_credentials',
      scope: 'https://graph.microsoft.com/.default',
    });
    const res = await this.withRetry('POST token', () =>
      this.fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() }),
    );
    const json = (await safeJson(res)) as { access_token?: string; expires_in?: number; error?: string; error_description?: string } | undefined;
    if (!res.ok || !json?.access_token) {
      throw new GraphError(`No se pudo obtener el token de Graph: ${json?.error ?? res.status}`, res.status, json?.error);
    }
    const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : 3600;
    this.tokenCache = { token: json.access_token, expiresAt: Date.now() + expiresIn * 1000 };
    return json.access_token;
  }

  // ---------------------------------------------------------------- transport

  private async withRetry(label: string, attempt: () => Promise<Response>): Promise<Response> {
    let lastError: unknown;
    for (let i = 1; i <= this.maxAttempts; i += 1) {
      try {
        const res = await attempt();
        if (!RETRYABLE_STATUS.has(res.status) || i === this.maxAttempts) return res;
        const retryAfter = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
        const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoffMs(i);
        this.log.warn('Graph respondió con estado reintentable', { label, status: res.status, attempt: i, delay });
        await this.sleep(delay);
      } catch (err) {
        lastError = err;
        if (i === this.maxAttempts) break;
        this.log.warn('Error de red hacia Graph, reintentando', { label, attempt: i, error: String(err) });
        await this.sleep(backoffMs(i));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`Fallo de red hacia Graph (${label})`);
  }

  async request<T>(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<{ status: number; data: T | undefined }> {
    const token = await this.getToken();
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: 'application/json', ...extraHeaders };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await this.withRetry(`${method} ${path}`, () =>
      this.fetchImpl(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
    );
    const data = (await safeJson(res)) as T | undefined;
    if (!res.ok) {
      const errBody = data as { error?: { code?: string; message?: string } } | undefined;
      const code = errBody?.error?.code;
      const message = errBody?.error?.message ?? `HTTP ${res.status}`;
      throw new GraphError(`Graph ${method} ${path} falló: ${message}`, res.status, code, data);
    }
    return { status: res.status, data };
  }

  // ---------------------------------------------------------------- calls

  /** Joins the persistent team meeting as the bot and waits until the call is established. */
  async joinMeeting(joinUrl: string, callbackUri: string): Promise<JoinResult> {
    const parts = parseJoinUrl(joinUrl);
    const payload = {
      '@odata.type': '#microsoft.graph.call',
      callbackUri,
      requestedModalities: ['audio'],
      mediaConfig: { '@odata.type': '#microsoft.graph.serviceHostedMediaConfig' },
      chatInfo: { '@odata.type': '#microsoft.graph.chatInfo', threadId: parts.threadId, messageId: '0' },
      meetingInfo: {
        '@odata.type': '#microsoft.graph.organizerMeetingInfo',
        organizer: {
          '@odata.type': '#microsoft.graph.identitySet',
          user: { '@odata.type': '#microsoft.graph.identity', id: parts.organizerId, tenantId: parts.tenantId },
        },
      },
      tenantId: parts.tenantId,
    };
    const created = await this.request<GraphCall>('POST', '/communications/calls', payload);
    const callId = created.data?.id;
    if (!callId) throw new GraphError('Graph no devolvió el id de la llamada', created.status);

    const deadline = Date.now() + this.joinTimeoutMs;
    let call: GraphCall | undefined = created.data;
    while (call?.state !== 'established') {
      if (call?.state === 'terminated') throw new GraphError('La llamada terminó antes de establecerse', 410, 'callTerminated');
      if (Date.now() >= deadline) throw new GraphError('Tiempo de espera agotado al unirse a la sala', 408, 'joinTimeout');
      await this.sleep(this.joinPollIntervalMs);
      call = await this.getCall(callId) ?? undefined;
      if (!call) throw new GraphError('La llamada desapareció mientras se establecía', 404, 'callGone');
    }
    return { callId, botParticipantId: call.myParticipantId ?? '' };
  }

  async getCall(callId: string): Promise<GraphCall | null> {
    try {
      const res = await this.request<GraphCall>('GET', `/communications/calls/${encodeURIComponent(callId)}`);
      return res.data ?? null;
    } catch (err) {
      if (err instanceof GraphError && err.isNotFound) return null;
      throw err;
    }
  }

  async inviteParticipant(callId: string, userId: string, displayName?: string): Promise<void> {
    const participant: Record<string, unknown> = {
      '@odata.type': '#microsoft.graph.invitationParticipantInfo',
      identity: {
        '@odata.type': '#microsoft.graph.identitySet',
        user: { '@odata.type': '#microsoft.graph.identity', id: userId, ...(displayName ? { displayName } : {}) },
      },
    };
    await this.request('POST', `/communications/calls/${encodeURIComponent(callId)}/participants/invite`, {
      participants: [participant],
      clientContext: randomUUID(),
    });
  }

  async listRawParticipants(callId: string): Promise<GraphParticipant[]> {
    const res = await this.request<{ value?: GraphParticipant[] }>('GET', `/communications/calls/${encodeURIComponent(callId)}/participants`);
    return res.data?.value ?? [];
  }

  /** Humans currently in the call (bot/app identities and lobby excluded). */
  async listParticipants(callId: string, botParticipantId?: string): Promise<HumanParticipant[]> {
    return filterHumanParticipants(await this.listRawParticipants(callId), botParticipantId);
  }

  /** Leaves the call. A 404 means it no longer exists and is not an error. */
  async leaveCall(callId: string): Promise<void> {
    try {
      await this.request('DELETE', `/communications/calls/${encodeURIComponent(callId)}`);
    } catch (err) {
      if (err instanceof GraphError && err.isNotFound) return;
      throw err;
    }
  }

  // ---------------------------------------------------------------- users

  async searchUsers(query: string, top = 20): Promise<Member[]> {
    const q = query.replace(/"/g, '').trim();
    if (!q) return [];
    const search = `"displayName:${q}" OR "mail:${q}" OR "userPrincipalName:${q}"`;
    const params = new URLSearchParams({ $search: search, $select: 'id,displayName,userPrincipalName,mail', $top: String(top) });
    const res = await this.request<{ value?: { id: string; displayName?: string; userPrincipalName?: string; mail?: string }[] }>(
      'GET',
      `/users?${params.toString()}`,
      undefined,
      { ConsistencyLevel: 'eventual' },
    );
    return (res.data?.value ?? []).map((u) => ({ id: u.id, upn: u.userPrincipalName ?? u.mail ?? '', name: u.displayName ?? u.userPrincipalName ?? u.id }));
  }
}

function backoffMs(attempt: number): number {
  return Math.min(8000, 500 * 2 ** (attempt - 1));
}

async function safeJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}
