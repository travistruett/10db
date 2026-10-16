// Spike 6: three ways to wait for a human on AskUserQuestion.
//   deny-interrupt: deny with interrupt:true, let the session end, resume later with the answer as a prompt.
//   abort:          abort the query via AbortController, then resume the same way.
//   hold:           keep the canUseTool promise pending for HOLD_MS (the spec's 10-minute wait), then answer.
// The content canary TANGERINE appears only in the original task, so only a resume that really reloaded the
// transcript can write it. Orphans are checked by the captured claude pid and its process group, not by
// direct children (grandchildren reparent to launchd).
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { CanUseTool, Options } from '@anthropic-ai/claude-agent-sdk';
import { makeFixtureRepo } from './fixture-repo.ts';
import { check, finish, info, partial } from './report.ts';
import { baseOptions, PROBE_TIMEOUT_MS, runOnce } from './session.ts';

const HOLD_MS = Number(process.env['HOLD_MS'] ?? 600_000);
const RESUME_GAP_MS = Number(process.env['RESUME_GAP_MS'] ?? 3_000);
const MODEL = process.env['SPIKE_MODEL'] ?? 'haiku';
const TASK =
  'Use the AskUserQuestion tool to ask me ONE question with two options: name the new file alpha.txt or ' +
  'beta.txt. Then create the chosen file with the Write tool; its entire content must be the word TANGERINE. ' +
  'Then reply DONE.';
type Question = { question: string; options: { label: string }[] };

const allowAll: CanUseTool = async (_tool, input) => ({ behavior: 'allow', updatedInput: input });

/** Spawns claude in its own process group and records the pid, so orphans can be checked precisely. */
function trackedSpawn(pids: number[]): NonNullable<Options['spawnClaudeCodeProcess']> {
  return (o) => {
    const child = spawn(o.command, o.args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    if (child.pid !== undefined) pids.push(child.pid);
    o.signal.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });
    return child;
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function groupMembers(pgid: number): string[] {
  try {
    return execFileSync('pgrep', ['-g', String(pgid)], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function transcriptExists(sessionId: string): boolean {
  const root = join(homedir(), '.claude', 'projects');
  return existsSync(root) && readdirSync(root).some((dir) => existsSync(join(root, dir, `${sessionId}.jsonl`)));
}

const content = (repo: string, file: string): string => (existsSync(join(repo, file)) ? readFileSync(join(repo, file), 'utf8').trim() : '');

async function parkThenResume(variant: 'deny-interrupt' | 'abort'): Promise<void> {
  const repo = makeFixtureRepo();
  const controller = new AbortController();
  const pids: number[] = [];
  let question = '';
  const park: CanUseTool = async (tool, input) => {
    if (tool !== 'AskUserQuestion') return { behavior: 'allow', updatedInput: input };
    question = (input['questions'] as Question[])[0]?.question ?? '';
    if (variant === 'abort') controller.abort();
    return { behavior: 'deny', message: 'PARKED: a human will answer later. Stop now and wait.', interrupt: true };
  };
  const first = await runOnce(TASK, baseOptions(repo, { model: MODEL, canUseTool: park, abortController: controller, maxTurns: 6, spawnClaudeCodeProcess: trackedSpawn(pids) }));
  const sessionId = first.init?.session_id ?? '';
  info(`${variant}: first run ended`, { result: first.result?.subtype ?? null, error: String(first.error ?? 'none'), sessionId, pids });
  await sleep(3000);
  const survivors = pids.filter(alive);
  const group = pids.flatMap(groupMembers);
  check(`${variant}: claude pid gone 3s after the query ended`, pids.length > 0 && survivors.length === 0, JSON.stringify({ pids, survivors }));
  check(`${variant}: no process left in claude's group`, group.length === 0, JSON.stringify(group));
  check(`${variant}: transcript is on disk`, sessionId !== '' && transcriptExists(sessionId), sessionId);

  await sleep(RESUME_GAP_MS);
  const resumed = await runOnce(
    `The human has answered your earlier question ("${question}"): beta.txt. Continue the task.`,
    baseOptions(repo, { model: MODEL, resume: sessionId, canUseTool: allowAll, maxTurns: 6 }),
  );
  info(`${variant}: resumed session id`, { original: sessionId, resumed: resumed.init?.session_id ?? null, gapMs: RESUME_GAP_MS });
  check(`${variant}: resumed run completed the task from the transcript`, content(repo, 'beta.txt') === 'TANGERINE', `beta.txt = ${JSON.stringify(content(repo, 'beta.txt'))}`);
}

await parkThenResume('deny-interrupt');
await parkThenResume('abort');

{
  const repo = makeFixtureRepo();
  let heldMs = 0;
  let abortedDuringHold = false;
  const hold: CanUseTool = async (tool, input, { signal }) => {
    if (tool !== 'AskUserQuestion') return { behavior: 'allow', updatedInput: input };
    const q = (input['questions'] as Question[])[0];
    const t0 = Date.now();
    await sleep(HOLD_MS);
    heldMs = Date.now() - t0;
    abortedDuringHold = signal.aborted;
    const pick = q?.options.find((o) => /beta/i.test(o.label))?.label ?? 'beta.txt';
    return { behavior: 'allow', updatedInput: { ...input, answers: { [q?.question ?? '']: pick } } };
  };
  // The hold outlasts the default probe timeout, so this run gets its own.
  const run = await runOnce(TASK, baseOptions(repo, { model: MODEL, canUseTool: hold, maxTurns: 6 }, HOLD_MS + PROBE_TIMEOUT_MS));
  info('hold: outcome', { heldMs, abortedDuringHold, result: run.result?.subtype ?? null, error: String(run.error ?? 'none') });
  if (abortedDuringHold) partial('hold: pending canUseTool survives the wait', `signal aborted after ${heldMs}ms`);
  else check(`hold: pending canUseTool survives ${HOLD_MS}ms and the answer lands`, content(repo, 'beta.txt') === 'TANGERINE', `held ${heldMs}ms`);
}
finish();
