import { describe, expect, it } from 'vitest';
import { InboxItemDto } from './entities';
import { mintId } from './ids';
import { PushPayload, pushPayloadOf } from './push';
import { InboxKind, InboxState, QuestionCategory, Urgency } from './states';

function card(overrides: Record<string, unknown> = {}): InboxItemDto {
  return InboxItemDto.parse({
    id: mintId('InboxItem'),
    projectId: mintId('Project'),
    kind: InboxKind.Permission,
    state: InboxState.Open,
    title: 'Allow npm install?',
    body: 'SECRET body: the command is `curl https://example.com/?token=abc`',
    options: [{ label: 'Allow once', description: 'rm -rf /home/travis/private' }],
    recommendation: 'Allow once',
    category: QuestionCategory.Engineering,
    urgency: Urgency.Normal,
    assignee: 'me',
    detail: { path: '/Users/travis/secret/project' },
    answer: null,
    targets: [],
    createdAt: '2026-11-25T10:00:00.000Z',
    updatedAt: '2026-11-25T10:00:00.000Z',
    ...overrides,
  });
}

describe('pushPayloadOf', () => {
  it('holds only the kind, the headline and the id: a lock screen is public', () => {
    const item = card();
    const payload = pushPayloadOf(item);
    expect(payload).toEqual({
      kind: InboxKind.Permission,
      headline: 'Allow npm install?',
      inboxItemId: item.id,
    });
    expect(Object.keys(PushPayload.parse(payload)).sort()).toEqual([
      'headline',
      'inboxItemId',
      'kind',
    ]);
    expect(JSON.stringify(payload)).not.toMatch(/SECRET|rm -rf|\/Users|token/);
  });
});
