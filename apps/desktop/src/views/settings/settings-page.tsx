import type { ProjectDto } from '@10db/contracts';
import { Badge, Box } from '@mantine/core';
import type { ReactNode } from 'react';
import type { GuideOpener } from '../../shell/page-guide';
import { GuideLink, PageIntro } from '../../shell/page-intro';
import { ProjectTile } from '../../shell/project-tile';
import { TitleRow } from '../../shell/title-row';
import { sectionByKey, SettingsScope, type SettingsSectionKey } from './sections';

/** The project a This Project page applies to, beside its title; an All Projects page shows none. */
export function ScopeBadge({
  tile,
  children,
}: {
  readonly tile: string;
  readonly children: string;
}) {
  return (
    <Badge
      variant="light"
      color="gray"
      tt="none"
      fw={500}
      size="md"
      leftSection={<ProjectTile name={tile} size={14} />}
    >
      {children}
    </Badge>
  );
}

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
  /** One line, about 90 characters at most, on what the page is for. */
  readonly byline?: ReactNode;
  readonly guide?: GuideOpener;
  /** The page's `PageTabs`. */
  readonly tabs?: ReactNode;
  /** Page-level selects, then utilities, then the page's one primary action. */
  readonly actions?: ReactNode;
}) {
  const section = sectionByKey(sectionKey);
  return (
    <>
      <TitleRow
        title={section.label}
        meta={
          section.scope === SettingsScope.App ||
          project === undefined ||
          project === null ? undefined : (
            <ScopeBadge tile={project.name}>{project.name}</ScopeBadge>
          )
        }
      />
      <Box mb="xs">
        <PageIntro
          {...(byline === undefined ? {} : { description: byline })}
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
