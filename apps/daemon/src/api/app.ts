import { HealthResponse, PROTOCOL_VERSION } from '@10db/contracts';
import { Hono } from 'hono';
import { cors } from 'hono/cors';

export interface ApiDeps {
  readonly startedAt: Date;
  /** Origins the UI is served from (Vite dev server, Tauri webview). */
  readonly allowedOrigins: readonly string[];
}

export function createApp(deps: ApiDeps) {
  return new Hono()
    .use('*', cors({ origin: (origin) => (deps.allowedOrigins.includes(origin) ? origin : null) }))
    .get('/health', (c) =>
      c.json(
        HealthResponse.parse({
          status: 'ok',
          protocolVersion: PROTOCOL_VERSION,
          startedAt: deps.startedAt.toISOString(),
        }),
      ),
    );
}

export type AppType = ReturnType<typeof createApp>;
