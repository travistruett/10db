import { FUNNEL_PORTS } from '@10db/contracts';
import { z } from 'zod';

const Handler = z.object({
  Proxy: z.string().nullish(),
  Path: z.string().nullish(),
  Text: z.string().nullish(),
  Redirect: z.string().nullish(),
});

/** The parts of `tailscale serve status --json` 10db reads; every other field is dropped. */
export const ServeStatus = z.object({
  TCP: z.record(z.string(), z.record(z.string(), z.unknown())).nullish(),
  Web: z
    .record(z.string(), z.object({ Handlers: z.record(z.string(), Handler).nullish() }))
    .nullish(),
  AllowFunnel: z.record(z.string(), z.boolean()).nullish(),
});
export type ServeStatus = z.infer<typeof ServeStatus>;

export type MappingProblem =
  | { readonly kind: 'funnel' }
  | { readonly kind: 'tcp' }
  | { readonly kind: 'elsewhere'; readonly target: string };

/** The one handler 10db makes: `/` proxied to the loopback port. */
function hasOnlyLoopbackHandler(
  handlers: Record<string, z.infer<typeof Handler>> | null | undefined,
  port: number,
): boolean {
  const entries = Object.entries(handlers ?? {});
  const only = entries[0];
  return (
    entries.length === 1 &&
    only?.[0] === '/' &&
    only[1].Proxy === `http://127.0.0.1:${String(port)}`
  );
}

/** A port's `TCP` entry is HTTPS termination and nothing else, which is what `serve --https` writes. */
function isPlainHttps(serve: ServeStatus, port: number): boolean {
  const entry = serve.TCP?.[String(port)];
  if (entry === undefined) return false;
  const keys = Object.keys(entry);
  return keys.length === 1 && keys[0] === 'HTTPS' && entry['HTTPS'] === true;
}

/** True only for the mapping 10db makes: `<fqdn>:<port>` to `http://127.0.0.1:<port>`, with no Funnel. */
export function isTendbMapping(serve: ServeStatus, fqdn: string, port: number): boolean {
  const key = `${fqdn}:${String(port)}`;
  return (
    hasOnlyLoopbackHandler(serve.Web?.[key]?.Handlers, port) &&
    isPlainHttps(serve, port) &&
    serve.AllowFunnel?.[key] !== true
  );
}

/** Used only to remove 10db's mapping while the name is unknown: any name on the port, same handler. */
export function loopbackMappingOn(serve: ServeStatus, port: number): boolean {
  return Object.entries(serve.Web ?? {}).some(
    ([key, web]) => key.endsWith(`:${String(port)}`) && hasOnlyLoopbackHandler(web.Handlers, port),
  );
}

function targetOf(handlers: Record<string, z.infer<typeof Handler>> | null | undefined): string {
  const targets = Object.values(handlers ?? {}).map(
    (handler) =>
      handler.Proxy ?? handler.Path ?? handler.Redirect ?? (handler.Text ? 'a text response' : '?'),
  );
  return targets.length === 0 ? 'nothing' : targets.join(', ');
}

/** Why 10db must not share on the port: Funnel first, then a TCP forward, then another mapping. */
export function mappingProblem(
  serve: ServeStatus,
  fqdn: string,
  port: number,
): MappingProblem | null {
  const key = `${fqdn}:${String(port)}`;
  if (serve.AllowFunnel?.[key] === true) return { kind: 'funnel' };
  if (serve.TCP?.[String(port)] !== undefined && !isPlainHttps(serve, port)) return { kind: 'tcp' };
  const web = serve.Web?.[key];
  if (web !== undefined && !hasOnlyLoopbackHandler(web.Handlers, port)) {
    return { kind: 'elsewhere', target: targetOf(web.Handlers) };
  }
  return null;
}

/** The sentence the builder reads for a mapping problem on `<fqdn>:<port>`. */
export function describeProblem(problem: MappingProblem, fqdn: string, port: number): string {
  switch (problem.kind) {
    case 'funnel':
      return `Tailscale Funnel is on for ${fqdn}:${String(port)}, which would put 10db on the public internet. Turn Funnel off first.`;
    case 'tcp':
      return `Port ${String(port)} already has a TCP forward in Tailscale serve. Pick another port or remove it.`;
    case 'elsewhere':
      return `Port ${String(port)} already maps to ${problem.target} in Tailscale serve. Pick another port or remove it.`;
  }
}

/** A sentence saying why Share refuses the port, or null. */
export function shareRefusal(port: number, mainPort: number): string | null {
  if (FUNNEL_PORTS.some((funnel) => funnel === port)) {
    return `Port ${String(port)} is one of Tailscale Funnel's ports (443 also holds your own serve config). Pick another.`;
  }
  if (port < 1024)
    return `Port ${String(port)} is below 1024, which needs administrator rights. Pick another.`;
  if (port === mainPort)
    return `Port ${String(port)} is the one 10db itself runs on. Pick another.`;
  return null;
}

export function serveArgs(port: number): readonly string[] {
  return ['serve', '--bg', `--https=${String(port)}`, `http://127.0.0.1:${String(port)}`];
}

export function unserveArgs(port: number): readonly string[] {
  return ['serve', `--https=${String(port)}`, 'off'];
}
