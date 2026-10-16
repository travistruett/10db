// Spike 4: a per-session HTTP MCP config can carry an Authorization header, and the daemon-side server sees it
// on the tool call. 10db uses this to attribute every MCP call to the session that made it.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { buildChildEnv } from './env.ts';
import { makeFixtureRepo } from './fixture-repo.ts';
import { check, finish, info } from './report.ts';
import { baseOptions, openConversation, resultText } from './session.ts';

const token = randomUUID();
const seen: { method: string; path: string; auth: string | null; rpc: string }[] = [];

function toWebRequest(req: IncomingMessage, body: Buffer): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') headers.set(k, v);
    else if (Array.isArray(v)) headers.set(k, v.join(', '));
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  // A Uint8Array copy: the DOM types reject a Node Buffer as a request body.
  return new Request(`http://127.0.0.1${req.url ?? '/'}`, { method: req.method ?? 'GET', headers, ...(hasBody ? { body: new Uint8Array(body) } : {}) });
}

const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks);
  const auth = req.headers.authorization ?? null;
  let rpc = '';
  try {
    rpc = String((JSON.parse(body.toString('utf8') || '{}') as { method?: string }).method ?? '');
  } catch {
    rpc = 'unparsed';
  }
  seen.push({ method: req.method ?? '', path: req.url ?? '', auth: auth === `Bearer ${token}` ? 'match' : auth === null ? null : 'mismatch', rpc });

  const mcp = new McpServer({ name: '10db-spike', version: '0.0.0' });
  mcp.registerTool('whoami', { description: 'Returns whether this call carried the expected session token.' }, async () => ({
    content: [{ type: 'text', text: `WHOAMI-OK auth=${auth === `Bearer ${token}` ? 'match' : 'mismatch'}` }],
  }));
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await mcp.connect(transport);
  const response = await transport.handleRequest(toWebRequest(req, body));
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as AddressInfo).port;

// The server name is the one M1b uses, so the tool name matches M1a's `mcp__10db__*` allow rule.
async function probe(alwaysLoad: boolean) {
  seen.length = 0;
  const convo = openConversation(
    baseOptions(makeFixtureRepo(), {
      mcpServers: { '10db': { type: 'http', url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: `Bearer ${token}` }, timeout: 30_000, alwaysLoad } },
      allowedTools: ['mcp__10db__whoami'],
      maxTurns: 3,
    }),
  );
  const turn = await convo.send('Call the mcp__10db__whoami tool exactly once, then reply with exactly the text it returned.');
  // HTTP MCP startup does not block by default, so init can say "pending"; ask again after the turn.
  const statusAfter = await convo.q.mcpServerStatus().catch(() => []);
  const run = await convo.close();
  return { run, turn, statusAfter, requests: [...seen] };
}

/**
 * M1b passes a repo's .mcp.json servers through `mcpServers` and gives them no allow rule (decisions 39 and 51),
 * so every call to their tools must reach canUseTool. `repohttp` is this HTTP server under another path, and
 * `repostdio` is a local stdio server. Both load eagerly, so tool search can't hide them from a small model.
 */
type StdioHit = { event: 'start' | 'call'; path?: boolean; marker?: string | null; sentinel?: string | null; envKeys?: string[]; text?: string };
const STDIO_SERVER = join(import.meta.dirname, '04-stdio-server.ts');
const hitsDir = mkdtempSync(join(tmpdir(), 'tendb-spike-stdio-'));
const stdioHits = join(hitsDir, 'hits.log');
/** The same server launched the way M1b launches an approved repo stdio server (decision 52). */
const wrappedHits = join(hitsDir, 'wrapped.log');
/** A repo server whose name starts with `10db__`, to see whether `mcp__10db__*` matches its tools. */
const prefixHits = join(hitsDir, 'prefix.log');
/** Only in the query's `env`: if a stdio server sees it, a declared `env` merges with the session's. */
const SENTINEL = 'from-session-env';
const readHits = (file: string): StdioHit[] => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as StdioHit) : []);

async function probeRepoServers() {
  seen.length = 0;
  const asked: { tool: string; server: string | null; source: string | null }[] = [];
  const canUseTool: CanUseTool = async (toolName, input, options) => {
    asked.push({ tool: toolName, server: options.mcpServer?.name ?? null, source: options.mcpServer?.source ?? null });
    // Allow the HTTP tool and deny the stdio ones, so the probe also shows that a deny keeps the call off the server.
    if (toolName === 'mcp__repostdio__echo' || toolName === 'mcp__10db__x__echo') return { behavior: 'deny', message: 'Denied by the 10db spike. Do not retry it.' };
    return { behavior: 'allow', updatedInput: input };
  };
  const convo = openConversation(
    baseOptions(makeFixtureRepo(), {
      mcpServers: {
        '10db': { type: 'http', url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: `Bearer ${token}` }, timeout: 30_000, alwaysLoad: true },
        repohttp: { type: 'http', url: `http://127.0.0.1:${port}/repo`, alwaysLoad: true },
        repostdio: { type: 'stdio', command: process.execPath, args: [STDIO_SERVER, stdioHits], env: { SPIKE_MARKER: 'from-config' }, alwaysLoad: true },
        repowrapped: {
          type: 'stdio',
          command: '/usr/bin/env',
          args: ['-i', `PATH=${process.env['PATH'] ?? ''}`, `HOME=${homedir()}`, process.execPath, STDIO_SERVER, wrappedHits],
          alwaysLoad: true,
        },
        '10db__x': { type: 'stdio', command: process.execPath, args: [STDIO_SERVER, prefixHits], alwaysLoad: true },
      },
      env: { ...buildChildEnv(), SPIKE_SESSION_SENTINEL: SENTINEL },
      // M1b's allow rule for its own server, so the probe shows whether it also covers `10db__x`.
      allowedTools: ['mcp__10db__*'],
      canUseTool,
      permissionMode: 'default',
      maxTurns: 6,
    }),
  );
  const turn = await convo.send(
    'Call these four tools once each, in this order: mcp__10db__whoami, mcp__repohttp__whoami, ' +
      'mcp__repostdio__echo with the text PING, then mcp__10db__x__echo with the text PONG. If a call is denied, ' +
      'do not retry it. Then reply DONE.',
  );
  const run = await convo.close();
  return { run, turn, asked, hits: readHits(stdioHits), wrapped: readHits(wrappedHits), prefix: readHits(prefixHits), requests: [...seen] };
}

