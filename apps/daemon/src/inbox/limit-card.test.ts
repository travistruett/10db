import type { LimitName } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { limitCardTitle, LIMIT_OPTIONS } from './limit-card';

describe('limitCardTitle', () => {
  it.each<[LimitName | null, string]>([
    ['destroys_data', "Allow this? It may destroy data this session didn't create"],
    ['sends_data_out', 'Allow this? It may send data out'],
    ['reads_secrets', 'Allow this? It may read secrets'],
    ['writes_live', 'Allow this? It may write to a live system'],
    [null, "Allow this? 10db's judge wasn't sure it is safe"],
  ])('%s reads %s', (limit, title) => {
    expect(limitCardTitle({ limit, reason: 'r' })).toBe(title);
  });
});

describe('LIMIT_OPTIONS', () => {
  it('are allow once, always in this project and deny, in order', () => {
    expect(LIMIT_OPTIONS.map((o) => o.label)).toEqual(['allow_once', 'always_in_project', 'deny']);
  });
});
