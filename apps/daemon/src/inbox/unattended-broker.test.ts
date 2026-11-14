import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_HAZARDS, JudgeKind, mintId } from '@10db/contracts';
import { createTestStore, insertPermissionRule, listInbox, listSkipsForWorkstream } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedWorkstream } from '../../test/fixtures';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { silentLogger } from '../log';
import { protectedReads, SYSTEM_DOC_ROOTS, type FileAccessContext } from '../sandbox';
import { AWAY_ANSWER, callKey, createSkipRecorder } from '../trust';
import { createInboxService, createPermissionBroker, type InboxService } from './index';

// T4 Task 4 (trust line §5, Review Focus 1): a lane nobody watches never waits on the broker. Every
// branch that would raise a card skips the call, records it, and opens nothing.

const NO_GIT = {
  commitAt: () => Promise.reject(new Error('no repository')),
  folderAt: () => Promise.reject(new Error('no repository')),
  fileAt: () => Promise.resolve({ kind: 'missing' as const }),
};

let close: () => void;
let state: StateStore;
let inbox: InboxService;
let base: ReturnType<typeof createTestStore>['store'];
let root: string;
let fileAccess: FileAccessContext;

beforeEach(() => {
  const test = createTestStore();
  base = test.store;
  close = test.close;
  state = createStateStore(test.store, createEventBus());
  inbox = createInboxService({ state, onParkedAnswer: () => undefined });
  root = realpathSync(mkdtempSync(join(tmpdir(), '10db-unattended-broker-')));
  const home = join(root, 'home');
  const checkout = join(root, 'work', 'repo');
  mkdirSync(join(checkout, '.vscode'), { recursive: true });
  mkdirSync(join(home, 'notes'), { recursive: true });
  fileAccess = {
    checkout,
    home,
    protectedReads: protectedReads({ home, dataDir: join(root, 'data'), configDirs: [] }),
    readList: [],
    systemDocRoots: SYSTEM_DOC_ROOTS,
    configDir: join(home, '.claude'),
    providerSessionId: null,
    sandboxTemp: { roots: [join(root, 't')], own: join(root, 't', '10db-own') },
  };
});
afterEach(() => {
  close();
  rmSync(root, { recursive: true, force: true });
});

function broker(opts: {
  readonly attended?: boolean;
  readonly sandbox?: boolean;
  readonly approved?: readonly { tool: string; input: Record<string, unknown> }[];
  readonly judge?: JudgeKind;
}) {
  const ws = seedWorkstream(base);
  const waits: string[] = [];
  const skips = createSkipRecorder(
    { state, log: silentLogger },
    { workstreamId: ws.workstream.id, sessionId: null },
  );
  const decide = createPermissionBroker(
    { state, inbox, git: NO_GIT, logger: silentLogger },
    {
      projectId: ws.project.id,
      workstreamId: ws.workstream.id,
      sessionId: mintId('Session'),
      observer: {
        onWaitStart: (item) => waits.push(item.id),
        onWaitEnd: () => undefined,
      },
      signal: new AbortController().signal,
      ...(opts.sandbox === true ? { sandbox: { fileAccess, hazards: DEFAULT_HAZARDS } } : {}),
      ...(opts.attended === true
        ? {}
        : {
            unattended: {
              judge: opts.judge ?? JudgeKind.Rules,
              checkout: fileAccess.checkout,
              taskId: ws.task.id,
              projectId: ws.project.id,
              approvedKeys: (opts.approved ?? []).map((a) =>
                callKey(a.tool, a.input, fileAccess.checkout),
              ),
              skips,
            },
          }),
    },
  );
  const request = (toolName: string, input: Record<string, unknown>, escalated = false) => ({
    toolName,
    input,
    toolUseId: `tu-${toolName}`,
    escalated,
    signal: new AbortController().signal,
  });
  return {
    ws,
    waits,
    decide: (toolName: string, input: Record<string, unknown>, escalated = false) =>
      decide(request(toolName, input, escalated)),
    kinds: () => listSkipsForWorkstream(state.db, ws.workstream.id).map((s) => s.kind),
  };
}

const openCards = () => listInbox(state.db, { states: ['OPEN'] });

