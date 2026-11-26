import { mintId } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { mintDeviceToken, parseDeviceToken, secretMatches } from './tokens';

describe('device tokens', () => {
  it('round-trips 200 tokens and rejects a changed secret, another id or a bad shape', () => {
    for (let i = 0; i < 200; i += 1) {
      const id = mintId('Device');
      const { token, tokenHash } = mintDeviceToken(id);
      const parsed = parseDeviceToken(token);
      expect(parsed?.deviceId).toBe(id);
      expect(secretMatches(parsed?.secret ?? '', tokenHash)).toBe(true);

      const last = token.endsWith('A') ? 'B' : 'A';
      const changed = parseDeviceToken(`${token.slice(0, -1)}${last}`);
      expect(secretMatches(changed?.secret ?? '', tokenHash)).toBe(false);

      const other = parseDeviceToken(token.replace(id, mintId('Device')));
      expect(other?.deviceId).not.toBe(id);
    }
    const { token } = mintDeviceToken(mintId('Device'));
    for (const bad of [
      '',
      'tdb_',
      token.slice(1),
      token.slice(0, -1),
      `${token}x`,
      token.replace('tdb_dev_', 'tdb_dex_'),
    ]) {
      expect(parseDeviceToken(bad)).toBeNull();
    }
  });
});
