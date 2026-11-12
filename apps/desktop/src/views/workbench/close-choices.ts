import {
  PassClosePageChoice,
  PassSignOff,
  type PassCloseRequest,
  type PassClosePreviewDto,
  type PassPageDto,
  type SharedChoiceKind,
  type TaskId,
} from '@10db/contracts';
import { sharedChoicesOf } from './shared-choices';

// Workbench spec §5.4: what Close Pass sends for the lists it showed. Every loose end has a safe
// default: an unfinished page is taken out, a file no page owns is left out, a shared change is kept.

/** What the builder chose in the close modal; anything not chosen takes its default. */
export interface CloseChoices {
  readonly pages: ReadonlyMap<TaskId, PassClosePageChoice>;
  /** A file no page owns, by path: the page it is added to, or null to leave it out. */
  readonly files: ReadonlyMap<string, TaskId | null>;
  readonly shared: ReadonlyMap<number, SharedChoiceKind>;
}

export const NO_CLOSE_CHOICES: CloseChoices = {
  pages: new Map(),
  files: new Map(),
  shared: new Map(),
};

/** An unfinished page's choice: Take Out unless the builder chose Sign Off Now. */
export function pageChoice(choices: CloseChoices, taskId: TaskId): PassClosePageChoice {
  return choices.pages.get(taskId) ?? PassClosePageChoice.TakeOut;
}

/** A page a file can be added to: one that lands, signed off already or set to Sign Off Now. */
export interface LandingPage {
  readonly taskId: TaskId;
  readonly area: string;
}

export function landingPages(
  preview: PassClosePreviewDto,
  pages: readonly PassPageDto[],
  choices: CloseChoices,
): LandingPage[] {
  const unfinished = new Set(preview.unfinished.map((page) => page.taskId));
  return pages
    .filter((page) =>
      unfinished.has(page.taskId)
        ? pageChoice(choices, page.taskId) === PassClosePageChoice.SignOff
        : page.signOff === PassSignOff.Done,
    )
    .map((page) => ({ taskId: page.taskId, area: page.area }));
}

/** Where a file goes: the page chosen while that page lands, else left out. */
export function placement(
  landing: readonly LandingPage[],
  choices: CloseChoices,
  path: string,
): TaskId | null {
  const chosen = choices.files.get(path) ?? null;
  return landing.some((page) => page.taskId === chosen) ? chosen : null;
}

/** The close as confirmed: every list item of `preview` with its choice, and the preview's token. */
export function closeRequest(
  preview: PassClosePreviewDto,
  pages: readonly PassPageDto[],
  choices: CloseChoices,
): PassCloseRequest {
  const landing = landingPages(preview, pages, choices);
  return {
    token: preview.token,
    pages: preview.unfinished.map((page) => ({
      taskId: page.taskId,
      choice: pageChoice(choices, page.taskId),
    })),
    files: preview.unowned.map((file) => ({
      path: file.path,
      placeIn: placement(landing, choices, file.path),
    })),
    // A page signed off now lands its shared changes; only a page taken out keeps or drops them.
    shared: preview.unfinished
      .filter((page) => pageChoice(choices, page.taskId) === PassClosePageChoice.TakeOut)
      .flatMap((page) => sharedChoicesOf(page.sharedUnlanded, choices.shared)),
  };
}