const loaded = await probe(true);
const deferred = await probe(false);
const repo = await probeRepoServers();
server.close();

info('requests seen by server (alwaysLoad)', loaded.requests);
info('init mcp_servers (alwaysLoad)', loaded.run.init?.mcp_servers ?? null);
info('mcpServerStatus after the turn (alwaysLoad)', loaded.statusAfter);
const statusAtInit = loaded.run.init?.mcp_servers.find((s) => s.name === '10db')?.status;
const statusLater = loaded.statusAfter.find((s) => s.name === '10db')?.status;
info('status at init vs after the turn', { atInit: statusAtInit ?? null, after: statusLater ?? null });
check('server connected (at init or after the turn)', statusAtInit === 'connected' || statusLater === 'connected', `${String(statusAtInit)} / ${String(statusLater)}`);
const calls = loaded.requests.filter((s) => s.rpc === 'tools/call');
check('tool was called', calls.length >= 1, `${calls.length} tools/call request(s)`);
check('every request carried the session token', loaded.requests.length > 0 && loaded.requests.every((s) => s.auth === 'match'), JSON.stringify(loaded.requests.map((s) => s.auth)));
check('agent relayed the tool result', /WHOAMI-OK auth=match/.test(resultText(loaded.turn)), resultText(loaded.turn).slice(0, 80));
const deferredCalled = deferred.requests.some((s) => s.rpc === 'tools/call');
info('without alwaysLoad: tool called', { called: deferredCalled, atInit: deferred.run.init?.mcp_servers.find((s) => s.name === '10db')?.status ?? null, answer: resultText(deferred.turn).slice(0, 80) });
console.log(`ALWAYS_LOAD_NEEDED=${deferredCalled ? 'no' : 'yes'}`);

info('pass-through: init mcp_servers', repo.run.init?.mcp_servers ?? null);
info('pass-through: canUseTool calls (tool, mcpServer.name, mcpServer.source)', repo.asked);
info('pass-through: stdio server log', repo.hits);
const askedTools = repo.asked.map((a) => a.tool);
check('canUseTool saw the passed-through HTTP tool', askedTools.includes('mcp__repohttp__whoami'), askedTools.join(',') || 'no calls');
check('canUseTool saw the passed-through stdio tool', askedTools.includes('mcp__repostdio__echo'), askedTools.join(',') || 'no calls');
const repoCalls = repo.requests.filter((s) => s.path === '/repo' && s.rpc === 'tools/call');
check('the allowed HTTP tool ran after canUseTool allowed it', repoCalls.length >= 1, `${repoCalls.length} tools/call on /repo`);
const stdioStart = repo.hits.find((h) => h.event === 'start');
check('the stdio server started from the passed-through config', stdioStart !== undefined, JSON.stringify(stdioStart ?? null));
check('the denied stdio tool never reached its server', !repo.hits.some((h) => h.event === 'call'), `${repo.hits.filter((h) => h.event === 'call').length} call(s)`);
info('the allow-listed 10db tool skipped canUseTool', !askedTools.includes('mcp__10db__whoami'));
console.log(`STDIO_ENV_KEEPS_PATH=${stdioStart?.path ? 'yes' : 'no'}`);

// Decision 52: does a declared env merge with the session env, and does `env -i` leave only what 10db names?
info('stdio env keys with a declared env', stdioStart?.envKeys ?? null);
console.log(`STDIO_ENV_INHERITS_SESSION=${stdioStart?.sentinel === SENTINEL ? 'yes' : 'no'}`);
const wrappedStart = repo.wrapped.find((h) => h.event === 'start');
const wrappedKeys = wrappedStart?.envKeys ?? [];
info('stdio env keys under env -i', wrappedKeys);
check('the env -i server started', wrappedStart !== undefined, JSON.stringify(wrappedStart ?? null));
check('the env -i server saw no session variable', wrappedStart?.sentinel === null, String(wrappedStart?.sentinel));
// macOS CoreFoundation sets __CF_USER_TEXT_ENCODING inside every process it starts in; it is not a session variable.
const OS_ADDED = ['__CF_USER_TEXT_ENCODING'];
check('the env -i server saw only PATH and HOME (plus OS-added keys)', wrappedKeys.filter((k) => !OS_ADDED.includes(k)).join() === 'HOME,PATH', wrappedKeys.join(',') || 'none');
console.log(`STDIO_ENV_I_KEYS=${wrappedKeys.join(',') || 'none'}`);

// The `mcp__10db__*` rule and a repo server named `10db__x`. M1b drops such names, so this is a record only.
const prefixRan = repo.prefix.some((h) => h.event === 'call');
info('mcp__10db__x__echo: asked, ran', { asked: askedTools.includes('mcp__10db__x__echo'), ran: prefixRan });
console.log(`TENDB_RULE_MATCHES_10DB__X=${prefixRan && !askedTools.includes('mcp__10db__x__echo') ? 'yes' : 'no'}`);
finish();
