// API Gateway HTTP API (payload v2) helpers.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

export type HttpResponse = APIGatewayProxyStructuredResultV2;

export function jsonResponse(statusCode: number, body: unknown, headers: Record<string, string> = {}): HttpResponse {
  return {
    statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
    body: JSON.stringify(body),
  };
}

export function emptyResponse(statusCode: number, headers: Record<string, string> = {}): HttpResponse {
  return { statusCode, headers, body: '' };
}

export function errorResponse(statusCode: number, message: string, headers: Record<string, string> = {}): HttpResponse {
  return jsonResponse(statusCode, { error: message }, headers);
}

/** Case-insensitive header lookup. */
export function getHeader(event: Pick<APIGatewayProxyEventV2, 'headers'>, name: string): string | undefined {
  const headers = event.headers ?? {};
  const wanted = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === wanted) return v;
  }
  return undefined;
}

/** Decodes the request body (base64 aware). Returns undefined when empty. */
export function rawBody(event: Pick<APIGatewayProxyEventV2, 'body' | 'isBase64Encoded'>): string | undefined {
  if (event.body === undefined || event.body === null || event.body === '') return undefined;
  return event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
}

/** Parses the JSON body; returns undefined when missing or invalid. */
export function parseJsonBody(event: Pick<APIGatewayProxyEventV2, 'body' | 'isBase64Encoded'>): unknown {
  const raw = rawBody(event);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/** Constant-time comparison of two secrets (hashes first so lengths never leak). */
export function constantTimeEqual(a: string | undefined, b: string | undefined): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

export function corsHeaders(origin: string): Record<string, string> {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET,PUT,POST,DELETE,OPTIONS',
    vary: 'Origin',
  };
}
