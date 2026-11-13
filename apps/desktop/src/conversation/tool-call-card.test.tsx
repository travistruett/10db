import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { hunk } from '../test/hunks';
import { renderWithTheme } from '../test/theme';
import {
  commandCall,
  editCall,
  readCall,
  subagentCall,
  toolEntry,
} from '../test/tool-call-fixtures';
import { EditGroupRow, ToolCallCard, ToolGroupRow } from './tool-call-card';

const twentyLines = Array.from({ length: 20 }, (_, i) => `line ${String(i)}`);

describe('ToolCallCard', () => {
  it('is a closed button named by its whole row, which opens on a click or Enter', () => {
    renderWithTheme(<ToolCallCard entry={toolEntry(commandCall())} nested={[]} />);
    const row = screen.getByRole('button', { name: 'Ran pnpm vitest run src/api, 9 seconds' });
    expect(row.tagName).toBe('BUTTON');
    expect(row.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(row);
    expect(row.getAttribute('aria-expanded')).toBe('true');
  });

  describe('a command', () => {
    it('opens to its output tail, saying how much it cut, with Show All Output only when it can load', () => {
      const call = commandCall({ outputTail: 'PASS src/api', outputBytes: 212 * 1024 });
      const { unmount } = renderWithTheme(<ToolCallCard entry={toolEntry(call)} nested={[]} />);
      fireEvent.click(screen.getByRole('button', { name: /^Ran pnpm/ }));
      expect(screen.getByText('PASS src/api')).toBeTruthy();
      expect(screen.getByText(/Showing the last 4 KB of 212 KB/)).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Show All Output' })).toBeNull();
      unmount();
      const loadFull = vi.fn(() => Promise.resolve('all of it'));
      renderWithTheme(<ToolCallCard entry={toolEntry(call)} nested={[]} loadFull={loadFull} />);
      fireEvent.click(screen.getByRole('button', { name: /^Ran pnpm/ }));
      fireEvent.click(screen.getByRole('button', { name: 'Show All Output' }));
      expect(loadFull).toHaveBeenCalledWith('c1');
    });

    it('opens by itself when it failed, to its last 8 lines', () => {
      const tail = Array.from({ length: 12 }, (_, i) => `out ${String(i)}`).join('\n');
      const call = commandCall({ status: 'failed', exitCode: 1, outputTail: tail });
      renderWithTheme(<ToolCallCard entry={toolEntry(call)} nested={[]} />);
      const row = screen.getByRole('button', { name: /failed, exit 1/ });
      expect(row.getAttribute('aria-expanded')).toBe('true');
      const shown = screen.getByTestId('command-output').textContent;
      expect(shown).toContain('out 11');
      expect(shown).toContain('out 4');
      expect(shown).not.toContain('out 3');
    });
  });

  describe('an edit', () => {
    const big = editCall({ hunks: [hunk(1, 1, [], twentyLines), hunk(40, 60, ['a'], ['b'])] });

    it('peeks at its first hunk, at most 8 lines, while closed', () => {
      const { container } = renderWithTheme(<ToolCallCard entry={toolEntry(big)} nested={[]} />);
      expect(container.querySelectorAll('[data-gutter-line]')).toHaveLength(8);
    });

    it('draws every hunk on Show Full Diff', () => {
      const { container } = renderWithTheme(<ToolCallCard entry={toolEntry(big)} nested={[]} />);
      fireEvent.click(screen.getByRole('button', { name: /^Edited src\/api\/client\.ts/ }));
      fireEvent.click(screen.getByRole('button', { name: 'Show Full Diff' }));
      expect(container.querySelectorAll('[data-gutter-line]')).toHaveLength(22);
      expect(screen.getByText('@@ −40,1 +60,1 @@')).toBeTruthy();
    });

    it('says where a long edit was cut, with Open Full Patch only when it can load', () => {
      const cut = editCall({ hunks: [hunk(1, 1, ['a'], ['b'])], truncated: true });
      const { unmount } = renderWithTheme(<ToolCallCard entry={toolEntry(cut)} nested={[]} />);
      fireEvent.click(screen.getByRole('button', { name: /^Edited/ }));
      expect(screen.getByText(/Cut at 1,500 changed lines/)).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Open Full Patch' })).toBeNull();
      unmount();
      renderWithTheme(
        <ToolCallCard
          entry={toolEntry(cut)}
          nested={[]}
          loadFull={() => Promise.resolve('patch')}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: /^Edited/ }));
      expect(screen.getByRole('button', { name: 'Open Full Patch' })).toBeTruthy();
    });
  });

  it('marks a running call with a blue dot in its icon place', () => {
    const { container } = renderWithTheme(
      <ToolCallCard
        entry={toolEntry(commandCall({ status: 'running', durationMs: null, exitCode: null }))}
        nested={[]}
      />,
    );
    expect(container.querySelector('[data-status="running"]')).not.toBeNull();
  });

  it('says 10db stopped a call, and the refusal in words once opened', () => {
    const call = commandCall({
      status: 'denied',
      deniedBy: '10db',
      refusal: 'writes outside the checkout',
    });
    renderWithTheme(<ToolCallCard entry={toolEntry(call)} nested={[]} />);
    expect(screen.getByText('10db stopped this: writes outside the checkout')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /10db stopped this/ }));
    expect(screen.getByText('writes outside the checkout')).toBeTruthy();
  });

  describe('a call the judge held back', () => {
    const held = (soft: boolean) =>
      toolEntry(
        commandCall({ status: 'denied', deniedBy: 'judge', limit: 'sends_data_out', soft }),
      );

    it('offers Allow This when soft and a sender is given, which allows it once', () => {
      const onAllow = vi.fn();
      renderWithTheme(<ToolCallCard entry={held(true)} nested={[]} onAllow={onAllow} />);
      expect(screen.getByText('Held back: this would send data out')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Allow This' }));
      expect(onAllow).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('button', { name: 'Allow This' })).toBeNull();
      expect(screen.getByText('You allowed this')).toBeTruthy();
    });

    it('offers nothing on a hard deny, or with no sender', () => {
      const { unmount } = renderWithTheme(
        <ToolCallCard entry={held(false)} nested={[]} onAllow={vi.fn()} />,
      );
      expect(screen.queryByRole('button', { name: 'Allow This' })).toBeNull();
      unmount();
      renderWithTheme(<ToolCallCard entry={held(true)} nested={[]} />);
      expect(screen.queryByRole('button', { name: 'Allow This' })).toBeNull();
    });
  });

  it('draws a subagent’s calls under it, indented, once opened', () => {
    const nested = [
      toolEntry(readCall({ id: 'k1', parentId: 'a1', path: 'src/a.ts' })),
      toolEntry(readCall({ id: 'k2', parentId: 'a1', path: 'src/b.ts' })),
    ];
    renderWithTheme(<ToolCallCard entry={toolEntry(subagentCall())} nested={nested} />);
    expect(screen.queryByRole('button', { name: 'Read src/a.ts' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Subagent:/ }));
    const group = screen.getByRole('group', { name: 'Calls of this subagent' });
    expect(within(group).getByRole('button', { name: 'Read src/a.ts' })).toBeTruthy();
    expect(within(group).getByRole('button', { name: 'Read src/b.ts' })).toBeTruthy();
  });
});

