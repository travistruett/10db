import { FlowDto, type FlowId } from '@10db/contracts';
import { z } from 'zod';

/** A typed fetch wrapper for tests: parses every response with the schema given and throws on a status of 400 or more. */
export function apiClient(url: string, token: string) {
  async function call<S extends z.ZodType>(
    method: string,
    path: string,
    schema: S,
    body?: unknown,
  ): Promise<z.output<S>> {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    if (res.status >= 400) throw new Error(`${method} ${path} -> ${String(res.status)}: ${text}`);
    return schema.parse(JSON.parse(text));
  }
  return {
    get: <S extends z.ZodType>(path: string, schema: S) => call('GET', path, schema),
    post: <S extends z.ZodType>(path: string, schema: S, body?: unknown) =>
      call('POST', path, schema, body ?? {}),
    put: <S extends z.ZodType>(path: string, schema: S, body?: unknown) =>
      call('PUT', path, schema, body ?? {}),
    patch: <S extends z.ZodType>(path: string, schema: S, body?: unknown) =>
      call('PATCH', path, schema, body ?? {}),
  };
}

/** The seeded `quick` flow (implement only), for tests whose scripts run one implement session per task. */
export async function quickFlowId(api: ReturnType<typeof apiClient>): Promise<FlowId> {
  const quick = (await api.get('/flows', z.array(FlowDto))).find((f) => f.name === 'quick');
  if (!quick) throw new Error('the quick flow was not seeded');
  return quick.id;
}
