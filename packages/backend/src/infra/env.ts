// Typed access to environment variables (ARCHITECTURE.md 3.5). Everything is read lazily so tests
// can set process.env before each handler call.

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`Falta la variable de entorno ${name}`);
  return value;
}

export function optionalEnv(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

export function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) throw new Error(`La variable de entorno ${name} debe ser un entero`);
  return n;
}

export interface CommonEnv {
  project: string;
  env: string;
  rosterTable: string;
  availabilityTable: string;
  severityTable: string;
  incidentsTable: string;
  auditTable: string;
  logLevel: string;
}

export function commonEnv(): CommonEnv {
  return {
    project: optionalEnv('PROJECT', 'ata'),
    env: optionalEnv('ENV', 'dev'),
    rosterTable: requireEnv('ROSTER_TABLE'),
    availabilityTable: requireEnv('AVAILABILITY_TABLE'),
    severityTable: requireEnv('SEVERITY_TABLE'),
    incidentsTable: requireEnv('INCIDENTS_TABLE'),
    auditTable: requireEnv('AUDIT_TABLE'),
    logLevel: optionalEnv('LOG_LEVEL', 'info'),
  };
}

export interface GraphEnv {
  tenantId: string;
  clientId: string;
  secretArn: string;
  callbackUrl: string;
  baseUrl: string;
  loginBaseUrl: string;
}

export function graphEnv(): GraphEnv {
  return {
    tenantId: requireEnv('GRAPH_TENANT_ID'),
    clientId: requireEnv('GRAPH_CLIENT_ID'),
    secretArn: requireEnv('GRAPH_SECRET_ARN'),
    callbackUrl: optionalEnv('GRAPH_CALLBACK_URL', ''),
    baseUrl: optionalEnv('GRAPH_BASE_URL', 'https://graph.microsoft.com/v1.0').replace(/\/+$/, ''),
    loginBaseUrl: optionalEnv('GRAPH_LOGIN_BASE_URL', 'https://login.microsoftonline.com').replace(/\/+$/, ''),
  };
}

export interface WebhookEnv {
  webhookSecretArn: string;
  stateMachineArn: string;
  maxAttempts: number;
  ringTimeoutSeconds: number;
  maxEscalations: number;
}

export function webhookEnv(): WebhookEnv {
  return {
    webhookSecretArn: requireEnv('WEBHOOK_SECRET_ARN'),
    stateMachineArn: requireEnv('STATE_MACHINE_ARN'),
    maxAttempts: intEnv('MAX_ATTEMPTS', 5),
    ringTimeoutSeconds: intEnv('RING_TIMEOUT_SECONDS', 45),
    maxEscalations: intEnv('MAX_ESCALATIONS', 1),
  };
}

export function alertsTopicArn(): string | undefined {
  const v = process.env['ALERTS_TOPIC_ARN'];
  return v === undefined || v === '' ? undefined : v;
}

export function unansweredTtlMinutes(): number {
  return intEnv('UNANSWERED_TTL_MINUTES', 60);
}

export interface AdminEnv {
  adminGroupId: string;
  allowedOrigin: string;
}

export function adminEnv(): AdminEnv {
  return {
    adminGroupId: optionalEnv('ADMIN_GROUP_ID', ''),
    allowedOrigin: optionalEnv('ADMIN_ALLOWED_ORIGIN', '*'),
  };
}
