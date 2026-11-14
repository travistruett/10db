import { PlaybookMoveEntry } from '@10db/contracts';
import {
  deleteKind,
  getAppSetting,
  getProject,
  insertKind,
  listKinds,
  moveKind,
  patchKind,
  setAppSetting,
  setPlaybook,
} from '@10db/db';
import type { ApiServices } from '../api';
import type { StateStore } from '../events';
import { playbookView } from '../routing';
import { PLAYBOOK_MOVE_REPORT_KEY, playbookInputs } from '../team';

/** The playbook, the kinds and the move's report as the HTTP API reads and writes them. */
export type PlaybookApiServices = Pick<
  ApiServices,
  | 'getPlaybook'
  | 'setPlaybook'
  | 'playbookMoveReport'
  | 'dismissPlaybookMoveReport'
  | 'listKinds'
  | 'createKind'
  | 'patchKind'
  | 'deleteKind'
  | 'moveKind'
>;

export function createPlaybookServices(state: StateStore): PlaybookApiServices {
  return {
    getPlaybook(projectId) {
      // A missing project is a 404, not the global playbook.
      if (projectId !== null) getProject(state.db, projectId);
      return playbookView(playbookInputs(state.db, projectId).playbook);
    },
    setPlaybook: (projectId, input) =>
      state.write((ctx) => {
        setPlaybook(ctx, projectId, input);
        return playbookView(playbookInputs(ctx.tx, projectId).playbook);
      }),
    playbookMoveReport: () =>
      // Parsed on the way out of the settings table; a start before the move left none.
      PlaybookMoveEntry.array().parse(getAppSetting(state.db, PLAYBOOK_MOVE_REPORT_KEY) ?? []),
    dismissPlaybookMoveReport() {
      state.write((ctx) => {
        setAppSetting(ctx, PLAYBOOK_MOVE_REPORT_KEY, []);
      });
    },
    listKinds: () => listKinds(state.db),
    createKind: (input) => state.write((ctx) => insertKind(ctx, input)),
    patchKind: (id, patch) => state.write((ctx) => patchKind(ctx, id, patch)),
    deleteKind(id) {
      state.write((ctx) => {
        deleteKind(ctx, id);
      });
    },
    moveKind: (input) => state.write((ctx) => moveKind(ctx, input.kindId, input.position)),
  };
}
