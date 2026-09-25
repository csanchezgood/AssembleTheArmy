// Cached Secrets Manager reads. Values are cached in the container for SECRET_CACHE_MS.
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

const SECRET_CACHE_MS = 5 * 60 * 1000;

interface CacheEntry {
  value: string;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
let client: SecretsManagerClient | undefined;

function getClient(): SecretsManagerClient {
  if (!client) client = new SecretsManagerClient({});
  return client;
}

export function clearSecretCache(): void {
  cache.clear();
}

export async function getSecretString(arn: string): Promise<string> {
  const hit = cache.get(arn);
  const now = Date.now();
  if (hit && hit.expiresAt > now) return hit.value;
  const res = await getClient().send(new GetSecretValueCommand({ SecretId: arn }));
  const value = res.SecretString ?? (res.SecretBinary ? Buffer.from(res.SecretBinary).toString('utf8') : undefined);
  if (value === undefined) throw new Error(`El secreto ${arn} no tiene valor`);
  cache.set(arn, { value, expiresAt: now + SECRET_CACHE_MS });
  return value;
}

/** Reads a JSON secret and returns the requested key. */
export async function getSecretJsonField(arn: string, field: string): Promise<string> {
  const raw = await getSecretString(arn);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`El secreto ${arn} no es JSON`);
  }
  const value = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>)[field] : undefined;
  if (typeof value !== 'string' || value.length === 0) throw new Error(`El secreto ${arn} no contiene el campo ${field}`);
  return value;
}
