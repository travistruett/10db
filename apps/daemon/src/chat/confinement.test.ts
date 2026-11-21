import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { JudgeKind, type ConversationItemId, type WorkPlace } from '@10db/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tempDir, type TempDir } from '../../test/fixtures';
import { fileAccessJudge } from '../sandbox';
import { judgeShapeCall, stampReview, type ShapeAccess, type ShapeReviewTurn } from '../shape';
import { CHAT_GIT_REFUSAL } from './git-rule';
import {
  CHAT_MOVING,
  CHAT_TURN_ENDED,
  chatFolderInUse,
  judgeChatCall,
  WAITING_FOR_CHOICE,
  type ChatPlace,
} from './confinement';

// Sessions spec §7.3: a chat edits only while its turn holds Your folder, on the real path of each file, and
// never git state or a protected path; a turn that doesn't hold is told who does.

let dir: TempDir;
let checkout: string;
let access: ShapeAccess;

beforeAll(() => {
  dir = tempDir('chat-confinement');
  checkout = join(dir.path, 'checkout');
  mkdirSync(join(checkout, 'src'), { recursive: true });
  mkdirSync(join(checkout, '.git'), { recursive: true });
  writeFileSync(join(checkout, 'src', 'a.ts'), 'a\n');
  writeFileSync(join(checkout, '.git', 'config'), '[core]\n');
  mkdirSync(join(dir.path, 'outside'));
  symlinkSync(join(dir.path, 'outside'), join(checkout, 'link'));
  // A link whose target does not exist yet: a write through it creates the target.
  symlinkSync(join(dir.path, 'outside', 'not-yet'), join(checkout, 'dangling'));
  mkdirSync(join(checkout, '.claude'));
  writeFileSync(join(checkout, '.claude', 'settings.json'), '{}\n');
  mkdirSync(join(dir.path, 'home'));
  const base = {
    checkout,
    home: join(dir.path, 'home'),
    protectedReads: [] as string[],
    filesDir: join(dir.path, 'files'),
    sandboxRoots: [join(dir.path, 'tmp')],
  };
  access = {
    ...base,
    judge: JudgeKind.Native,
    commands: {
      protectedPaths: [],
      fileAccess: fileAccessJudge({
        checkout,
        home: base.home,
        protectedReads: [],
        readList: [],
        systemDocRoots: [],
        configDir: join(dir.path, 'no-claude-config'),
        providerSessionId: null,
        sandboxTemp: { roots: base.sandboxRoots, own: join(dir.path, 'tmp', '10db-own') },
      }),
    },
  };
});
afterAll(() => {
  dir.cleanup();
});

/** A session's place as the hook reads it; `firstChanges` counts the questions its first changes asked. */
const placeOf = (over: Partial<ChatPlace> & { place: WorkPlace | null }): ChatPlace => ({
  holds: () => false,
  current: () => true,
  writable: false,
  heldBy: () => 'nobody',
  firstChange: () => undefined,
  ...over,
  // The checkout is made once the suite starts.
  get root() {
    return checkout;
  },
  get checkout() {
    return checkout;
  },
});
const holding: ChatPlace = placeOf({ place: 'here', holds: () => true, writable: true });
const notHolding: ChatPlace = placeOf({
  place: 'here',
  heldBy: () => 'the task ‘Bump vite’',
});

const edit = (tool: string, path: string, more: Partial<{ agentId: string }> = {}) => ({
  toolName: tool,
  input: tool === 'NotebookEdit' ? { notebook_path: path } : { file_path: path },
  ...more,
});

describe('a session that was opened able to write', () => {
  const ended: ChatPlace = placeOf({
    place: 'here',
    writable: true,
    heldBy: () => 'the task ‘Bump vite’',
  });

  it.each([
    ['Bash', { command: 'echo x >> src/a.ts' }],
    ['Read', { file_path: 'src/a.ts' }],
    ['Agent', { prompt: 'go' }],
    ['mcp__10db__commit_changes', {}],
  ])('refuses a %s call once its turn no longer holds the folder', (toolName, input) => {
    expect(judgeChatCall({ toolName, input, cwd: checkout }, access, ended)).toEqual({
      decision: 'deny',
      reason: CHAT_TURN_ENDED,
    });
  });

  it('still lets a session opened read-only read', () => {
    const call = { toolName: 'Read', input: { file_path: join(checkout, 'src', 'a.ts') } };
    expect(judgeChatCall(call, access, notHolding).decision).toBe('allow');
  });
});

