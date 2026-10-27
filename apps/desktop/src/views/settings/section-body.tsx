import type { ProjectDto } from '@10db/contracts';
import { Text, Title } from '@mantine/core';
import { AccountsSection } from './accounts/accounts-section';
import { BoardColumnsSection } from './board-columns-section';
import { KeepAwakeSection } from './keep-awake-section';
import { PlannedSection } from './planned-section';
import { ProjectAreas } from './project-areas';
import { ProjectBilling } from './project-billing';
import { ProjectGeneralForm } from './project-general-form';
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
          {project ? <ProjectGeneralForm key={project.id} project={project} /> : <NoProject />}
        </>
      );
    case SettingsSectionKey.BoardColumns:
      return (
        <>
          {heading}
          {project ? <BoardColumnsSection key={project.id} project={project} /> : <NoProject />}
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
          {project ? <ProjectBilling key={project.id} project={project} /> : <NoProject />}
        </>
      );
    case SettingsSectionKey.KeepAwake:
      return (
        <>
          {heading}
          <KeepAwakeSection />
        </>
      );
    case SettingsSectionKey.Accounts:
      return (
        <>
          {heading}
          <AccountsSection />
        </>
      );
    case SettingsSectionKey.Team:
    case SettingsSectionKey.RoutingRules:
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
