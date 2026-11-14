import { GoalStatus, mintId } from '@10db/contracts';
import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { goalDigestDto } from '../../test/goal-fixtures';
import { theme } from '../../theme';
import { WaitingOnOthers } from './goal-digest';
import { verdictLine } from './goal-status';

const sentAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000 - 60_000).toISOString();
const row = (names: string[], hours = 3) => ({
  inboxItemId: mintId('InboxItem'),
  taskId: mintId('Task'),
  title: 'How long should access last?',
  names,
  at: sentAgo(hours),
});

describe('a goal waiting on someone', () => {
  it('says who, how many questions and how long', () => {
    const digest = goalDigestDto(mintId('Goal'), {
      status: GoalStatus.WaitingOnSomeone,
      waitingOnSomeone: [row(['Mark']), row(['Mark', 'Ana'], 5)],
    });
    expect(verdictLine(digest)).toMatch(/^Waiting on Mark and Ana · 2 questions · 5h · /);
  });

  it('lists the questions apart from Needs you, with who each is on', () => {
    const digest = goalDigestDto(mintId('Goal'), {
      status: GoalStatus.WaitingOnSomeone,
      waitingOnSomeone: [row(['Mark'])],
    });
    render(
      <MantineProvider theme={theme}>
        <WaitingOnOthers digest={digest} />
      </MantineProvider>,
    );
    expect(screen.getByText('Waiting on others')).toBeTruthy();
    expect(screen.getByText('Mark: How long should access last?')).toBeTruthy();
  });

  it('draws nothing when no question is out', () => {
    const digest = goalDigestDto(mintId('Goal'), {});
    render(
      <MantineProvider theme={theme}>
        <WaitingOnOthers digest={digest} />
      </MantineProvider>,
    );
    expect(screen.queryByText('Waiting on others')).toBeNull();
  });
});
