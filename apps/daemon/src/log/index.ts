import pino, { type DestinationStream } from 'pino';
import type { LogLevel } from '../env';

type LogFn = (obj: object, msg?: string) => void;

export interface Logger {
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  child(bindings: Record<string, string>): Logger;
}

const REDACT_PATHS = [
  'token',
  '*.token',
  '*.*.token',
  'authorization',
  '*.authorization',
  '*.*.authorization',
  'mcpToken',
  '*.mcpToken',
];

export function createLogger(options: {
  readonly level: LogLevel;
  readonly destination?: DestinationStream;
}): Logger {
  return pino(
    {
      level: options.level,
      redact: { paths: REDACT_PATHS, censor: '[redacted]' },
      base: { pid: process.pid },
    },
    options.destination,
  );
}
