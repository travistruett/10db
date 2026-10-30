// The builder's MCP bridge, run by a client over stdio (see docs/builder-mcp.md). Stdout carries
// the protocol's JSON-RPC and nothing else: a diagnostic goes to stderr, never to stdout.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createBuilderBridge } from './builder-bridge';
import { EnvError, loadDataDirEnv } from './env';
import { defaultDataDir } from './runtime-files';

/** A call that gets no answer in this long fails; a task start can take a few seconds. */
const CALL_TIMEOUT_MS = 60_000;

let dataDir: string;
try {
  // Only the data dir is read: a client passes its own environment, and a stray daemon variable
  // in it must not stop the bridge from starting.
  dataDir = loadDataDirEnv(process.env) ?? defaultDataDir();
} catch (error) {
  console.error(error instanceof EnvError ? error.message : '10db builder bridge: bad environment');
  process.exit(1);
}

const bridge = createBuilderBridge({ dataDir, timeoutMs: CALL_TIMEOUT_MS });
// The client closing our stdin is how a session ends.
process.stdin.on('close', () => {
  process.exit(0);
});
await bridge.connect(new StdioServerTransport());
console.error(`10db builder bridge ready (data dir ${dataDir})`);
