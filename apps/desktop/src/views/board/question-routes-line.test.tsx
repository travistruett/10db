import type { QuestionRouteDto } from '@10db/contracts';
import { act, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderWithDaemonAndRouter, server } from '../../test/daemon';
import { taskDto } from '../../test/fixtures';
import { personDto, slackContact } from '../../test/people-fixtures';
import { QuestionRoutesLine } from './question-routes-line';

const mark = personDto({ name: 'Mark Ellis', handle: 'mark', slack: slackContact('U1') });
const ana = personDto({ name: 'Ana Ortiz', handle: 'ana', slack: slackContact('U2') });
const task = taskDto();

function route(over: Partial<QuestionRouteDto>): QuestionRouteDto {
  return { category: 'product', topic: null, people: [mark], from: 'goal', ...over };
}

async function show(routes: QuestionRouteDto[]) {
  let asked = false;
  server.use(
    http.get(daemonUrl('/tasks/:taskId/question-routes'), () => {
      asked = true;
      return HttpResponse.json(routes);
    }),
    ...baseHandlers(),
  );
  await renderWithDaemonAndRouter(<QuestionRoutesLine task={task} />);
  await waitFor(() => {
    expect(asked).toBe(true);
  });
}

describe('QuestionRoutesLine', () => {
  it.each([
    [
      'one person for two categories, from the goal',
      [route({}), route({ category: 'design' })],
      'Questions go to Mark Ellis (product, design), from the goal',
    ],
    [
      'a tie',
      [route({ people: [mark, ana], from: 'project' })],
      'Questions go to Mark Ellis and Ana Ortiz (product), from the project',
    ],
    [
      'a task route and a project route',
      [route({ from: 'task' }), route({ category: 'design', people: [ana], from: 'project' })],
      'Questions go to Mark Ellis (product), from this task; Ana Ortiz (design), from the project',
    ],
    [
      'a topic',
      [route({ category: null, topic: 'billing', from: 'topic' })],
      'Questions go to Mark Ellis (billing), from a topic',
    ],
  ])('%s', async (_name, routes, text) => {
    await show(routes);
    expect(await screen.findByText(text)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Change' }).getAttribute('href')).toBe(
      '/settings/routing-rules',
    );
  });

  it('says nothing when every question comes to the builder', async () => {
    await show([]);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole('link', { name: 'Change' })).toBeNull();
  });
});
