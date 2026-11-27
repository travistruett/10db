import type { ProjectDto } from '@10db/contracts';
import { Text } from '@mantine/core';
import { AccountsSection } from './accounts/accounts-section';
import { AgentSkillSection } from './agent-skill-section';
import { AllWatchpointsSection } from './all-watchpoints-section';
import { AgentCopiesSection } from './agent-copies-section';
import { BoardColumnsSection } from './board-columns-section';
import { DecisionsSection } from './decisions-section';
import { IntegrationsSection } from './integrations-section';
import { AppearanceSection } from './appearance-section';
import { KeepAwakeSection } from './keep-awake-section';
import { LanePermissionsSection } from './lane-permissions-section';
import { DevicesSection } from './devices-section';
import { RemoteAccessSection } from './remote-access-section';
import { PeopleSection } from './people/people-section';
import { ProjectSharing } from './sharing-section';
import { PlannedRemainder } from './planned-section';
import { WhoAnswersSection } from './who-answers-section';
import { ModelsSection } from './models-section';
import { PlaybookSection } from './playbook-section';
import { OverviewSection } from './overview-section';
import { PlanningSection } from './planning-section';
import { SettingsPageHeader } from './settings-page';
import { ProjectAreas } from './project-areas';
import { ProjectBilling } from './project-billing';
import { ProjectGeneralForm } from './project-general-form';
import { ProjectLinear } from './project-linear';
import { ProjectPagesForm } from './project-pages-form';
import { SandboxSection } from './sandbox-section';
import { ProjectTrustSection } from './project-trust-section';
import { WatchpointsSection } from './watchpoints-section';
import { sectionByKey, SettingsSectionKey } from './sections';
import { ProjectPlaybook } from './project-playbook';
import { SessionsSection } from './sessions-section';
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
  // A page with its own controls, tabs or guide draws this header itself, with them in it.
  const heading = <SettingsPageHeader sectionKey={sectionKey} project={project} />;
  switch (sectionKey) {
    case SettingsSectionKey.General:
      return (
        <>
          {heading}
          {project ? <ProjectGeneralForm key={project.id} project={project} /> : <NoProject />}
        </>
      );
    case SettingsSectionKey.PagesAndPictures:
      return (
        <>
          {heading}
          {project ? <ProjectPagesForm key={project.id} project={project} /> : <NoProject />}
        </>
      );
    case SettingsSectionKey.Sharing:
      return (
        <>
          {heading}
          {project ? <ProjectSharing key={project.id} project={project} /> : <NoProject />}
        </>
      );
    case SettingsSectionKey.Linear:
      return (
        <>
          {heading}
          {project ? <ProjectLinear key={project.id} project={project} /> : <NoProject />}
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
      return project ? (
        <BoardColumnsSection key={project.id} project={project} />
      ) : (
        <>
          {heading}
          <NoProject />
        </>
      );
    case SettingsSectionKey.Areas:
      return project ? (
        <ProjectAreas key={project.id} project={project} />
      ) : (
        <>
          {heading}
          <NoProject />
        </>
      );
    case SettingsSectionKey.Watchpoints:
      return project ? (
        <WatchpointsSection key={project.id} project={project} />
      ) : (
        <>
          {heading}
          <NoProject />
        </>
      );
    case SettingsSectionKey.AllWatchpoints:
      return (
        <>
          {heading}
          <AllWatchpointsSection />
        </>
      );
    case SettingsSectionKey.NetworkHosts:
      return (
        <>
          {heading}
          {project ? <SandboxSection key={project.id} project={project} /> : <NoProject />}
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
      return <PeopleSection />;
    case SettingsSectionKey.RemoteAccess:
      return <RemoteAccessSection />;
    case SettingsSectionKey.Devices:
      return (
        <>
          <DevicesSection />
          <PlannedRemainder section={section} />
        </>
      );
    case SettingsSectionKey.ProjectTrust:
      return project ? (
        <ProjectTrustSection key={project.id} project={project} />
      ) : (
        <>
          {heading}
          <NoProject />
        </>
      );
    case SettingsSectionKey.Trust:
      return <TrustSection />;
    case SettingsSectionKey.Sessions:
      return (
        <>
          {heading}
          <SessionsSection />
        </>
      );
    case SettingsSectionKey.Appearance:
      return (
        <>
          {heading}
          <AppearanceSection />
        </>
      );
    case SettingsSectionKey.KeepAwake:
      return (
        <>
          {heading}
          <KeepAwakeSection />
        </>
      );
    case SettingsSectionKey.AgentSkill:
      return (
        <>
          {heading}
          <AgentSkillSection />
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
      return <AccountsSection />;
    case SettingsSectionKey.Decisions:
      return <DecisionsSection />;
    case SettingsSectionKey.Playbook:
      return <PlaybookSection />;
    case SettingsSectionKey.Models:
      return <ModelsSection />;
    case SettingsSectionKey.Team:
      return project ? (
        <>
          <ProjectPlaybook key={project.id} project={project} />
          <PlannedRemainder section={section} />
        </>
      ) : (
        <>
          {heading}
          <NoProject />
        </>
      );
    case SettingsSectionKey.RoutingRules:
      return project ? (
        <WhoAnswersSection key={project.id} project={project} />
      ) : (
        <>
          {heading}
          <NoProject />
        </>
      );
  }
}
