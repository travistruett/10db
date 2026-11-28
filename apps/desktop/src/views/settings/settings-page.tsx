import type { ProjectDto } from '@10db/contracts';
import { Box } from '@mantine/core';
import type { ReactNode } from 'react';
import type { GuideOpener } from '../../shell/page-guide';
import { GuideLink, PageIntro } from '../../shell/page-intro';
import { ScopeBadge } from '../../shell/scope-badge';
import { TitleRow } from '../../shell/title-row';
import { SECTION_BYLINES } from './section-bylines';
import { sectionByKey, SettingsScope, type SettingsSectionKey } from './sections';

/**
 * One Settings page's header: the title row holds only the section's name and, on a This Project page, the project's
 * badge (the frame adds its own indicators); in the content, one `PageIntro` with the page's byline, the link to its
 * guide, its tabs and its controls. It is the first thing a page draws, before its data is read, since it is static
 * copy. No page control goes in the title row, and nothing in the content repeats the title.
 */
export function SettingsPageHeader({
  sectionKey,
  project,
  byline,
  guide,
  tabs,
  actions,
}: {
  readonly sectionKey: SettingsSectionKey;
  /** The project a This Project page shows, for its badge. */
  readonly project?: ProjectDto | null;
  /** A line other than the page's own in `SECTION_BYLINES`. */
  readonly byline?: ReactNode;
  readonly guide?: GuideOpener;
  /** The page's `PageTabs`. */
  readonly tabs?: ReactNode;
  /** Page-level selects, then utilities, then the page's one primary action. */
  readonly actions?: ReactNode;
}) {
  const section = sectionByKey(sectionKey);
  const line = byline ?? SECTION_BYLINES[sectionKey];
  return (
    <>
      <TitleRow
        title={section.label}
        meta={
          section.scope === SettingsScope.App ||
          project === undefined ||
          project === null ? undefined : (
            <ScopeBadge name={project.name} />
          )
        }
      />
      <Box mb="xs">
        <PageIntro
          {...(line === undefined ? {} : { description: line })}
          {...(guide === undefined
            ? {}
            : { guide: <GuideLink onOpen={guide.onOpen}>{guide.label}</GuideLink> })}
          {...(tabs === undefined ? {} : { tabs })}
          {...(actions === undefined ? {} : { actions })}
        />
      </Box>
    </>
  );
}