describe('a chat’s edits', () => {
  it.each([
    ['Edit', 'src/a.ts'],
    ['Write', 'src/new.ts'],
    ['NotebookEdit', 'src/nb.ipynb'],
    ['Write', 'src/deeper/than/yet/new.ts'],
  ])('allows %s of %s while its turn holds the folder', (tool, rel) => {
    expect(judgeChatCall(edit(tool, join(checkout, rel)), access, holding)).toEqual({
      decision: 'allow',
    });
  });

  it.each([
    ['a path in .git', join('.git', 'config')],
    ['a path under .git that does not exist', join('.git', 'hooks', 'pre-commit')],
    ['a file outside the checkout', join('..', 'outside', 'x')],
    ['a file reached through a link out of the checkout', join('link', 'x')],
    ['a relative path that climbs out', join('src', '..', '..', 'x')],
    ['a dangling link whose target is outside', 'dangling'],
    ['a Claude Code configuration path', join('.claude', 'settings.json')],
  ])('refuses %s while its turn holds the folder', (_name, rel) => {
    const verdict = judgeChatCall(edit('Edit', join(checkout, rel)), access, holding);
    expect(verdict.decision).toBe('deny');
  });

  it.each([
    ['MultiEdit', 'file_path'],
    ['NotebookEdit', 'notebook_path'],
  ])(
    'judges %s on its own path field, even when the other field names a safe file',
    (tool, field) => {
      const inside = join(checkout, 'src', 'a.ts');
      const git = join(checkout, '.git', 'config');
      expect(
        judgeChatCall({ toolName: tool, input: { [field]: inside } }, access, holding),
      ).toEqual({
        decision: 'allow',
      });
      const other = field === 'file_path' ? 'notebook_path' : 'file_path';
      const crafted = { [field]: git, [other]: inside };
      expect(judgeChatCall({ toolName: tool, input: crafted }, access, holding).decision).toBe(
        'deny',
      );
    },
  );

  it('names a tool it does not know as none of this chat’s, not as a read-only chat', () => {
    const verdict = judgeChatCall({ toolName: 'Teleport', input: {} }, access, holding);
    expect(verdict.decision).toBe('deny');
    expect(JSON.stringify(verdict)).not.toContain('changes nothing');
  });

  describe.runIf(process.platform === 'darwin')(
    'on a file system that folds case and Unicode',
    () => {
      it('refuses git state however its name is spelled', () => {
        for (const rel of [join('.GIT', 'config'), join('.Git', 'hooks', 'pre-commit')])
          expect(judgeChatCall(edit('Edit', join(checkout, rel)), access, holding).decision).toBe(
            'deny',
          );
      });

      it('allows a file inside the checkout spelled in another case or normalisation', () => {
        writeFileSync(join(checkout, 'src', 'é.ts'), 'e\n');
        for (const rel of [join('SRC', 'a.ts'), join('src', 'e\u0301.ts')])
          expect(judgeChatCall(edit('Edit', join(checkout, rel)), access, holding)).toEqual({
            decision: 'allow',
          });
      });
    },
  );

  it('reads a home-relative name as Claude Code does, outside the checkout', () => {
    expect(judgeChatCall(edit('Write', '~/x'), access, holding).decision).toBe('deny');
    expect(judgeChatCall(edit('Write', '~'), access, holding).decision).toBe('deny');
  });

  it.each(['Edit', 'Write', 'NotebookEdit'])(
    'refuses %s while another holder has the folder, naming it',
    (tool) => {
      expect(judgeChatCall(edit(tool, join(checkout, 'src/a.ts')), access, notHolding)).toEqual({
        decision: 'deny',
        reason: chatFolderInUse('the task ‘Bump vite’'),
      });
    },
  );

  it('holds a subagent’s edit to the same rule', () => {
    const call = edit('Edit', join(checkout, 'src/a.ts'), { agentId: 'sub-1' });
    expect(judgeChatCall(call, access, notHolding).decision).toBe('deny');
    expect(judgeChatCall(call, access, holding).decision).toBe('allow');
  });

  it('keeps refusing every write where no folder is given', () => {
    expect(judgeChatCall(edit('Edit', join(checkout, 'src/a.ts')), access).decision).toBe('deny');
  });

  it('reads the hold at each call', () => {
    let held = true;
    const folder = placeOf({
      place: 'here',
      holds: () => held,
      writable: true,
      heldBy: () => 'the pass ‘P’',
    });
    const call = edit('Write', join(checkout, 'src/new.ts'));
    expect(judgeChatCall(call, access, folder).decision).toBe('allow');
    held = false;
    expect(judgeChatCall(call, access, folder).decision).toBe('deny');
  });
});

