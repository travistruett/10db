import { describe, expect, it } from 'vitest';
import { fillTemplate, type PrSection } from './pr-template';

const what: PrSection = { heading: 'What', text: 'w' };
const how: PrSection = { heading: 'How', text: 'h' };

describe('fillTemplate', () => {
  it.each<{
    name: string;
    template: string | null;
    sections: readonly PrSection[];
    expected: string;
  }>([
    {
      name: 'no template: the sections in the order given',
      template: null,
      sections: [what, how],
      expected: '## What\n\nw\n\n## How\n\nh',
    },
    {
      name: 'an empty template: the sections in the order given',
      template: '',
      sections: [what],
      expected: '## What\n\nw',
    },
    {
      name: 'a template section a section fills is replaced, its comment placeholder with it',
      template: '## What\n\n<!-- hint -->\n\n## Checklist\n\n- [ ] x\n',
      sections: [what],
      expected: '## What\n\nw\n\n## Checklist\n\n- [ ] x',
    },
    {
      name: 'a template section no section fills stays as written',
      template: '## Checklist\n\n- [ ] x\n\n<!-- keep -->\n',
      sections: [what],
      expected: '## Checklist\n\n- [ ] x\n\n<!-- keep -->\n\n## What\n\nw',
    },
    {
      name: 'sections keep the template order; the ones the template lacks follow it',
      template: '## Checklist\n\n- [ ] x\n\n## What\n\n<!-- -->\n',
      sections: [what, how],
      expected: '## Checklist\n\n- [ ] x\n\n## What\n\nw\n\n## How\n\nh',
    },
    {
      name: 'a heading matches ignoring case and spaces, and keeps the template spelling',
      template: '## what \n\nold\n',
      sections: [what],
      expected: '## what\n\nw',
    },
    {
      name: 'text before the first heading is kept',
      template: 'Intro line\n\n## What\n\nold\n',
      sections: [what],
      expected: 'Intro line\n\n## What\n\nw',
    },
    {
      name: 'a subsection of a filled section goes with it',
      template: '## What\n\n### Context\n\nold\n\n## Checklist\n\n- [ ] x',
      sections: [what],
      expected: '## What\n\nw\n\n## Checklist\n\n- [ ] x',
    },
    {
      name: 'a ### heading is not a section, so it does not fill one',
      template: '### What\n\nkeep\n',
      sections: [what],
      expected: '### What\n\nkeep\n\n## What\n\nw',
    },
  ])('$name', ({ template, sections, expected }) => {
    expect(fillTemplate(template, sections)).toBe(expected);
  });
});
