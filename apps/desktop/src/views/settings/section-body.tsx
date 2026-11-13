import type { ProjectDto } from '@10db/contracts';
import { Text, Title } from '@mantine/core';
import { AccountsSection } from './accounts/accounts-section';
import { AgentCopiesSection } from './agent-copies-section';
import { BoardColumnsSection } from './board-columns-section';
import { DecisionsSection } from './decisions-section';
import { IntegrationsSection } from './integrations/integrations-section';
import { KeepAwakeSection } from './keep-awake-section';
import { LanePermissionsSection } from './lane-permissions-section';
import { PeopleSection } from './people/people-section';
import { PlannedRemainder } from './planned-section';
import { WhoAnswersSection } from './who-answers-section';
import { ModelsSection } from './models-section';
import { NetworkHostsSection } from './network-hosts-section';
import { OverviewSection } from './overview-section';
import { PlanningSection } from './planning-section';
import { ScopeLine } from './scope-line';
import { ProjectAreas } from './project-areas';
import { ProjectBilling } from './project-billing';
import { ProjectGeneralForm } from './project-general-form';
import { ProjectTrustSection } from './project-trust-section';
import { sectionByKey, SettingsSectionKey } from './sections';
import { ProjectPlaybook } from './project-playbook';
import { SelfUpdateSection } from './self-update-section';
import { TrustSection } from './trust-section';

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
          {project ? (
            <>
              <ProjectGeneralForm key={project.id} project={project} />
            </>
          ) : (
            <NoProject />
          )}
        </>
      );
    case SettingsSectionKey.Overview:
      return (
        <>
          {heading}
          <OverviewSection />
        </>
      );
    case SettingsSectionKey.Planning:
      return (
        <>
          {heading}
          {project ? <PlanningSection key={project.id} project={project} /> : <NoProject />}
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
          {project ? <ProjectAreas key={project.id} project={project} /> : <NoProject />}
        </>
      );
    case SettingsSectionKey.NetworkHosts:
      return (
        <>
          {heading}
          {project ? <NetworkHostsSection key={project.id} project={project} /> : <NoProject />}
        </>
      );
    case SettingsSectionKey.Billing:
      return (
        <>
          {heading}
          {project ? <ProjectBilling key={project.id} project={project} /> : <NoProject />}
        </>
      );
    case SettingsSectionKey.Integrations:
      return (
        <>
          {heading}
          <IntegrationsSection />
        </>
      );
    case SettingsSectionKey.People:
      return (
        <>
          {heading}
          <PeopleSection />
        </>
      );
    case SettingsSectionKey.ProjectTrust:
      return (
        <>
          {heading}
          {project ? (
            <ScopeLine>
              {`For ${project.name} only. Anything set to As app follows All projects › Trust.`}
            </ScopeLine>
          ) : null}
          {project ? <ProjectTrustSection key={project.id} project={project} /> : <NoProject />}
        </>
      );
    case SettingsSectionKey.Trust:
      return (
        <>
          {heading}
          <ScopeLine>For every project. A project can override this in its own Trust.</ScopeLine>
          <TrustSection />
        </>
      );
    case SettingsSectionKey.KeepAwake:
      return (
        <>
          {heading}
          <KeepAwakeSection />
        </>
      );
    case SettingsSectionKey.Updates:
      return (
        <>
          {heading}
          <SelfUpdateSection />
          <AgentCopiesSection />
        </>
      );
    case SettingsSectionKey.LanePermissions:
      return (
        <>
          {heading}
          <LanePermissionsSection />
        </>
      );
    case SettingsSectionKey.Accounts:
      return (
        <>
          {heading}
          <AccountsSection />
        </>
      );
    case SettingsSectionKey.Decisions:
      return (
        <>
          {heading}
          <DecisionsSection />
        </>
      );
    case SettingsSectionKey.Models:
      // The page carries its own title, so the Account select and the refresh button sit beside it.
      return <ModelsSection />;
    case SettingsSectionKey.Team:
      return (
        <>
          {heading}
          {project ? (
            <ScopeLine>
              {`For ${project.name} only. Use global follows All projects › Models.`}
            </ScopeLine>
          ) : null}
          {project ? <ProjectPlaybook key={project.id} project={project} /> : <NoProject />}
          <PlannedRemainder section={section} />
        </>
      );
    case SettingsSectionKey.RoutingRules:
      return (
        <>
          {heading}
          {project ? <WhoAnswersSection key={project.id} project={project} /> : <NoProject />}
        </>
      );
  }
}
