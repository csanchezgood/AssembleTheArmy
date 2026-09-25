// Structured JSON logging. Level from LOG_LEVEL (debug|info|warn|error). Values whose key looks
// like a secret/token are redacted so credentials never reach CloudWatch.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SENSITIVE_KEY = /(secret|token|authorization|password|client_secret|clientsecret|cookie|signature)/i;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

function currentLevel(): number {
  const raw = (process.env['LOG_LEVEL'] ?? 'info').toLowerCase() as LogLevel;
  return LEVELS[raw] ?? LEVELS.info;
}

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  child(context: Record<string, unknown>): Logger;
}

export function createLogger(context: Record<string, unknown> = {}): Logger {
  const emit = (level: LogLevel, msg: string, data?: Record<string, unknown>): void => {
    if (LEVELS[level] < currentLevel()) return;
    const line = JSON.stringify({ level, msg, ts: new Date().toISOString(), ...redact(context) as object, ...(data ? (redact(data) as object) : {}) });
    if (level === 'error') process.stderr.write(line + '\n');
    else process.stdout.write(line + '\n');
  };
  return {
    debug: (m, d) => emit('debug', m, d),
    info: (m, d) => emit('info', m, d),
    warn: (m, d) => emit('warn', m, d),
    error: (m, d) => emit('error', m, d),
    child: (extra) => createLogger({ ...context, ...extra }),
  };
}

export const logger: Logger = createLogger();
