import { describe, expect, it } from 'vitest';
import { kindDto } from '../../test/kind-fixtures';
import { rigorOptions } from './rigor-options';

const security = kindDto({ key: 'security', label: 'Security', minimumRigor: 'careful' });
const docs = kindDto({ key: 'docs', label: 'Docs' });

describe('rigorOptions', () => {
  const cases = [
    {
      name: 'no kinds: every rigor is open',
      kinds: [],
      disabled: [],
    },
    {
      name: 'a kind with no minimum disables nothing',
      kinds: ['docs'],
      disabled: [],
    },
    {
      name: 'a kind with a floor disables the rigors below it',
      kinds: ['security'],
      disabled: ['light', 'standard'],
    },
    {
      name: 'a key no kind has adds no floor',
      kinds: ['gone'],
      disabled: [],
    },
  ];
  it.each(cases)('$name', ({ kinds, disabled }) => {
    const options = rigorOptions([security, docs], kinds);
    expect(options.filter((o) => o.disabled).map((o) => o.value)).toEqual(disabled);
  });

  it('names the kind that sets the floor on a disabled option', () => {
    const light = rigorOptions([security, docs], ['security']).find((o) => o.value === 'light');
    expect(light?.label).toBe('Light (Security needs Careful or more)');
  });
});
