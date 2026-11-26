import { describe, expect, it } from 'vitest';
import { InboxItemDto } from './entities';
import { mintId } from './ids';
import { PushPayload, PushSubscriptionInput, isPushServiceEndpoint, pushPayloadOf } from './push';
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

describe('isPushServiceEndpoint', () => {
  it('lets the daemon post only to a push service over https, never to an address a device names', () => {
    const allowed = [
      'https://fcm.googleapis.com/fcm/send/abc',
      'https://fcm.googleapis.com:443/wp/abc',
      'https://updates.push.services.mozilla.com/wpush/v2/abc',
      'https://web.push.apple.com/abc',
      'https://wns2-par02p.notify.windows.com/w/?token=abc',
    ];
    const refused = [
      'http://fcm.googleapis.com/fcm/send/abc',
      'https://fcm.googleapis.com:8443/abc',
      'https://127.0.0.1/abc',
      'https://localhost/abc',
      'https://192.168.1.10/abc',
      'https://[::1]/abc',
      'https://fcm.googleapis.com.evil.example/abc',
      'https://evilfcm.googleapis.com/abc',
      'https://evilpush.apple.com/abc',
      'https://user:pw@fcm.googleapis.com/abc',
      'https://fcm.googleapis.com@127.0.0.1/abc',
    ];
    for (const endpoint of allowed) expect(isPushServiceEndpoint(endpoint), endpoint).toBe(true);
    for (const endpoint of refused) expect(isPushServiceEndpoint(endpoint), endpoint).toBe(false);
    expect(
      PushSubscriptionInput.safeParse({ endpoint: 'https://127.0.0.1/x', p256dh: 'a', auth: 'b' })
        .success,
    ).toBe(false);
  });
});
