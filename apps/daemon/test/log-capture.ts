import { z } from 'zod';
import { createLogger, type Logger } from '../src/log';

/** One daemon.log line: pino's JSON object, its fields by name. */
const LogLine = z.record(z.string(), z.unknown());
export type LogLine = z.infer<typeof LogLine>;

export interface LogCapture {
  readonly logger: Logger;
  /** Every line logged so far, oldest first. */
  lines(): LogLine[];
}

/** A logger at info level that keeps its lines in memory, so a test reads what daemon.log would say. */
export function captureLogs(): LogCapture {
  const written: string[] = [];
  const logger = createLogger({
    level: 'info',
    destination: {
      write: (line: string) => {
        written.push(line);
      },
    },
  });
  return {
    logger,
    lines: () =>
      written.filter((line) => line.trim() !== '').map((line) => LogLine.parse(JSON.parse(line))),
  };
}
