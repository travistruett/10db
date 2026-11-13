import { mintId, RoutingRulesInput, type RoutingRuleDto } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { pickOption } from '../../test/combobox';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { goalSummaryDto } from '../../test/goal-fixtures';
import { projectDto, taskDto } from '../../test/fixtures';
import { judgeStatusDto } from '../../test/judge-fixtures';
import { BUILDER_PERSON, personDto, slackContact } from '../../test/people-fixtures';

const project = projectDto();
const mark = personDto({ name: 'Mark Ellis', handle: 'mark', slack: slackContact('U1') });
const ana = personDto({ name: 'Ana Ortiz', handle: 'ana', slack: slackContact('U2') });
const sarah = personDto({ name: 'Sarah Kim', handle: 'sarah', slack: slackContact('U3') });
const goal = goalSummaryDto({ title: 'Renewals' });
const task = taskDto({ title: 'Receipt email copy', projectId: project.id });
const AT = '2026-10-13T12:00:00.000Z';

function rule(
  over: Partial<RoutingRuleDto> & { personId: RoutingRuleDto['personId'] },
): RoutingRuleDto {
  return {
    id: mintId('RoutingRule'),
    projectId: project.id,
    category: null,
    topic: null,
    goalId: null,
    taskId: null,
    area: null,
    createdAt: AT,
    updatedAt: AT,
    ...over,
  };
}

function serve(rules: RoutingRuleDto[], options: { judgeOff?: boolean } = {}) {
  const saved: RoutingRulesInput[] = [];
  let current = rules;
  server.use(
    http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
    http.get(daemonUrl('/people'), () => HttpResponse.json([BUILDER_PERSON, mark, ana, sarah])),
    http.get(daemonUrl('/projects/:projectId/routing-rules'), () => HttpResponse.json(current)),
    http.get(daemonUrl('/projects/:projectId/goals'), () =>
      HttpResponse.json({ goals: [goal], ungrouped: null }),
    ),
    http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json([task])),
    http.get(daemonUrl('/judge'), () =>
      HttpResponse.json(judgeStatusDto({ off: options.judgeOff ?? false })),
    ),
    http.put(daemonUrl('/projects/:projectId/routing-rules'), async ({ request }) => {
      const input = RoutingRulesInput.parse(await request.json());
      saved.push(input);
      current = input.rules.map((r) => rule({ ...r, personId: r.personId }));
      return HttpResponse.json(current);
    }),
    ...baseHandlers(),
  );
  renderApp('/settings/routing-rules');
  return saved;
}

describe('Settings › Who Answers', () => {
  it('says every question comes to you when there are no routes', async () => {
    serve([]);
    expect(
      await screen.findByText(
        /No routes yet, so every question comes to you\. Add one here, or use Ask Someone on a\s+question card\./,
      ),
    ).toBeTruthy();
  });

  it('groups rows by scope, joins categories and people, and ends with the builder', async () => {
    serve([
      rule({ personId: mark.id, goalId: goal.goal.id, category: 'product' }),
      rule({ personId: mark.id, goalId: goal.goal.id, category: 'design' }),
      rule({ personId: mark.id, category: 'product' }),
      rule({ personId: ana.id, category: 'product' }),
      rule({ personId: sarah.id, topic: 'billing, pricing' }),
      rule({ personId: ana.id, taskId: task.id, category: 'product' }),
      rule({ personId: mark.id, area: 'src', category: 'engineering' }),
    ]);
    const table = within(await screen.findByRole('table'));
    const rows = table
      .getAllByRole('row')
      .slice(1)
      .map((r) => r.textContent);
    expect(rows).toEqual([
      'TaskReceipt email copyProductAna Ortiz',
      'GoalRenewalsProduct, DesignMark Ellis',
      'AreasrcEngineeringMark Ellis',
      'ProjectProductMark Ellis, Ana Ortiz',
      'Topicbilling, pricingSarah Kim',
      'Everything not routedYou',
    ]);
    expect(
      screen.getByText(/A question goes to the first route that matches, most specific first/),
    ).toBeTruthy();
  });

  it('explains the fallback when the judge is off', async () => {
    serve([], { judgeOff: true });
    expect(
      await screen.findByText(/When none does, the lane's own category and topic decide\./),
    ).toBeTruthy();
  });

  it("Remove drops the row's rules and keeps the rest", async () => {
    const saved = serve([
      rule({ personId: mark.id, category: 'product' }),
      rule({ personId: sarah.id, topic: 'billing' }),
    ]);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove route for Sarah Kim' }));
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    expect(saved[0]?.rules).toEqual([
      {
        category: 'product',
        topic: null,
        goalId: null,
        taskId: null,
        area: null,
        personId: mark.id,
      },
    ]);
  });

  it('Add Route writes one row per ticked category', async () => {
    const saved = serve([]);
    fireEvent.click(await screen.findByRole('button', { name: 'Add Route' }));
    const dialog = await screen.findByRole('dialog');
    await pickOption(within(dialog).getByLabelText('Scope'), 'The whole project');
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Product/ }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Design/ }));
    await pickOption(within(dialog).getByLabelText('Person'), /Mark Ellis/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save Route' }));
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    expect(
      saved[0]?.rules.map((r) => [r.category, r.topic, r.goalId, r.taskId, r.personId]),
    ).toEqual([
      ['product', null, null, null, mark.id],
      ['design', null, null, null, mark.id],
    ]);
  });

  it('a goal scope names the goal', async () => {
    const saved = serve([]);
    fireEvent.click(await screen.findByRole('button', { name: 'Add Route' }));
    const dialog = await screen.findByRole('dialog');
    await pickOption(within(dialog).getByLabelText('Scope'), 'A goal');
    await pickOption(within(dialog).getByLabelText('Goal'), 'Renewals');
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Business/ }));
    await pickOption(within(dialog).getByLabelText('Person'), /Ana Ortiz/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save Route' }));
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    expect(saved[0]?.rules).toEqual([
      {
        category: 'business',
        topic: null,
        goalId: goal.goal.id,
        taskId: null,
        area: null,
        personId: ana.id,
      },
    ]);
  });

  it('a topic route takes words, not a goal, and is project-wide', async () => {
    const saved = serve([]);
    fireEvent.click(await screen.findByRole('button', { name: 'Add Route' }));
    const dialog = await screen.findByRole('dialog');
    await pickOption(within(dialog).getByLabelText('Scope'), 'A topic');
    expect(within(dialog).queryByLabelText('Goal')).toBeNull();
    expect(within(dialog).queryByRole('checkbox', { name: /Product/ })).toBeNull();
    fireEvent.change(within(dialog).getByLabelText("What it's about, in a few words"), {
      target: { value: 'billing, invoices' },
    });
    await pickOption(within(dialog).getByLabelText('Person'), /Sarah Kim/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save Route' }));
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    expect(saved[0]?.rules).toEqual([
      {
        category: null,
        topic: 'billing, invoices',
        goalId: null,
        taskId: null,
        area: null,
        personId: sarah.id,
      },
    ]);
  });

  it('cannot save without a person or a category', async () => {
    serve([]);
    fireEvent.click(await screen.findByRole('button', { name: 'Add Route' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Save Route' })).toHaveProperty(
      'disabled',
      true,
    );
  });
});
