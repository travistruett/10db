import { PageGuide, type PageGuideHandle } from '../../shell/page-guide';
import { HelpHint, type HelpOption } from './help-hint';
import {
  ChangedFilePicture,
  FoldChip,
  ForYouPicture,
  LookCardPicture,
  LookChip,
} from './watchpoint-pictures';

export const WATCHPOINTS_GUIDE = 'How watchpoints work';

/** Where a watchpoints page sits: yours, for every project, or one project's. */
export type WatchpointsScope = { readonly project: string } | null;

/** How watchpoints work, opened from the page's byline, its empty state and the When It Matches card. */
export function WatchpointsGuide({
  guide,
  scope,
  onAdd,
}: {
  readonly guide: PageGuideHandle;
  readonly scope: WatchpointsScope;
  /** Offered while the page has no watchpoints. */
  readonly onAdd?: () => void;
}) {
  return (
    <PageGuide
      guide={guide}
      lead="Name the files you want to judge yourself. When a task changes one, 10db shows you just that change, with the agent's reason and the reviewer's check."
      steps={[
        {
          title: 'A watched file changes',
          caption: 'In any task, a change to a file its paths match.',
          picture: <ChangedFilePicture />,
        },
        {
          title: 'You see it in For You',
          caption: "The task's For You and its pull request show just that change, and why.",
          picture: <ForYouPicture />,
        },
        {
          title: 'Ask also asks you',
          caption: 'One Look card per task. The task never waits for your answer.',
          picture: <LookCardPicture />,
        },
      ]}
      scope={
        scope === null ? (
          'Yours apply in every project. A project can turn one off, or add its own.'
        ) : (
          <>
            {'Yours apply in every project. One set here changes only '}
            <span style={{ whiteSpace: 'nowrap' }}>{scope.project}</span>.
          </>
        )
      }
      {...(onAdd === undefined ? {} : { action: { label: 'Add Watchpoint', onClick: onAdd } })}
    />
  );
}

const SHOW: HelpOption = {
  label: 'Show',
  line: "The change waits in the task's For You and its pull request.",
  picture: <FoldChip loudness="Show" />,
};

const ASK: HelpOption = {
  label: 'Ask',
  line: 'Show, and one Look card in the Inbox for each task.',
  picture: <LookChip />,
};

/** The When It Matches column's card: every option the control offers, and what each does. */
export function WhenItMatchesHelp({
  guide,
  scope,
}: {
  readonly guide: PageGuideHandle;
  readonly scope: WatchpointsScope;
}) {
  return (
    <HelpHint
      label="When It Matches"
      title="When It Matches"
      options={
        scope === null
          ? [SHOW, ASK]
          : [
              {
                label: 'Default',
                line: 'Uses your All Projects choice, shown after Default.',
              },
              SHOW,
              ASK,
              { label: 'Off', line: `Not watched in ${scope.project}.` },
            ]
      }
      guide={guide.opener}
    />
  );
}
