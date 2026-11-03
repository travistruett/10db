import { mintId } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp } from '../../test/daemon';
import {
  judgeCallDto,
  judgeStatusDto,
  serveJudge,
  shapeMeasuresDto,
} from '../../test/judge-fixtures';

const PASTED = 'sk-or-pasted-value-never-echoed';

function open(options: Parameters<typeof serveJudge>[0] = {}) {
  const sent = serveJudge(options);
  const app = renderApp('/settings/decisions');
  return { sent, ...app };
}

describe('Settings › Decisions', () => {
  it('says the key is not set', async () => {
    open();
    expect(await screen.findByText('Not set')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Set Key' })).toHaveProperty('disabled', false);
    expect(screen.getByRole('button', { name: 'Remove Key' })).toHaveProperty('disabled', true);
  });

  it('says the key is set, never showing it', async () => {
    open({ status: judgeStatusDto({ keySet: true }) });
    expect(await screen.findByText('Set')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Replace Key' })).toHaveProperty('disabled', false);
  });

  it('sends the key, clears the field and never renders or caches it', async () => {
    const { sent, queryClient } = open();
    const field = await screen.findByLabelText('OpenRouter key');
    expect(field).toHaveProperty('type', 'password');
    fireEvent.change(field, { target: { value: PASTED } });
    fireEvent.click(screen.getByRole('button', { name: 'Set Key' }));
    expect(await screen.findByText('Set')).toBeTruthy();
    expect(sent).toContainEqual({ method: 'PUT', path: '/judge/key', body: { key: PASTED } });
    expect(screen.getByLabelText('OpenRouter key')).toHaveProperty('value', '');
    expect(document.body.innerHTML).not.toContain(PASTED);
    expect(
      JSON.stringify(
        queryClient
          .getQueryCache()
          .getAll()
          .map((q) => q.state),
      ),
    ).not.toContain(PASTED);
    expect(
      JSON.stringify(
        queryClient
          .getMutationCache()
          .getAll()
          .map((m) => m.state),
      ),
    ).not.toContain(PASTED);
  });

  it('removes the key', async () => {
    const { sent } = open({ status: judgeStatusDto({ keySet: true }) });
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Key' }));
    expect(await screen.findByText('Not set')).toBeTruthy();
    expect(sent).toContainEqual({ method: 'DELETE', path: '/judge/key', body: null });
  });

  it('shows the model and latency of a passing test', async () => {
    const { sent } = open({
      status: judgeStatusDto({ keySet: true }),
      test: { ok: true, model: 'typesafe/jev-1.13', latencyMs: 412, costUsd: 0.0001 },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Test Connection' }));
    expect(await screen.findByText(/typesafe\/jev-1\.13.*412 ms/)).toBeTruthy();
    expect(sent).toContainEqual({ method: 'POST', path: '/judge/test', body: null });
  });

  it('shows the error of a failed test', async () => {
    open({
      status: judgeStatusDto({ keySet: true }),
      test: { ok: false, error: 'OpenRouter refused the key.' },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Test Connection' }));
    expect(await screen.findByText('OpenRouter refused the key.')).toBeTruthy();
  });

  it('sends the master switch and the per-decision switch as patches', async () => {
    const { sent } = open();
    const master = await screen.findByRole('switch', {
      name: 'Use fast models for routine decisions',
    });
    expect(master).toHaveProperty('checked', true);
    fireEvent.click(master);
    await waitFor(() => {
      expect(sent).toContainEqual({ method: 'PATCH', path: '/judge', body: { enabled: false } });
    });
    fireEvent.click(
      screen.getByRole('switch', { name: 'Skip review for small, well-tested changes' }),
    );
    await waitFor(() => {
      expect(sent).toContainEqual({
        method: 'PATCH',
        path: '/judge',
        body: { decisions: { review_size: { enabled: false } } },
      });
    });
  });

  it('sends a changed model and floor', async () => {
    const { sent } = open();
    const model = await screen.findByLabelText('Model');
    expect(model).toHaveProperty('value', 'typesafe/jev-1.13');
    fireEvent.change(model, { target: { value: 'other/model' } });
    fireEvent.blur(model);
    await waitFor(() => {
      expect(sent).toContainEqual({
        method: 'PATCH',
        path: '/judge',
        body: { decisions: { review_size: { model: 'other/model' } } },
      });
    });
    const floor = screen.getByLabelText('Confidence needed');
    expect(floor).toHaveProperty('value', '0.8');
    fireEvent.change(floor, { target: { value: '0.9' } });
    fireEvent.blur(floor);
    await waitFor(() => {
      expect(sent).toContainEqual({
        method: 'PATCH',
        path: '/judge',
        body: { decisions: { review_size: { floor: 0.9 } } },
      });
    });
  });

  it('says the daemon runs with the judge off and disables the controls', async () => {
    open({ status: judgeStatusDto({ off: true, keySet: true }) });
    expect(await screen.findByText(/TENDB_JUDGE=off/)).toBeTruthy();
    expect(
      screen.getByRole('switch', { name: 'Use fast models for routine decisions' }),
    ).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Test Connection' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByRole('button', { name: 'Replace Key' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Remove Key' })).toHaveProperty('disabled', true);
    expect(screen.getByLabelText('OpenRouter key')).toHaveProperty('disabled', true);
  });

  it('lists recent calls with their outcome and a link to the task', async () => {
    const taskId = mintId('Task');
    open({
      calls: [
        judgeCallDto({ taskId, outcome: 'acted', answer: 'skip', confidence: 0.93 }),
        judgeCallDto({ outcome: 'fallback_timeout', answer: null, confidence: null }),
      ],
    });
    const list = await screen.findByRole('list', { name: 'Recent decisions' });
    const [first, second, ...rest] = within(list).getAllByRole('listitem');
    if (!first || !second) throw new Error('expected two rows');
    expect(rest).toHaveLength(0);
    expect(within(first).getByText(/skip.*0\.93/)).toBeTruthy();
    expect(within(first).getByText('Skipped the review')).toBeTruthy();
    expect(
      within(first).getByRole('link', { name: 'Open on the board' }).getAttribute('href'),
    ).toBe(`/board?task=${taskId}`);
    expect(within(second).getByText('Timed out; the review ran')).toBeTruthy();
    expect(within(second).queryByRole('link')).toBeNull();
  });

  it.each([
    ['skip acted on', 'acted', 'skip', 'Skipped the review'],
    ['review acted on', 'acted', 'review', 'Ran the review (model said review)'],
    ['skip below the floor', 'below_floor', 'skip', 'Not sure enough; the review ran'],
    ['no answer, decisions off', 'fallback_off', null, 'Decisions were off; the review ran'],
    ['no answer, no key', 'fallback_no_key', null, 'No key; the review ran'],
    ['no answer, error', 'fallback_error', null, 'The call failed; the review ran'],
    ['cut short by a cancel or a shutdown', 'stopped', null, 'Stopped before it answered'],
  ] as const)(
    'says what 10db did from the answer and the outcome together: %s',
    async (_name, outcome, answer, text) => {
      open({
        calls: [judgeCallDto({ outcome, answer, confidence: answer === null ? null : 0.9 })],
      });
      const list = await screen.findByRole('list', { name: 'Recent decisions' });
      expect(within(list).getByText(text)).toBeTruthy();
    },
  );

  it('says when there are no decisions yet', async () => {
    open();
    expect(await screen.findByText('No decisions yet.')).toBeTruthy();
  });
});

describe('Settings › Decisions › Shape (spec §8, §9)', () => {
  it('shows the Sizing hit rate with n, per bucket, and overrides beside it', async () => {
    open({
      measures: shapeMeasuresDto({
        sizing: {
          n: 5,
          within: 4,
          buckets: {
            S: { n: 2, within: 2 },
            M: { n: 3, within: 2 },
            L: { n: 0, within: 0 },
            XL: { n: 0, within: 0 },
          },
          overrides: 1,
        },
      }),
    });
    const sizing = await screen.findByRole('group', { name: 'Sizing' });
    expect(sizing.textContent).toContain('80% within one bucket (4 of 5)');
    expect(sizing.textContent).toContain('S 2 of 2');
    expect(sizing.textContent).toContain('M 2 of 3');
    expect(sizing.textContent).toContain('1 set by you, not counted');
  });

  it('says Sizing has nothing to measure until a converted task finishes', async () => {
    open();
    const sizing = await screen.findByRole('group', { name: 'Sizing' });
    expect(sizing.textContent).toContain('No converted task has finished yet');
  });

  it("shows Inbox question cards per converted task against the project's other tasks (spec §7)", async () => {
    open({
      measures: shapeMeasuresDto({
        questions: { converted: { tasks: 4, cards: 2 }, other: { tasks: 10, cards: 9 } },
      }),
    });
    const questions = await screen.findByRole('group', { name: 'Questions' });
    expect(questions.textContent).toContain('0.5 question cards per task (4 tasks) converted');
    expect(questions.textContent).toContain(
      "0.9 question cards per task (10 tasks) for the project's other tasks",
    );
  });

  it('says Questions has nothing to measure until a converted task starts', async () => {
    open();
    const questions = await screen.findByRole('group', { name: 'Questions' });
    expect(questions.textContent).toContain('No converted task has started yet');
  });

  it("shows each Shape decision's shadow agreement, and sends its switch", async () => {
    const { sent } = open({
      measures: shapeMeasuresDto({
        shadow: [
          { decision: 'shape_ready', answered: 3, scored: 2, agreed: 1, canShow: false },
          { decision: 'shape_record', answered: 25, scored: 20, agreed: 18, canShow: true },
          { decision: 'shape_elsewhere', answered: 0, scored: 0, agreed: 0, canShow: false },
        ],
      }),
    });
    const record = await screen.findByRole('group', { name: 'Record as a decision?' });
    expect(record.textContent).toContain('In shadow: 18 of 20 scored answers agreed (90%)');
    expect(record.textContent).toContain('Ready to show');
    const ready = screen.getByRole('group', { name: 'Enough to propose' });
    expect(ready.textContent).toContain('1 of 2 scored answers agreed (50%)');
    const elsewhere = screen.getByRole('group', { name: 'Question for someone else?' });
    expect(elsewhere.textContent).toContain('No scored answers yet');
    fireEvent.click(within(record).getByRole('switch'));
    await waitFor(() => {
      expect(sent).toContainEqual({
        method: 'PATCH',
        path: '/judge',
        body: { decisions: { shape_record: { enabled: false } } },
      });
    });
  });
});
