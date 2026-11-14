import { JudgeDecision, JudgeOutcome, mintId } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithDaemonAndRouter } from '../../test/daemon';
import { judgeCallDto, serveJudge } from '../../test/judge-fixtures';
import { RecentDecisions } from './recent-decisions';

const at = (n: number): string => new Date(Date.UTC(2026, 9, 31, 12, 0, n)).toISOString();

const manyCalls = (count: number) =>
  Array.from({ length: count }, (_, i) => judgeCallDto({ createdAt: at(i) }));

/** The most recent request for a page of calls. */
const lastQuery = (sent: ReturnType<typeof serveJudge>) =>
  sent.filter((r) => r.path === '/judge/calls/page').at(-1)?.query;

/** Opens a header's filter and picks an option from its Select, whose list draws inside the popover. */
async function pickFilter(header: string, label: string, option: string) {
  fireEvent.click(await screen.findByRole('button', { name: `Filter ${header}` }));
  const input = await screen.findByRole('combobox', { name: label });
  fireEvent.click(input);
  const list = await waitFor(() => {
    const id = input.getAttribute('aria-controls');
    const el = id === null ? null : document.getElementById(id);
    if (el === null) throw new Error('the list is not open');
    return el;
  });
  fireEvent.click(within(list).getByRole('option', { name: option, hidden: true }));
}

describe('RecentDecisions', () => {
  it('lists a page newest first and asks the daemon for limit 25, offset 0', async () => {
    const sent = serveJudge({
      calls: [
        judgeCallDto({ model: 'a/oldest', createdAt: at(1) }),
        judgeCallDto({ model: 'a/newest', createdAt: at(3) }),
        judgeCallDto({ model: 'a/middle', createdAt: at(2) }),
      ],
    });
    await renderWithDaemonAndRouter(<RecentDecisions />);
    await screen.findByText('newest');
    const table = screen.getByRole('table', { name: 'Recent decisions' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => /newest|middle|oldest/.exec(r.textContent)?.[0])).toEqual([
      'newest',
      'middle',
      'oldest',
    ]);
    expect(lastQuery(sent)).toEqual({ limit: '25', offset: '0' });
  });

  it('pages through the daemon', async () => {
    const sent = serveJudge({ calls: manyCalls(60) });
    await renderWithDaemonAndRouter(<RecentDecisions />);
    fireEvent.click(await screen.findByRole('button', { name: 'Next page' }));
    await waitFor(() => {
      expect(lastQuery(sent)).toEqual({ limit: '25', offset: '25' });
    });
  });

  it('filters by decision and outcome from the headers, back on page 1', async () => {
    const sent = serveJudge({ calls: manyCalls(60) });
    await renderWithDaemonAndRouter(<RecentDecisions />);
    fireEvent.click(await screen.findByRole('button', { name: 'Next page' }));
    await waitFor(() => {
      expect(lastQuery(sent)?.['offset']).toBe('25');
    });
    await pickFilter('Decision', 'Decision', 'Who a question goes to');
    await waitFor(() => {
      expect(lastQuery(sent)).toEqual({ limit: '25', offset: '0', decision: 'question_route' });
    });
    await pickFilter('What 10db did', 'What 10db did', 'Not sure enough');
    await waitFor(() => {
      expect(lastQuery(sent)).toEqual({
        limit: '25',
        offset: '0',
        decision: 'question_route',
        outcome: 'below_floor',
      });
    });
  });

  it('keeps its header when nothing matches', async () => {
    serveJudge({ calls: [judgeCallDto()] });
    await renderWithDaemonAndRouter(<RecentDecisions />);
    await pickFilter('Decision', 'Decision', 'Who a question goes to');
    expect(await screen.findByText('No decision matches these filters.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Filter Decision' })).toBeTruthy();
  });

  it('a decision’s own table hides the Decision column and asks for that decision', async () => {
    const sent = serveJudge({ calls: [judgeCallDto({ decision: JudgeDecision.ReplyMatch })] });
    await renderWithDaemonAndRouter(<RecentDecisions decision={JudgeDecision.ReplyMatch} />);
    const table = await screen.findByRole('table', {
      name: 'Recent decisions: Which question a reply answers',
    });
    await waitFor(() => {
      expect(lastQuery(sent)).toEqual({ limit: '25', offset: '0', decision: 'reply_match' });
    });
    expect(within(table).queryByRole('button', { name: 'Filter Decision' })).toBeNull();
    expect(within(table).getByRole('button', { name: 'Filter What 10db did' })).toBeTruthy();
  });

  it('a call on a task links to it on the board', async () => {
    const taskId = mintId('Task');
    serveJudge({
      calls: [
        judgeCallDto({ taskId, outcome: JudgeOutcome.Acted, createdAt: at(2) }),
        judgeCallDto({ createdAt: at(1) }),
      ],
    });
    await renderWithDaemonAndRouter(<RecentDecisions />);
    const link = await screen.findByRole('link', { name: 'Open on the board' });
    expect(link.getAttribute('href')).toBe(`/board?task=${taskId}`);
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });
});