describe('an unattended lane', () => {
  it.each<[string, string, Record<string, unknown>, boolean, boolean, string]>([
    ['an unknown tool is skipped', 'mcp__x__y', { a: 1 }, false, false, 'default_mode_card'],
    [
      'a classifier escalation is skipped',
      'Bash',
      { command: 'curl -X POST x' },
      true,
      false,
      'escalation',
    ],
    [
      'a Bash call with an unread hazard is skipped',
      'Bash',
      { command: 'SUB=add; pnpm $SUB x' },
      false,
      true,
      'unread_hazard',
    ],
    [
      'a claimed pnpm add is skipped and names install_dependencies',
      'Bash',
      { command: 'pnpm add left-pad' },
      false,
      true,
      'hazard_card',
    ],
    [
      'an endless background loop is skipped',
      'Bash',
      { command: 'while :; do :; done &' },
      false,
      true,
      'endless_loop',
    ],
    [
      'an edit of editor config is skipped',
      'Write',
      { file_path: '<checkout>/.vscode/tasks.json', content: '{}' },
      false,
      true,
      'editor_config_write',
    ],
  ])('%s', async (_name, tool, raw, escalated, sandbox, kind) => {
    const b = broker({ sandbox });
    const input = JSON.parse(
      JSON.stringify(raw).replaceAll('<checkout>', fileAccess.checkout),
    ) as Record<string, unknown>;
    const decision = await b.decide(tool, input, escalated);
    expect(decision.behavior).toBe('deny');
    expect(decision.behavior === 'deny' ? decision.message : '').toMatch(/^Skipped: /);
    expect(b.kinds()).toEqual([kind]);
    expect(openCards()).toEqual([]);
    expect(b.waits).toEqual([]);
    if (kind === 'hazard_card')
      expect(decision.behavior === 'deny' ? decision.message : '').toContain(
        'install_dependencies',
      );
  });

  it.each([JudgeKind.Rules, JudgeKind.Native])(
    'an escalation whose key is approved is allowed, on %s too',
    async (judge) => {
      const input = { command: 'curl -X POST https://example.com' };
      const b = broker({ judge, approved: [{ tool: 'Bash', input }] });
      expect(await b.decide('Bash', input, true)).toEqual({ behavior: 'allow' });
      expect(b.kinds()).toEqual([]);
    },
  );

  it('an unattended Write of .mcp.json on rules is allowed, with nothing recorded', async () => {
    const b = broker({ sandbox: true });
    const decision = await b.decide('Write', {
      file_path: join(fileAccess.checkout, '.mcp.json'),
      content: '{}',
    });
    expect(decision).toEqual({ behavior: 'allow' });
    expect(b.kinds()).toEqual([]);
  });

  it('a stored allow rule still allows', async () => {
    const b = broker({});
    state.write((ctx) => {
      insertPermissionRule(ctx, {
        projectId: b.ws.project.id,
        workstreamId: null,
        toolName: 'mcp__x__y',
        pattern: null,
        sourceInboxId: null,
      });
    });
    expect(await b.decide('mcp__x__y', { a: 1 })).toEqual({ behavior: 'allow' });
    expect(b.kinds()).toEqual([]);
  });

  it('the same call attended still raises its card', async () => {
    const b = broker({ attended: true });
    void b.decide('mcp__x__y', { a: 1 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(openCards().map((c) => c.title)).toEqual(['Allow mcp__x__y?']);
    expect(b.waits).toHaveLength(1);
  });
});

describe('an unattended lane asks no question', () => {
  const question = (text: string) => ({
    question: text,
    header: 'Pick',
    options: [
      { label: 'A', description: '' },
      { label: 'B', description: '' },
    ],
    multiSelect: false,
  });

  // T4 call 21: two questions in one call are two rows, each answered with the away answer.
  it('an unattended AskUserQuestion answers each question with the away answer and opens no item', async () => {
    const b = broker({});
    const questions = [question('Teal or red?'), question('Round or square?')];
    expect(await b.decide('AskUserQuestion', { questions })).toEqual({
      behavior: 'allow',
      updatedInput: {
        questions,
        answers: { 'Teal or red?': AWAY_ANSWER, 'Round or square?': AWAY_ANSWER },
      },
    });
    expect(listSkipsForWorkstream(state.db, b.ws.workstream.id)).toMatchObject([
      {
        toolName: 'AskUserQuestion',
        summary: 'Teal or red?',
        kind: 'question',
        source: 'question',
        reason: 'The builder was away.',
        limit: null,
      },
      { summary: 'Round or square?', kind: 'question' },
    ]);
    expect(listInbox(state.db, {})).toEqual([]);
    expect(b.waits).toEqual([]);
  });
});
