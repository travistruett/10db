import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  localStorage.clear();
  vi.resetModules();
});

describe('session drafts', () => {
  it('keeps a chat’s text and mentions across a restart and drops its pictures', async () => {
    const first = await import('./session-drafts');
    first.sessionDrafts.set(first.draftKey.chat('chat_a'), {
      text: 'Look at @src/a.ts',
      mentions: ['src/a.ts'],
      pictures: [new File(['x'], 'p.png')],
    });
    vi.resetModules();
    const second = await import('./session-drafts');
    expect(second.sessionDrafts.get(second.draftKey.chat('chat_a'))).toEqual({
      text: 'Look at @src/a.ts',
      mentions: ['src/a.ts'],
      pictures: [],
    });
  });

  it('keeps nothing of a fresh tab, and nothing once the draft is cleared', async () => {
    const first = await import('./session-drafts');
    first.sessionDrafts.set(first.draftKey.fresh('f1'), { text: 'x', mentions: [], pictures: [] });
    first.sessionDrafts.set(first.draftKey.chat('c1'), { text: 'y', mentions: [], pictures: [] });
    first.sessionDrafts.set(first.draftKey.chat('c1'), { text: '', mentions: [], pictures: [] });
    vi.resetModules();
    const second = await import('./session-drafts');
    expect(second.sessionDrafts.get(second.draftKey.fresh('f1')).text).toBe('');
    expect(second.sessionDrafts.get(second.draftKey.chat('c1')).text).toBe('');
  });
});
