import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { JudgeKind } from '@10db/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tempDir, type TempDir } from '../../test/fixtures';
import { fileAccessJudge } from '../sandbox';
import type { ShapeAccess } from '../shape';
import { chatFolderInUse, judgeChatCall, type ChatFolder } from './confinement';

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

const holding: ChatFolder = { holds: () => true, heldBy: () => 'nobody' };
const notHolding: ChatFolder = { holds: () => false, heldBy: () => 'the task ‘Bump vite’' };

const edit = (tool: string, path: string, more: Partial<{ agentId: string }> = {}) => ({
  toolName: tool,
  input: tool === 'NotebookEdit' ? { notebook_path: path } : { file_path: path },
  ...more,
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
  ])('refuses %s while its turn holds the folder', (_name, rel) => {
    const verdict = judgeChatCall(edit('Edit', join(checkout, rel)), access, holding);
    expect(verdict.decision).toBe('deny');
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
    const folder: ChatFolder = { holds: () => held, heldBy: () => 'the pass ‘P’' };
    const call = edit('Write', join(checkout, 'src/new.ts'));
    expect(judgeChatCall(call, access, folder).decision).toBe('allow');
    held = false;
    expect(judgeChatCall(call, access, folder).decision).toBe('deny');
  });
});
