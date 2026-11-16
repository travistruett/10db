import { FolderHolderKind, FolderLimit, mintId, type FolderHolderDto } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { folderView } from './view';

const project = mintId('Project');

const holder = (kind: FolderHolderKind, name: string, more = 0): FolderHolderDto => ({
  kind,
  name,
  more,
  chatId: null,
  what: null,
});

// The view the session bar and the composer read: words per holder, who keeps a chat out, and the limits.
describe('folderView', () => {
  const rows: {
    readonly name: string;
    readonly holders: readonly FolderHolderDto[];
    readonly keepsChatOut: readonly boolean[];
    readonly limits: readonly FolderLimit[];
    readonly limitPass: string | null;
  }[] = [
    { name: 'free', holders: [], keepsChatOut: [], limits: [], limitPass: null },
    {
      name: 'a task keeps a chat out',
      holders: [holder(FolderHolderKind.Lane, 'Bump vite', 2)],
      keepsChatOut: [true],
      limits: [],
      limitPass: null,
    },
    {
      name: 'a chat shares and a closed pass limits only the git tools',
      holders: [
        holder(FolderHolderKind.PassClosed, 'Settings pass'),
        holder(FolderHolderKind.ChatTurn, 'Retry login'),
      ],
      keepsChatOut: [false, false],
      limits: [FolderLimit.FolderGitUntilMerge],
      limitPass: 'Settings pass',
    },
  ];

  it.each(rows)('$name', ({ holders, keepsChatOut, limits, limitPass }) => {
    const view = folderView(project, 'main', holders);
    expect(view.branch).toBe('main');
    expect(view.holders.map((h) => h.keepsChatOut)).toEqual(keepsChatOut);
    expect(view.limits).toEqual(limits);
    expect(view.limitPass).toBe(limitPass);
  });

  it('words each holder as a notice does', () => {
    const view = folderView(project, null, [holder(FolderHolderKind.Lane, 'Bump vite', 2)]);
    expect(view.holders[0]?.words).toBe('the task ‘Bump vite’ and 2 more');
  });
});
