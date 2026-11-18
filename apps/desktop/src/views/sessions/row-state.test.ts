import { WorkPlace } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { RowIcon, RowMark, rowState, type RowStateInput } from './row-state';
import { TabState } from './tab-state';

const idle: RowStateInput = { tab: TabState.Idle, place: null, pullRequest: null };

describe('rowState', () => {
  const rows: readonly {
    readonly name: string;
    readonly input: RowStateInput;
    readonly icon: RowIcon;
    readonly mark: RowMark | null;
    readonly bold?: boolean;
  }[] = [
    {
      name: 'a reading session is a chat bubble with no mark',
      input: idle,
      icon: RowIcon.Reading,
      mark: null,
    },
    {
      name: 'here is a laptop',
      input: { ...idle, place: WorkPlace.Here },
      icon: RowIcon.Here,
      mark: null,
    },
    {
      name: 'a branch is a branch',
      input: { ...idle, place: WorkPlace.Branch },
      icon: RowIcon.Branch,
      mark: null,
    },
    {
      name: 'moving is a branch with a spinner',
      input: { ...idle, place: WorkPlace.Moving },
      icon: RowIcon.Branch,
      mark: RowMark.Working,
    },
    {
      name: 'choosing reads and needs you',
      input: { ...idle, place: WorkPlace.Choosing },
      icon: RowIcon.Reading,
      mark: RowMark.NeedsYou,
    },
    {
      name: 'a running turn is a spinner',
      input: { ...idle, tab: TabState.Working },
      icon: RowIcon.Reading,
      mark: RowMark.Working,
    },
    {
      name: 'a card to answer beats a running turn’s spinner',
      input: { tab: TabState.NeedsYou, place: WorkPlace.Here, pullRequest: null },
      icon: RowIcon.Here,
      mark: RowMark.NeedsYou,
    },
    {
      name: 'an error beats an open pull request',
      input: { tab: TabState.Error, place: WorkPlace.Branch, pullRequest: 'open' },
      icon: RowIcon.Branch,
      mark: RowMark.Error,
    },
    {
      name: 'a pause is shown',
      input: { ...idle, tab: TabState.Paused },
      icon: RowIcon.Reading,
      mark: RowMark.Paused,
    },
    {
      name: 'a spinner beats an open pull request',
      input: { tab: TabState.Working, place: WorkPlace.Branch, pullRequest: 'open' },
      icon: RowIcon.Branch,
      mark: RowMark.Working,
    },
    {
      name: 'an open pull request beats an unseen reply',
      input: { tab: TabState.NewReply, place: WorkPlace.Branch, pullRequest: 'open' },
      icon: RowIcon.Branch,
      mark: RowMark.PullRequest,
    },
    {
      name: 'a merged pull request is a check',
      input: { ...idle, place: WorkPlace.Branch, pullRequest: 'merged' },
      icon: RowIcon.Branch,
      mark: RowMark.Merged,
    },
    {
      name: 'an unseen reply bolds the title and adds no mark',
      input: { ...idle, tab: TabState.NewReply },
      icon: RowIcon.Reading,
      mark: null,
      bold: true,
    },
    {
      name: 'the terminal wins the icon over the place',
      input: { tab: TabState.InTerminal, place: WorkPlace.Here, pullRequest: null },
      icon: RowIcon.Terminal,
      mark: null,
    },
  ];
  it.each(rows)('$name', ({ input, icon, mark, bold = false }) => {
    const state = rowState(input);
    expect(state.icon).toBe(icon);
    expect(state.mark).toBe(mark);
    expect(state.bold).toBe(bold);
  });
});
