import { describe, expect, it } from 'vitest';
import { handOffTo, takenHandOff } from './dev-ui-handoff';

// Decision 2026-11-11-10db-runs-the-preview-while-a-pass-is-open: Open Page hands 10db's own dev UI
// the daemon's connection in the URL's fragment, only at the dev UI origin the daemon trusts.

const CONNECTION = { url: 'http://127.0.0.1:4317', token: 'ui-token' };
const DEV_UI = 'http://localhost:1420';

describe('handOffTo', () => {
  it.each<{ name: string; page: string; devUi: string | null; handed: boolean }>([
    { name: "the dev UI's own origin", page: `${DEV_UI}/factory`, devUi: DEV_UI, handed: true },
    { name: 'another app', page: 'http://localhost:8800/people', devUi: DEV_UI, handed: false },
    {
      name: 'the same port by another name',
      page: 'http://127.0.0.1:1420/factory',
      devUi: DEV_UI,
      handed: false,
    },
    {
      name: 'a daemon that trusts no dev UI',
      page: `${DEV_UI}/factory`,
      devUi: null,
      handed: false,
    },
  ])('$name: handed $handed', ({ page, devUi, handed }) => {
    const url = handOffTo(page, devUi, CONNECTION);
    expect(url.startsWith(`${page}#`)).toBe(handed);
    if (!handed) expect(url).toBe(page);
  });

  it('round-trips through takenHandOff', () => {
    const url = new URL(handOffTo(`${DEV_UI}/factory?x=1`, DEV_UI, CONNECTION));
    expect(url.pathname + url.search).toBe('/factory?x=1');
    expect(takenHandOff(url.hash)).toEqual(CONNECTION);
  });
});

describe('takenHandOff', () => {
  it.each([
    { name: 'no fragment', hash: '' },
    { name: 'another fragment', hash: '#section' },
    { name: 'a broken one', hash: '#tendb=%7Bnot-json' },
    {
      name: 'one with no token',
      hash: `#tendb=${encodeURIComponent(JSON.stringify({ url: CONNECTION.url, token: '' }))}`,
    },
  ])('$name: none', ({ hash }) => {
    expect(takenHandOff(hash)).toBeNull();
  });
});
