import { describe, expect, it } from 'vitest';
import { claudeToolTarget, codexCommandTarget, codexPatchTarget } from './tool-target';

// Workbench spec §4.3: a working page's live line names the file a tool aims at, and counts only the
// files a turn writes.

describe('claudeToolTarget', () => {
  it.each<{ name: string; tool: string; input: unknown; target: string | null; written: string[] }>(
    [
      {
        name: 'a Write writes its file',
        tool: 'Write',
        input: { file_path: 'src/settings/page.tsx', content: 'x' },
        target: 'src/settings/page.tsx',
        written: ['src/settings/page.tsx'],
      },
      {
        name: 'an Edit writes its file',
        tool: 'Edit',
        input: { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' },
        target: 'src/a.ts',
        written: ['src/a.ts'],
      },
      {
        name: 'a MultiEdit writes its file',
        tool: 'MultiEdit',
        input: { file_path: 'src/a.ts', edits: [] },
        target: 'src/a.ts',
        written: ['src/a.ts'],
      },
      {
        name: 'a NotebookEdit writes its notebook',
        tool: 'NotebookEdit',
        input: { notebook_path: 'n.ipynb', new_source: '' },
        target: 'n.ipynb',
        written: ['n.ipynb'],
      },
      {
        name: 'a Read aims at its file and writes none',
        tool: 'Read',
        input: { file_path: 'src/a.ts' },
        target: 'src/a.ts',
        written: [],
      },
      {
        name: 'a Grep aims at its pattern and writes none',
        tool: 'Grep',
        input: { pattern: 'useForm' },
        target: 'useForm',
        written: [],
      },
      {
        name: 'a Bash command is named by its first word, leaving out the variables it sets',
        tool: 'Bash',
        input: { command: 'CI=1 pnpm test --filter desktop' },
        target: 'pnpm',
        written: [],
      },
      {
        name: 'an MCP tool aims at nothing it names',
        tool: 'mcp__10db__commit',
        input: { message: 'x' },
        target: null,
        written: [],
      },
      {
        name: 'a Write whose input has no path aims at nothing',
        tool: 'Write',
        input: { content: 'x' },
        target: null,
        written: [],
      },
    ],
  )('$name', ({ tool, input, target, written }) => {
    expect(claudeToolTarget(tool, input)).toEqual({ name: tool, target, written });
  });
});

describe('Codex tool targets', () => {
  it('names a command by its first word, writing nothing', () => {
    expect(codexCommandTarget('  git status --short')).toEqual({
      name: 'command',
      target: 'git',
      written: [],
    });
  });

  it('names a patch by its first file, writing every file it changes', () => {
    expect(codexPatchTarget(['src/a.ts', 'src/b.ts'])).toEqual({
      name: 'apply_patch',
      target: 'src/a.ts',
      written: ['src/a.ts', 'src/b.ts'],
    });
  });
});
