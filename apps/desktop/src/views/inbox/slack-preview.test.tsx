import { mintId } from '@10db/contracts';
import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { inboxItemDto } from '../../test/fixtures';
import { findText, getText, serveOpenRows } from '../../test/inbox-page-fixtures';
import { BUILDER_PERSON, personDto, sendDto, slackContact } from '../../test/people-fixtures';

const mark = personDto({ name: 'Mark', handle: 'mark', slack: [slackContact('U1')] });

describe('a card with a draft', () => {
  it('opens on what Mark will get, with the draft text, and not on the options', async () => {
    const id = mintId('InboxItem');
    const item = inboxItemDto({
      id,
      title: 'How long should access last?',
      body: 'The spec is silent.',
      options: [
        { label: 'Keep access for 7 days', description: '' },
        { label: 'Cut access at once', description: '' },
      ],
      category: 'product',
      routedBy: 'rule',
      assignees: ['mark'],
      send: sendDto({
        inboxItemId: id,
        people: [{ personId: mark.id, userId: 'U1', name: 'Mark', recipient: true }],
        text: 'Travis asks: how long?',
      }),
    });
    server.use(
      http.get(daemonUrl('/inbox'), () => HttpResponse.json([item])),
      http.get(daemonUrl('/people'), () => HttpResponse.json([BUILDER_PERSON, mark])),
      ...baseHandlers(),
    );
    serveOpenRows(() => [item]);
    renderApp('/inbox');
    expect(await findText('Mark will get')).toBeTruthy();
    expect(getText(/Travis asks: how long\?/)).toBeTruthy();
    expect(screen.queryByRole('radio', { name: /Keep access for 7 days/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Send to Mark/ })).toBeTruthy();
  });
});
