import { PersonInput } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { uniqueHandle } from './person-handle';

describe('uniqueHandle', () => {
  const rows: readonly { name: string; taken: string[]; handle: string }[] = [
    { name: 'Mark Ellis', taken: [], handle: 'mark-ellis' },
    { name: '  Ana  Ortiz ', taken: [], handle: 'ana-ortiz' },
    { name: 'Mark Ellis', taken: ['mark-ellis'], handle: 'mark-ellis-2' },
    { name: 'Mark Ellis', taken: ['mark-ellis', 'mark-ellis-2'], handle: 'mark-ellis-3' },
    { name: '3D Team', taken: [], handle: 'p-3d-team' },
    { name: 'Zoë', taken: [], handle: 'zo' },
    { name: '李', taken: [], handle: 'p' },
    { name: 'a'.repeat(60), taken: ['a'.repeat(40)], handle: `${'a'.repeat(38)}-2` },
  ];
  it.each(rows)('$name with $taken taken is $handle', ({ name, taken, handle }) => {
    const made = uniqueHandle(name, new Set(taken));
    expect(made).toBe(handle);
    // The daemon takes only what the contract's key allows.
    expect(PersonInput.shape.handle.safeParse(made).success).toBe(true);
  });
});
