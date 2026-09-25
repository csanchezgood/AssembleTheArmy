// Shared wiring for handlers: repositories, Graph client and audit helper.
import { buildAuditEvent, type Actor, type AuditEventType } from '../domain/audit.js';
import { createRepositories, type Repositories } from '../infra/dynamo.js';
import { graphEnv } from '../infra/env.js';
import { createLogger, type Logger } from '../infra/logger.js';
import { getSecretJsonField } from '../infra/secrets.js';
import { GraphClient } from '../graph/client.js';

let graphClient: GraphClient | undefined;

/** Container-wide Graph client (keeps the token cache warm between invocations). */
export function getGraphClient(): GraphClient {
  if (!graphClient) {
    const env = graphEnv();
    graphClient = new GraphClient({
      tenantId: env.tenantId,
      clientId: env.clientId,
      clientSecretProvider: () => getSecretJsonField(env.secretArn, 'clientSecret'),
      baseUrl: env.baseUrl,
      loginBaseUrl: env.loginBaseUrl,
    });
  }
  return graphClient;
}

/** Test hook. */
export function resetGraphClient(): void {
  graphClient = undefined;
}

export interface AuditInput {
  incident_id: string;
  event_type: AuditEventType;
  actor: Actor;
  system_id?: string;
  details?: Record<string, unknown>;
}

export interface HandlerContext {
  repos: Repositories;
  log: Logger;
  audit(input: AuditInput): Promise<void>;
  now(): Date;
}

export function createContext(component: string, extra: Record<string, unknown> = {}): HandlerContext {
  const repos = createRepositories();
  const log = createLogger({ component, ...extra });
  return {
    repos,
    log,
    now: () => new Date(),
    audit: async (input) => {
      const event = buildAuditEvent(input);
      await repos.audit.put(event);
      log.debug('audit', { event_type: event.event_type, incident_id: event.incident_id });
    },
  };
}
