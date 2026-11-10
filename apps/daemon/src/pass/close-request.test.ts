import {
  mintId,
  PassClosePageChoice,
  SharedChoiceKind,
  type PassClosePreviewDto,
  type PassCloseRequest,
} from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { checkCloseRequest, type ClosePages } from './close-lists';

// Workbench spec §5.4 (D25): a confirmed close is refused (409) for choices its lists and its pages
// do not allow.

describe('checkCloseRequest', () => {
  const settings = mintId('Task');
  const people = mintId('Task');
  const preview: PassClosePreviewDto = {
    token: 't',
    unfinished: [
      { taskId: settings, title: 'Settings', working: false, sharedUnlanded: [] },
      {
        taskId: people,
        title: 'People',
        working: false,
        sharedUnlanded: [
          { seq: 1, paths: ['src/button.ts'], dropRefusal: null, laterPages: [] },
          { seq: 3, paths: ['src/card.ts'], dropRefusal: null, laterPages: [] },
        ],
      },
    ],
    unowned: [{ path: 'docs/new.md', added: 1, removed: 0, fromBeforePass: false }],
    foreignCommits: [],
    summary: '',
    gate: { where: 'none', consequence: null },
  };
  const pages: ClosePages = {
    signedOff: new Set(),
    needsUpTo: new Map([
      [settings, 2],
      [people, 3],
    ]),
  };
  const signSettings: PassCloseRequest['pages'] = [
    { taskId: settings, choice: PassClosePageChoice.SignOff },
    { taskId: people, choice: PassClosePageChoice.TakeOut },
  ];

  it.each([
    {
      name: 'a Drop of a change a page set to Sign Off Now was built with',
      request: {
        pages: signSettings,
        files: [],
        shared: [{ seq: 1, choice: SharedChoiceKind.Drop }],
      },
      refused: /Settings is set to Sign Off Now/,
    },
    {
      name: 'a Drop of a change past what a page set to Sign Off Now needs',
      request: {
        pages: signSettings,
        files: [],
        shared: [{ seq: 3, choice: SharedChoiceKind.Drop }],
      },
      refused: null,
    },
    {
      name: 'a file placed that is not one no page owns',
      request: {
        pages: signSettings,
        files: [{ path: 'src/people/page.tsx', placeIn: settings }],
        shared: [],
      },
      refused: /src\/people\/page.tsx is not a file no page owns/,
    },
    {
      name: 'a file no page owns placed in a page set to Sign Off Now',
      request: {
        pages: signSettings,
        files: [{ path: 'docs/new.md', placeIn: settings }],
        shared: [],
      },
      refused: null,
    },
  ])('$name', ({ request, refused }) => {
    const check = () => {
      checkCloseRequest(preview, { token: 't', ...request }, pages);
    };
    if (refused === null) expect(check).not.toThrow();
    else expect(check).toThrow(refused);
  });
});
