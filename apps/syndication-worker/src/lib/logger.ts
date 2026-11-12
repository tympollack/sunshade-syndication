export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  service: string;
  message: string;
  requestId?: string;
  meta?: Record<string, unknown>;
}

const SENSITIVE_KEY_PATTERN = /token|secret|password|authorization|signature|key/i;

/**
 * Recursively redacts sensitive values matching token/secret/password/key/signature.
 */
export function redactSensitiveData(input: unknown): unknown {
  if (input === null || input === undefined) {
    return input;
  }

  if (typeof input === 'string') {
    return input;
  }

  if (Array.isArray(input)) {
    return input.map((item) => redactSensitiveData(item));
  }

  if (typeof input === 'object') {
    const scrubbed: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        scrubbed[key] = '[REDACTED]';
      } else {
        scrubbed[key] = redactSensitiveData(value);
      }
    }
    return scrubbed;
  }

  return input;
}

export class Logger {
  private readonly service: string;
  private readonly requestId?: string;

  constructor(options: { service?: string; requestId?: string } = {}) {
    this.service = options.service ?? 'sunshade-syndication';
    this.requestId = options.requestId;
  }

  private emit(level: LogLevel, message: string, meta?: Record<string, unknown>): LogEntry {
    const scrubbedMeta = meta ? (redactSensitiveData(meta) as Record<string, unknown>) : undefined;
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      service: this.service,
      message,
      ...(this.requestId ? { requestId: this.requestId } : {}),
      ...(scrubbedMeta && Object.keys(scrubbedMeta).length > 0 ? { meta: scrubbedMeta } : {}),
    };

    const serialized = JSON.stringify(entry);
    if (level === 'error') {
      console.error(serialized);
    } else if (level === 'warn') {
      console.warn(serialized);
    } else {
      console.log(serialized);
    }

    return entry;
  }

  debug(message: string, meta?: Record<string, unknown>): LogEntry {
    return this.emit('debug', message, meta);
  }

  info(message: string, meta?: Record<string, unknown>): LogEntry {
    return this.emit('info', message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): LogEntry {
    return this.emit('warn', message, meta);
  }

  error(message: string, meta?: Record<string, unknown>): LogEntry {
    return this.emit('error', message, meta);
  }
}

export const logger = new Logger();