it("counts a nested subagent's own calls", () => {
  const nested = [
    toolEntry(subagentCall({ id: 'a2', parentId: 'a1' })),
    toolEntry(readCall({ id: 'k1', parentId: 'a2' })),
    toolEntry(readCall({ id: 'k2', parentId: 'a2' })),
  ];
  renderWithTheme(<ToolCallCard entry={toolEntry(subagentCall())} nested={nested} />);
  fireEvent.click(screen.getByRole('button', { name: /^Subagent:/ }));
  const group = screen.getByRole('group', { name: 'Calls of this subagent' });
  expect(within(group).getByText('2 calls · 1 min')).toBeTruthy();
});

describe('ToolGroupRow', () => {
  it('names the group, and opened lists one call per line', () => {
    const entries = ['a', 'b', 'c'].map((p) => toolEntry(readCall({ id: p, path: `src/${p}.ts` })));
    renderWithTheme(<ToolGroupRow entries={entries} />);
    fireEvent.click(screen.getByRole('button', { name: 'Read 3 files' }));
    for (const p of ['a', 'b', 'c']) expect(screen.getByText(`src/${p}.ts`)).toBeTruthy();
  });
});

describe('EditGroupRow', () => {
  const entries = [
    toolEntry(editCall({ id: 'e1', path: 'src/a.ts', hunks: [hunk(1, 1, ['a'], ['b'])] })),
    toolEntry(editCall({ id: 'e2', path: 'src/b.ts', hunks: [hunk(1, 1, ['c'], ['d'])] })),
    toolEntry(editCall({ id: 'e3', path: 'src/c.ts', hunks: [hunk(1, 1, ['e'], ['f'])] })),
  ];

  it('peeks only under its last edit, and opened lists each file with its counts', () => {
    const { container } = renderWithTheme(<EditGroupRow entries={entries} />);
    const peeks = container.querySelectorAll('[data-peek]');
    expect(peeks).toHaveLength(1);
    expect(peeks[0]?.getAttribute('data-peek')).toBe('e3');
    fireEvent.click(screen.getByRole('button', { name: 'Edited 3 files, +12 −6' }));
    for (const p of ['a', 'b', 'c']) expect(screen.getByText(`src/${p}.ts`)).toBeTruthy();
    expect(screen.getAllByText('+4 −2')).toHaveLength(3);
    const stillPeeking = container.querySelectorAll('[data-peek]');
    expect([...stillPeeking].map((p) => p.getAttribute('data-peek'))).toEqual(['e3']);
  });
});
