import { describe, expect, it } from 'vitest';
import { ceilingStatus, CeilingMeasure } from './auto-ceiling';

const ceilings = { usd: 10, share: 0.1, sessions: 20 };
const none = { usd: 0, share: 0, unmeasured: 0 };

describe('ceilingStatus', () => {
  it.each([
    { name: 'nothing counted', spent: none, carryOns: 0, status: null },
    {
      name: 'just under every ceiling',
      spent: { usd: 9.99, share: 0.09, unmeasured: 19 },
      carryOns: 0,
      status: null,
    },
    { name: 'dollars alone', spent: { ...none, usd: 10 }, carryOns: 0, status: CeilingMeasure.Usd },
    {
      name: 'share alone',
      spent: { ...none, share: 0.1 },
      carryOns: 0,
      status: CeilingMeasure.Share,
    },
    {
      name: 'unmeasured sessions alone',
      spent: { ...none, unmeasured: 20 },
      carryOns: 0,
      status: CeilingMeasure.Sessions,
    },
    {
      name: 'dollars first when all three are reached',
      spent: { usd: 11, share: 0.2, unmeasured: 30 },
      carryOns: 0,
      status: CeilingMeasure.Usd,
    },
    {
      name: 'share before sessions',
      spent: { usd: 1, share: 0.2, unmeasured: 30 },
      carryOns: 0,
      status: CeilingMeasure.Share,
    },
    {
      name: 'a Carry On Today raises all three',
      spent: { usd: 11, share: 0.11, unmeasured: 21 },
      carryOns: 1,
      status: null,
    },
    {
      name: 'the raised dollars are reached again',
      spent: { usd: 20, share: 0.11, unmeasured: 21 },
      carryOns: 1,
      status: CeilingMeasure.Usd,
    },
    {
      name: 'the raised share is reached again',
      spent: { usd: 11, share: 0.2, unmeasured: 21 },
      carryOns: 1,
      status: CeilingMeasure.Share,
    },
    {
      name: 'the raised session count is reached again',
      spent: { usd: 11, share: 0.11, unmeasured: 40 },
      carryOns: 1,
      status: CeilingMeasure.Sessions,
    },
  ])('$name', ({ spent, carryOns, status }) => {
    expect(ceilingStatus(spent, ceilings, carryOns)).toBe(status);
  });
});
