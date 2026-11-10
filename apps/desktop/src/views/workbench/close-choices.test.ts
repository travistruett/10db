import {
  PassClosePreviewDto,
  type PassClosePageChoice,
  type PassCloseRequest,
  type SharedChoiceKind,
  type TaskId,
} from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { pagesByStatus } from '../../test/pass-fixtures';
import { closeRequest, NO_CLOSE_CHOICES, type CloseChoices } from './close-choices';

const { working, ready, notStarted } = pagesByStatus();
const signedOff = { ...notStarted, signOff: 'done' as const };
const pages = [working, ready, signedOff];

const preview = PassClosePreviewDto.parse({
  token: 'lists-1',
  unfinished: [
    {
      taskId: working.taskId,
      title: working.title,
      working: true,
      sharedUnlanded: [
        { seq: 3, paths: ['src/shared/a.ts'], dropRefusal: null, laterPages: [] },
        { seq: 4, paths: ['src/shared/b.ts'], dropRefusal: 'changed on disk', laterPages: [] },
      ],
    },
    {
      taskId: ready.taskId,
      title: ready.title,
      working: false,
      sharedUnlanded: [{ seq: 5, paths: ['src/shared/c.ts'], dropRefusal: null, laterPages: [] }],
    },
  ],
  unowned: [{ path: 'src/app.css', added: 4, removed: 1, fromBeforePass: false }],
  foreignCommits: [],
  summary: 'Lands 1 page on main.',
  gate: { where: 'scratch', consequence: null },
});

function choices(over: {
  pages?: [TaskId, PassClosePageChoice][];
  files?: [string, TaskId | null][];
  shared?: [number, SharedChoiceKind][];
}): CloseChoices {
  return {
    pages: new Map(over.pages ?? []),
    files: new Map(over.files ?? []),
    shared: new Map(over.shared ?? []),
  };
}

describe('closeRequest', () => {
  it.each<{ name: string; chosen: CloseChoices; sent: Omit<PassCloseRequest, 'token'> }>([
    {
      name: 'nothing chosen: every page taken out, the file left out, every change kept',
      chosen: NO_CLOSE_CHOICES,
      sent: {
        pages: [
          { taskId: working.taskId, choice: 'take_out' },
          { taskId: ready.taskId, choice: 'take_out' },
        ],
        files: [{ path: 'src/app.css', placeIn: null }],
        shared: [
          { seq: 3, choice: 'keep' },
          { seq: 4, choice: 'keep' },
          { seq: 5, choice: 'keep' },
        ],
      },
    },
    {
      name: 'a page signed off now takes the file, and its own changes land with it',
      chosen: choices({
        pages: [[ready.taskId, 'sign_off']],
        files: [['src/app.css', ready.taskId]],
        shared: [[5, 'drop']],
      }),
      sent: {
        pages: [
          { taskId: working.taskId, choice: 'take_out' },
          { taskId: ready.taskId, choice: 'sign_off' },
        ],
        files: [{ path: 'src/app.css', placeIn: ready.taskId }],
        shared: [
          { seq: 3, choice: 'keep' },
          { seq: 4, choice: 'keep' },
        ],
      },
    },
    {
      name: 'a file added to a page set back to Take Out is left out',
      chosen: choices({
        pages: [[ready.taskId, 'take_out']],
        files: [['src/app.css', ready.taskId]],
      }),
      sent: {
        pages: [
          { taskId: working.taskId, choice: 'take_out' },
          { taskId: ready.taskId, choice: 'take_out' },
        ],
        files: [{ path: 'src/app.css', placeIn: null }],
        shared: [
          { seq: 3, choice: 'keep' },
          { seq: 4, choice: 'keep' },
          { seq: 5, choice: 'keep' },
        ],
      },
    },
    {
      name: 'a file added to a page already signed off, and a refused Drop kept',
      chosen: choices({
        files: [['src/app.css', signedOff.taskId]],
        shared: [
          [3, 'drop'],
          [4, 'drop'],
        ],
      }),
      sent: {
        pages: [
          { taskId: working.taskId, choice: 'take_out' },
          { taskId: ready.taskId, choice: 'take_out' },
        ],
        files: [{ path: 'src/app.css', placeIn: signedOff.taskId }],
        shared: [
          { seq: 3, choice: 'drop' },
          { seq: 4, choice: 'keep' },
          { seq: 5, choice: 'keep' },
        ],
      },
    },
  ])('$name', ({ chosen, sent }) => {
    expect(closeRequest(preview, pages, chosen)).toEqual({ token: 'lists-1', ...sent });
  });
});
