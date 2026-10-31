import { mintId } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp } from '../../test/daemon';
import { judgeCallDto, judgeStatusDto, serveJudge } from '../../test/judge-fixtures';

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
    ).toBe('/board');
    expect(within(second).getByText('Timed out; the review ran')).toBeTruthy();
    expect(within(second).queryByRole('link')).toBeNull();
  });

  it('says when there are no decisions yet', async () => {
    open();
    expect(await screen.findByText('No decisions yet.')).toBeTruthy();
  });
});