// Sessions spec §7.3: a chat's shell never writes git or GitHub; the way is its tools.
describe("a chat's shell and git", () => {
  const verdictOf = (command: string) =>
    judgeChatCall({ toolName: 'Bash', input: { command }, cwd: checkout }, access, holding);

  it.each([
    'git commit -m x',
    'git commit --amend --no-edit',
    'git push origin HEAD',
    'git push --force',
    'git -C . push',
    'git branch topic',
    'git switch main',
    'git checkout -b topic',
    'git merge topic',
    'git reset --hard',
    'git add .',
    'git stash',
    'git pull',
    'git tag v1',
    'git rebase main',
    'env git push',
    'command git commit -m x',
    'sh -c "git commit -am x"',
    'bash -lc "cd . && git push"',
    'git status && git commit -m x',
    'gh pr create --title x --body y',
    'gh pr merge 12 --squash',
    'gh api -X POST repos/o/r/issues',
    'gh api repos/o/r/issues -f title=x',
    'gh release create v1',
  ])('refuses %s and names the chat’s tools', (command) => {
    expect(verdictOf(command)).toEqual({ decision: 'deny', reason: CHAT_GIT_REFUSAL });
  });

  it.each([
    'git status',
    'git diff HEAD~1',
    'git log --oneline -5',
    'git show HEAD:src/a.ts',
    'git branch --show-current',
    'git status && git diff',
    'gh pr view 12',
    'gh api repos/o/r/pulls',
  ])('lets the read %s run', (command) => {
    expect(verdictOf(command).decision).toBe('allow');
  });

  it.each([
    'git -c core.pager=sh status',
    'git --git-dir=/x status',
    'git diff --output=out.txt',
    'git grep -O sh foo',
    'gh auth status --show-token',
  ])('keeps its own words for %s, which is about running a program or a secret', (command) => {
    const verdict = verdictOf(command);
    expect(verdict.decision).toBe('deny');
    expect('reason' in verdict && verdict.reason).not.toBe(CHAT_GIT_REFUSAL);
  });

  it('leaves Plan’s words alone: only a chat names its tools', () => {
    const verdict = judgeShapeCall(
      { toolName: 'Bash', toolInput: { command: 'git commit -m x' } },
      access,
    );
    expect('reason' in verdict && verdict.reason).not.toContain('make_branch');
  });
});

// Sessions spec §7.3: the tools that reach GitHub are 10db's judge's: a bare allow where it runs, a question where it
// does not. Claude's auto mode approved all three unasked when it was the judge, so it earns no bare allow.
describe('a chat’s tools that reach GitHub', () => {
  it.each([
    ['push_branch', JudgeKind.Native, 'ask'],
    ['open_pull_request', JudgeKind.Native, 'ask'],
    ['merge_pull_request', JudgeKind.Native, 'ask'],
    ['push_branch', JudgeKind.Tendb, 'allow'],
    ['open_pull_request', JudgeKind.Tendb, 'allow'],
    ['merge_pull_request', JudgeKind.Tendb, 'allow'],
    ['commit_changes', JudgeKind.Native, 'allow'],
    ['push_branch', JudgeKind.Rules, 'ask'],
    ['open_pull_request', JudgeKind.Rules, 'ask'],
    ['merge_pull_request', JudgeKind.Rules, 'ask'],
    ['commit_changes', JudgeKind.Rules, 'allow'],
    ['make_branch', JudgeKind.Rules, 'allow'],
  ])('%s on a %s judge: %s', (tool, judge, decision) => {
    const verdict = judgeChatCall(
      { toolName: `mcp__10db__${tool}`, input: {} },
      { ...access, judge },
      holding,
    );
    expect(verdict.decision).toBe(decision);
  });
});

