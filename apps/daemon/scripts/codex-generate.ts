import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { AgentTool, CODEX_VERIFIED_ON, ensureAgent } from '../src/environment';
import { importClosure } from './codex-closure';
import { sampleInstances } from './codex-samples';
import { formatStamp, GENERATED_DIR, hashTree, STAMP_FILE } from './codex-stamp';

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

/**
 * The generated JSON schema of each type a runtime schema in `codex-protocol.ts` reads. Each is
 * copied to `schema/<Type>.json` and sampled into `fixtures/<Type>.json`, which
 * `codex-protocol.test.ts` reads.
 */
const RUNTIME_SCHEMAS = [
  'v1/InitializeResponse',
  'v2/GetAccountResponse',
  'v2/GetAccountRateLimitsResponse',
  'v2/AccountRateLimitsUpdatedNotification',
  'v2/ModelListResponse',
  'v2/ConfigReadResponse',
  'v2/HooksListResponse',
  'v2/ThreadStartResponse',
  'v2/ThreadResumeResponse',
  'v2/TurnStartResponse',
  'v2/TurnStartedNotification',
  'v2/TurnCompletedNotification',
  'v2/ThreadTokenUsageUpdatedNotification',
  'v2/ItemCompletedNotification',
  'v2/ThreadTurnsListResponse',
  'v2/ItemStartedNotification',
  'v2/AgentMessageDeltaNotification',
  'v2/ReasoningSummaryTextDeltaNotification',
  'v2/CommandExecutionOutputDeltaNotification',
  'v2/TurnPlanUpdatedNotification',
] as const;

/** The pre-commit hygiene check refuses a file over 1 MB. */
const MAX_FILE_BYTES = 1024 * 1024;

class GeneratedFileTooLargeError extends Error {
  override readonly name = 'GeneratedFileTooLargeError';
}

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

  // Every file is built before any is written, so a refusal leaves the folder as it was.
  const written = new Map<string, Buffer>();
  for (const type of RUNTIME_SCHEMAS) {
    const name = `${basename(type)}.json`;
    const schema = readFileSync(join(work, 'schema', `${type}.json`));
    written.set(`schema/${name}`, schema);
    // Codex's own output, read as JSON; sampleInstances parses each node it walks.
    const document: unknown = JSON.parse(schema.toString('utf8'));
    const fixtures = `${JSON.stringify(sampleInstances(document), null, 2)}\n`;
    written.set(`fixtures/${name}`, Buffer.from(fixtures));
  }
  const tooLarge = [...written]
    .filter(([, bytes]) => bytes.length > MAX_FILE_BYTES)
    .map(([path, bytes]) => `${path} (${String(bytes.length)} bytes)`);
  if (tooLarge.length > 0)
    throw new GeneratedFileTooLargeError(
      `Over the 1 MB a commit allows, so nothing was written: ${tooLarge.join(', ')}`,
    );

  const kept = importClosure(
    (path) => readFileSync(join(generatedTs, path), 'utf8'),
    CODEX_SEED_TYPES.map((type) => `${type}.ts`),
  );
  for (const path of kept) written.set(`ts/${path}`, readFileSync(join(generatedTs, path)));

  // The folder holds only what is written here, so a stray file (a Finder .DS_Store) is never
  // stamped, and the STAMP hashes exactly these files.
  rmSync(GENERATED_DIR, { recursive: true, force: true });
  for (const [path, bytes] of written) {
    const target = join(GENERATED_DIR, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
  writeFileSync(
    join(GENERATED_DIR, STAMP_FILE),
    formatStamp({ version: CODEX_VERIFIED_ON, sha256: hashTree(written) }),
  );
  console.log(
    `Wrote ${String(written.size)} generated files from Codex ${CODEX_VERIFIED_ON} to ${GENERATED_DIR}.`,
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
