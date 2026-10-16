import { HealthResponse, PROTOCOL_VERSION } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { createApp } from './app';

const startedAt = new Date('2026-10-13T12:00:00.000Z');
const app = createApp({ startedAt, allowedOrigins: ['http://localhost:1420'] });

describe('GET /health', () => {
  it('reports ok with the protocol version', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(HealthResponse.parse(await res.json())).toEqual({
      status: 'ok',
      protocolVersion: PROTOCOL_VERSION,
      startedAt: startedAt.toISOString(),
    });
  });

  it('allows the UI origin', async () => {
    const res = await app.request('/health', { headers: { Origin: 'http://localhost:1420' } });
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:1420');
  });

  it('does not allow other origins', async () => {
    const res = await app.request('/health', { headers: { Origin: 'https://evil.example' } });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});
