import type { ProjectDto } from '@10db/contracts';
import { Text } from '@mantine/core';
import { TitleRow } from '../../shell/title-row';
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
import { ScopeBadge } from './settings-page';
import { ScopeLine } from './scope-line';
import { ProjectAreas } from './project-areas';
import { ProjectBilling } from './project-billing';
import { ProjectGeneralForm } from './project-general-form';
import { ProjectLinear } from './project-linear';
import { ProjectPagesForm } from './project-pages-form';
import { SandboxSection } from './sandbox-section';
import { ProjectTrustSection } from './project-trust-section';
import { WatchpointsSection } from './watchpoints-section';
import { sectionByKey, SettingsScope, SettingsSectionKey } from './sections';
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
  const heading = (
    <TitleRow
      title={section.label}
      meta={
        section.scope === SettingsScope.App || project === null ? undefined : (
          <ScopeBadge tile={project.name}>{project.name}</ScopeBadge>
        )
      }
    />
  );
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
    case SettingsSectionKey.Watchpoints:
      // The page draws its own header: its Add Watchpoint and its guide sit in it.
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
          <ScopeLine>For every project; a project can override one or add its own.</ScopeLine>
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
      return (
        <>
          {heading}
          <PeopleSection />
        </>
      );
    case SettingsSectionKey.RemoteAccess:
      return <RemoteAccessSection />;
    case SettingsSectionKey.Devices:
      return (
        <>
          {heading}
          <DevicesSection />
          <PlannedRemainder section={section} />
        </>
      );
    case SettingsSectionKey.ProjectTrust:
      return (
        <>
          {heading}
          {project ? (
            <ScopeLine>
              Default follows All Projects › Trust. Changes apply from the next session.
            </ScopeLine>
          ) : null}
          {project ? <ProjectTrustSection key={project.id} project={project} /> : <NoProject />}
        </>
      );
    case SettingsSectionKey.Trust:
      return (
        <>
          {heading}
          <ScopeLine>
            For every project; a project can override it. Changes apply from the next session.
          </ScopeLine>
          <TrustSection />
        </>
      );
    case SettingsSectionKey.Sessions:
      return (
        <>
          {heading}
          <ScopeLine>For every project.</ScopeLine>
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
    case SettingsSectionKey.Playbook:
      // The page carries its own title, so the Account select sits beside it.
      return <PlaybookSection />;
    case SettingsSectionKey.Models:
      return <ModelsSection />;
    case SettingsSectionKey.Team:
      return (
        <>
          {heading}
          {project ? (
            <ScopeLine>
              {`For ${project.name} only. Use global follows All Projects › Playbook.`}
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
