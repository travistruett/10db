import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HealthResponse, PROTOCOL_VERSION, renderJsonSchemas } from './index';

describe('HealthResponse', () => {
  it('accepts a well-formed health payload', () => {
    const payload = {
      status: 'ok',
      protocolVersion: PROTOCOL_VERSION,
      startedAt: '2026-10-13T12:00:00.000Z',
    };
    expect(HealthResponse.parse(payload)).toEqual(payload);
  });

  it.each([
    [
      'wrong status',
      { status: 'degraded', protocolVersion: 1, startedAt: '2026-10-13T12:00:00.000Z' },
    ],
    [
      'non-integer protocol',
      { status: 'ok', protocolVersion: 1.5, startedAt: '2026-10-13T12:00:00.000Z' },
    ],
    ['non-ISO start time', { status: 'ok', protocolVersion: 1, startedAt: 'yesterday' }],
  ])('rejects %s', (_name, payload) => {
    expect(HealthResponse.safeParse(payload).success).toBe(false);
  });
});

describe('generated JSON Schema', () => {
  it('matches the committed files byte for byte', () => {
    for (const [file, text] of renderJsonSchemas()) {
      const committed = readFileSync(resolve(import.meta.dirname, '../generated', file), 'utf8');
      expect(committed, `${file} is stale; run pnpm --filter @10db/contracts generate`).toBe(text);
    }
  });
});
