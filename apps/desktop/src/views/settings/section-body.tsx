import type { ProjectDto } from '@10db/contracts';
import { Text, Title } from '@mantine/core';
import { KeepAwakeSection } from './keep-awake-section';
import { PlannedSection } from './planned-section';
import { ProjectAreas } from './project-areas';
import { ProjectBilling } from './project-billing';
import { sectionByKey, SettingsSectionKey } from './sections';

function NoProject() {
  return <Text c="dimmed">Create a project on the board first.</Text>;
}

export function SectionBody({
  sectionKey,
  project,
}: {
  readonly sectionKey: SettingsSectionKey;
  readonly project: ProjectDto | null;
}) {
  const section = sectionByKey(sectionKey);
  const heading = <Title order={3}>{section.label}</Title>;
  switch (sectionKey) {
    case SettingsSectionKey.General:
      return (
        <>
          {heading}
          {project ? <Text c="dimmed">Project fields arrive with the form.</Text> : <NoProject />}
        </>
      );
    case SettingsSectionKey.BoardColumns:
      return (
        <>
          {heading}
          {project ? <Text c="dimmed">Columns arrive with their editor.</Text> : <NoProject />}
        </>
      );
    case SettingsSectionKey.Areas:
      return (
        <>
          {heading}
          {project ? <ProjectAreas project={project} /> : <NoProject />}
        </>
      );
    case SettingsSectionKey.Billing:
      return (
        <>
          {heading}
          {project ? <ProjectBilling project={project} /> : <NoProject />}
        </>
      );
    case SettingsSectionKey.KeepAwake:
      return (
        <>
          {heading}
          <KeepAwakeSection />
        </>
      );
    case SettingsSectionKey.Team:
    case SettingsSectionKey.RoutingRules:
    case SettingsSectionKey.Accounts:
    case SettingsSectionKey.Models:
    case SettingsSectionKey.PersonasAndFlows:
      return (
        <>
          {heading}
          <PlannedSection section={section} />
        </>
      );
  }
}
