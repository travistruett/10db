import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { AgentTool, CODEX_VERIFIED_ON, ensureAgent } from '../src/environment';
import { importClosure } from './codex-closure';
import { formatStamp, GENERATED_DIR, hashTree, readTree, STAMP_FILE } from './codex-stamp';

// Writes `src/sessions/codex-generated/` from the pinned Codex: the generated protocol types 10db
// reads, and a STAMP the gate's drift step checks. Run on a Mac with the network:
// `pnpm --filter @10db/daemon generate:codex`.

/**
 * The generated types 10db keeps, with every file they import: the three root unions, which reach
 * every request and notification, and the responses 10db reads, which no root reaches.
 */
const CODEX_SEED_TYPES = [
  'ClientRequest',
  'ServerRequest',
  'ServerNotification',
  'InitializeResponse',
  'v2/GetAccountResponse',
  'v2/GetAccountRateLimitsResponse',
  'v2/LoginAccountResponse',
  'v2/CancelLoginAccountResponse',
  'v2/ModelListResponse',
  'v2/ConfigReadResponse',
  'v2/HooksListResponse',
  'v2/ThreadStartResponse',
  'v2/ThreadResumeResponse',
  'v2/ThreadTurnsListResponse',
  'v2/TurnStartResponse',
  'v2/TurnSteerResponse',
  'v2/TurnInterruptResponse',
] as const;

const run = promisify(execFile);

if (process.platform !== 'darwin') {
  console.error(
    `generate:codex runs only on a Mac: the pinned Codex ${CODEX_VERIFIED_ON} is the darwin-arm64 build.`,
  );
  process.exit(1);
}

const codex = await ensureAgent(AgentTool.Codex);
const work = mkdtempSync(join(tmpdir(), '10db-codex-generate-'));
try {
  const home = join(work, 'home');
  mkdirSync(home);
  // The generator never sees the builder's Codex home or PATH.
  const env = { PATH: '/usr/bin:/bin', HOME: work, CODEX_HOME: home };
  const generatedTs = join(work, 'ts');
  await run(codex, ['app-server', 'generate-ts', '--out', generatedTs], { cwd: work, env });
  await run(codex, ['app-server', 'generate-json-schema', '--out', join(work, 'schema')], {
    cwd: work,
    env,
  });

  const kept = importClosure(
    (path) => readFileSync(join(generatedTs, path), 'utf8'),
    CODEX_SEED_TYPES.map((type) => `${type}.ts`),
  );
  const outTs = join(GENERATED_DIR, 'ts');
  rmSync(outTs, { recursive: true, force: true });
  for (const path of kept) {
    const target = join(outTs, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(join(generatedTs, path)));
  }

  writeFileSync(
    join(GENERATED_DIR, STAMP_FILE),
    formatStamp({ version: CODEX_VERIFIED_ON, sha256: hashTree(readTree(GENERATED_DIR)) }),
  );
  console.log(
    `Wrote ${String(kept.length)} generated files from Codex ${CODEX_VERIFIED_ON} to ${GENERATED_DIR}.`,
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