// The first change asks where the work happens: rows 1, 2, 4 and 8 of the place table, at the guard.
describe('a session that has not chosen where to work', () => {
  const asks = (place: WorkPlace | null, over: Partial<ChatPlace> = {}) => {
    const questions: string[] = [];
    const folder = placeOf({ place, firstChange: () => questions.push('asked'), ...over });
    return { folder, questions };
  };

  it.each<{
    name: string;
    place: WorkPlace | null;
    call: () => Parameters<typeof judgeChatCall>[0];
  }>([
    {
      name: 'an edit while reading',
      place: null,
      call: () => edit('Edit', join(checkout, 'src/a.ts')),
    },
    {
      name: 'a write while choosing',
      place: 'choosing',
      call: () => edit('Write', join(checkout, 'x')),
    },
    {
      name: "a subagent's edit",
      place: null,
      call: () => edit('Edit', join(checkout, 'src/a.ts'), { agentId: 'sub-1' }),
    },
    {
      name: 'make_branch',
      place: null,
      call: () => ({ toolName: 'mcp__10db__make_branch', input: {} }),
    },
    {
      name: 'commit_changes',
      place: 'choosing',
      call: () => ({ toolName: 'mcp__10db__commit_changes', input: {} }),
    },
  ])('asks once and denies with the waiting words: $name', ({ place, call }) => {
    const { folder, questions } = asks(place);
    expect(judgeChatCall(call(), access, folder)).toEqual({
      decision: 'deny',
      reason: WAITING_FOR_CHOICE,
    });
    expect(questions).toEqual(['asked']);
  });

  it.each<{ name: string; call: () => Parameters<typeof judgeChatCall>[0] }>([
    {
      name: 'a Read',
      call: () => ({ toolName: 'Read', input: { file_path: join(checkout, 'src/a.ts') } }),
    },
    { name: 'a push', call: () => ({ toolName: 'mcp__10db__push_branch', input: {} }) },
    {
      name: 'a pull request',
      call: () => ({ toolName: 'mcp__10db__open_pull_request', input: {} }),
    },
  ])('asks nothing for $name', ({ call }) => {
    const { folder, questions } = asks(null);
    judgeChatCall(call(), access, folder);
    expect(questions).toEqual([]);
  });

  it.each<WorkPlace | null>([null, 'choosing'])(
    'refuses every call of an older session with the ended words, asking nothing (%s)',
    (place) => {
      const { folder, questions } = asks(place, { current: () => false });
      for (const call of [
        edit('Edit', join(checkout, 'src/a.ts')),
        { toolName: 'Read', input: { file_path: join(checkout, 'src/a.ts') } },
      ])
        expect(judgeChatCall(call, access, folder)).toEqual({
          decision: 'deny',
          reason: CHAT_TURN_ENDED,
        });
      expect(questions).toEqual([]);
    },
  );

  it('refuses a change while the branch is being made, asking nothing', () => {
    const { folder, questions } = asks('moving');
    expect(judgeChatCall(edit('Edit', join(checkout, 'src/a.ts')), access, folder)).toEqual({
      decision: 'deny',
      reason: CHAT_MOVING,
    });
    expect(questions).toEqual([]);
  });
});

describe('a session on its own branch', () => {
  let worktree: string;
  let onBranch: ChatPlace;
  let branchAccess: ShapeAccess;

  beforeAll(() => {
    worktree = join(dir.path, 'worktree');
    mkdirSync(join(worktree, 'src'), { recursive: true });
    writeFileSync(join(worktree, 'src', 'a.ts'), 'a\n');
    onBranch = {
      ...placeOf({ place: 'branch', holds: () => true, writable: true }),
      root: worktree,
      checkout,
    };
    // The session's sandbox is rooted in the worktree, as `forSession(projectAtCheckout(project, worktree))` makes it.
    branchAccess = {
      ...access,
      checkout: worktree,
      commands: {
        protectedPaths: [],
        fileAccess: fileAccessJudge({
          checkout: worktree,
          home: join(dir.path, 'home'),
          protectedReads: [],
          readList: [],
          systemDocRoots: [],
          configDir: join(dir.path, 'no-claude-config'),
          providerSessionId: null,
          sandboxTemp: { roots: [join(dir.path, 'tmp')], own: join(dir.path, 'tmp', '10db-own') },
        }),
      },
    };
  });

  it('edits its worktree, and an edit aimed at the checkout names the same file there (row 29)', () => {
    expect(judgeChatCall(edit('Edit', join(worktree, 'src/a.ts')), branchAccess, onBranch)).toEqual(
      { decision: 'allow' },
    );
    expect(judgeChatCall(edit('Edit', join(checkout, 'src/a.ts')), branchAccess, onBranch)).toEqual(
      {
        decision: 'deny',
        reason: `This session works in ${worktree} now. The same file is at ${join(worktree, 'src/a.ts')}.`,
      },
    );
  });

  it('never writes the checkout, even when the guard is handed the checkout as its own', () => {
    // A branch's write root is its worktree, and the checkout's `.git` stays out of reach in either.
    expect(
      judgeChatCall(edit('Write', join(checkout, 'brand-new.ts')), branchAccess, onBranch),
    ).toMatchObject({ decision: 'deny' });
  });
});

