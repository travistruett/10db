import type { DecisionItem } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { projectViewDto } from '../../test/fixtures';
import { decisionItem, knowledgePage } from '../../test/knowledge-fixtures';

const project = projectViewDto({ areas: [{ name: 'api', globs: ['src/api/**'] }] });

const DecisionBody = z.object({ question: z.string(), choice: z.string(), rationale: z.string() });

/** Opens a Select inside `scope` by its label and picks an option. */
async function choose(scope: HTMLElement, label: string, option: string) {
  const input = within(scope).getByLabelText(label);
  fireEvent.click(input);
  const id = input.getAttribute('aria-controls');
  const list = await waitFor(() => {
    const el = id === null ? null : document.getElementById(id);
    expect(el).not.toBeNull();
    return el ?? document.body;
  });
  fireEvent.click(within(list).getByRole('option', { name: option, hidden: true }));
}

describe('recording', () => {
  it('records a decision at a chosen area, and shows it in the list at once', async () => {
    let decisions: DecisionItem[] = [];
    const posted: { path: string; body: unknown }[] = [];
    server.use(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/projects/:projectId/knowledge'), ({ request }) => {
        const params = new URL(request.url).searchParams;
        return HttpResponse.json(
          knowledgePage(params.get('kind') === 'decision' ? decisions : [], params),
        );
      }),
      http.get(daemonUrl('/projects/:projectId/proposals'), () => HttpResponse.json([])),
      http.post(daemonUrl('/projects/:projectId/decisions'), async ({ request }) => {
        const body: unknown = await request.json();
        posted.push({ path: new URL(request.url).pathname, body });
        const created = decisionItem({ ...DecisionBody.parse(body), scope: 'area', area: 'api' });
        decisions = [created, ...decisions];
        return HttpResponse.json(created, { status: 201 });
      }),
      ...baseHandlers(),
    );
    renderApp('/knowledge');
    fireEvent.click(await screen.findByRole('tab', { name: 'Decisions' }));
    fireEvent.click(await screen.findByRole('button', { name: 'New Decision' }));
    const dialog = await screen.findByRole('dialog', { name: 'New Decision' });
    fireEvent.change(within(dialog).getByLabelText('Question'), {
      target: { value: 'Which router?' },
    });
    fireEvent.change(within(dialog).getByLabelText('Choice'), { target: { value: 'Hono' } });
    fireEvent.change(within(dialog).getByLabelText('Rationale'), {
      target: { value: 'Typed client' },
    });
    await choose(dialog, 'Applies To', 'Only in api');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Record' }));
    await waitFor(() => {
      expect(posted).toEqual([
        {
          path: `/projects/${project.id}/decisions`,
          body: {
            scope: 'area',
            area: 'api',
            question: 'Which router?',
            choice: 'Hono',
            rationale: 'Typed client',
          },
        },
      ]);
    });
    expect(await screen.findByText('Which router?')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'New Decision' })).toBeNull();
  });
});
