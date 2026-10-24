import { describe, expect, it } from 'vitest';
import { createStartGate } from './index';

describe('the start gate', () => {
  it('lets one start through per key, in order, and keys apart', async () => {
    const gate = createStartGate();
    const order: string[] = [];
    const first = await gate.acquire('a');
    const second = gate.acquire('a').then((release) => {
      order.push('second');
      return release;
    });
    const other = await gate.acquire('b');
    order.push('other');
    expect(gate.waiting('a')).toBe(1);
    order.push('first done');
    first();
    first();
    (await second)();
    other();
    expect(order).toEqual(['other', 'first done', 'second']);
    expect(gate.waiting('a')).toBe(0);
  });
});
