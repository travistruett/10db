import { z } from 'zod';
import { HealthResponse } from './health';

/** Every schema visible outside the daemon, keyed by the file stem of its generated JSON Schema. */
export const CONTRACT_SCHEMAS = {
  'health-response': HealthResponse,
} as const satisfies Record<string, z.ZodType>;

/** Renders each registered schema as JSON Schema text, keyed by file name. */
export function renderJsonSchemas(): Map<string, string> {
  return new Map(
    Object.entries(CONTRACT_SCHEMAS).map(([stem, schema]) => [
      `${stem}.schema.json`,
      `${JSON.stringify(z.toJSONSchema(schema, { target: 'draft-2020-12' }), null, 2)}\n`,
    ]),
  );
}