// Plan in sessions §3, §6: a chat with a plan has Plan's tools, its reviewers' stamp is 10db's bookkeeping
// from the subagent's type, and its folder is read as the chat's is.
describe('a chat with a plan', () => {
  const mcp = (tool: string, more: Partial<{ agentId: string; agentType: string }> = {}) => ({
    toolName: `mcp__10db__${tool}`,
    input: { effortKey: 'e', reviewer: 'scope' },
    ...more,
  });
  const planFolder = () => join(dir.path, 'shapes', 'shp_mine');
  const withPlan = (): ShapeAccess => ({ ...access, planFilesDir: planFolder() });

  beforeAll(() => {
    mkdirSync(planFolder(), { recursive: true });
    mkdirSync(join(dir.path, 'shapes', 'shp_other'), { recursive: true });
    writeFileSync(join(planFolder(), 'notes.txt'), 'x\n');
    writeFileSync(join(dir.path, 'shapes', 'shp_other', 'notes.txt'), 'x\n');
  });

  it.each([
    [
      'a reviewer reports, stamped from its type',
      mcp('report_finding', { agentId: 'a1', agentType: 'tendb-engineering' }),
      'allow',
    ],
    ['the main session cannot report', mcp('report_finding'), 'deny'],
    [
      'the old bare agent name cannot report',
      mcp('report_finding', { agentId: 'a1', agentType: 'scope' }),
      'deny',
    ],
    ['the main session proposes', mcp('propose_plan'), 'allow'],
  ] as const)('%s', (_name, call, decision) => {
    const verdict = judgeChatCall(call, withPlan());
    expect(verdict.decision).toBe(decision);
    if (call.agentType === 'tendb-engineering')
      expect(verdict).toMatchObject({
        updatedInput: { effortKey: 'e', reviewer: 'engineering' },
      });
  });

  it('lets a session with no subagents report a finding only during its review turn, as that review', () => {
    // A Codex session runs no reviewers: its own report_finding passes while a review turn is live.
    const turn = { id: 'cvi_review' as ConversationItemId, kind: 'review' } as const;
    let live: ShapeReviewTurn | null = turn;
    const judge = (call: ReturnType<typeof mcp>) =>
      judgeChatCall(call, withPlan(), undefined, () => live);
    expect(judge(mcp('report_finding')).decision).toBe('allow');
    // The review, not the model, says whose finding it is.
    expect(stampReview(turn, { effortKey: 'e', reviewer: 'engineering' })).toMatchObject({
      reviewer: 'engineering',
    });
    expect(() => stampReview(turn, { effortKey: 'e', reviewer: 'rehearsal' })).toThrow();
    expect(
      stampReview({ ...turn, kind: 'rehearse' }, { effortKey: 'e', reviewer: 'scope' }),
    ).toMatchObject({ reviewer: 'rehearsal' });
    // Every other main-session path keeps its rule: once the turn ends the report is refused.
    live = null;
    expect(judge(mcp('report_finding')).decision).toBe('deny');
    // Claude's rule is unchanged: a tendb-* reviewer reports, stamped from its type; the main session, never.
    expect(judge(mcp('report_finding', { agentId: 'a1', agentType: 'tendb-scope' }))).toMatchObject(
      { decision: 'allow', updatedInput: { reviewer: 'scope' } },
    );
    live = turn;
    expect(judge(mcp('report_finding', { agentId: 'a1', agentType: 'scope' })).decision).toBe(
      'deny',
    );
    expect(judgeChatCall(mcp('report_finding'), withPlan()).decision).toBe('deny');
  });

  it('reads its own plan’s folder and no other plan’s', () => {
    const read = (path: string) =>
      judgeChatCall({ toolName: 'Read', input: { file_path: path } }, withPlan()).decision;
    expect(read(join(planFolder(), 'notes.txt'))).toBe('allow');
    expect(read(join(dir.path, 'shapes', 'shp_other', 'notes.txt'))).toBe('deny');
  });

  it('reads its plan’s folder where the data directory is protected, and nothing else under it', () => {
    mkdirSync(join(dir.path, 'accounts'), { recursive: true });
    writeFileSync(join(dir.path, 'accounts', 'token'), 'x\n');
    const guarded = (): ShapeAccess => ({ ...withPlan(), protectedReads: [dir.path] });
    const read = (path: string) =>
      judgeChatCall({ toolName: 'Read', input: { file_path: path } }, guarded()).decision;
    expect(read(join(planFolder(), 'notes.txt'))).toBe('allow');
    expect(read(join(dir.path, 'accounts', 'token'))).toBe('deny');
    expect(read(join(dir.path, 'shapes', 'shp_other', 'notes.txt'))).toBe('deny');
  });
});
