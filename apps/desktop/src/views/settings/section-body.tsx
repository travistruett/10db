import type { ProjectDto } from '@10db/contracts';
import { Text, Title } from '@mantine/core';
import { AccountsSection } from './accounts/accounts-section';
import { AgentCopiesSection } from './agent-copies-section';
import { BoardColumnsSection } from './board-columns-section';
import { DecisionsSection } from './decisions-section';
import { KeepAwakeSection } from './keep-awake-section';
import { LanePermissionsSection } from './lane-permissions-section';
import { PatternsSection } from './patterns-section';
import { PlannedRemainder, PlannedSection } from './planned-section';
import { ModelsSection } from './models-section';
import { NetworkHostsSection } from './network-hosts-section';
import { OneWayPathsSetting } from './one-way-paths-setting';
import { SmallProposalLimitSetting } from './small-proposal-limit-setting';
import { ProjectAreas } from './project-areas';
import { ProjectBilling } from './project-billing';
import { ProjectGeneralForm } from './project-general-form';
import { ProjectTrustSection } from './project-trust-section';
import { sectionByKey, SettingsSectionKey } from './sections';
import { RoleSettings } from './role-settings';
import { SelfUpdateSection } from './self-update-section';
import { ShapeJevSetting } from './shape-jev-setting';
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
              <ShapeJevSetting key={`jev-${project.id}`} project={project} />
              <OneWayPathsSetting key={`one-way-${project.id}`} project={project} />
              <SmallProposalLimitSetting key={`small-proposals-${project.id}`} project={project} />
            </>
          ) : (
            <NoProject />
          )}
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
    case SettingsSectionKey.ProjectTrust:
      return (
        <>
          {heading}
          {project ? <ProjectTrustSection key={project.id} project={project} /> : <NoProject />}
        </>
      );
    case SettingsSectionKey.Trust:
      return (
        <>
          {heading}
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
      return (
        <>
          {heading}
          <ModelsSection />
        </>
      );
    case SettingsSectionKey.Team:
      return (
        <>
          {heading}
          {project ? (
            <>
              <RoleSettings key={`roles-${project.id}`} project={project} />
              <PatternsSection key={`patterns-${project.id}`} project={project} />
            </>
          ) : (
            <NoProject />
          )}
          <PlannedRemainder section={section} />
        </>
      );
    case SettingsSectionKey.PersonasAndFlows:
      return (
        <>
          {heading}
          <RoleSettings project={null} />
          <PatternsSection project={null} />
          <PlannedRemainder section={section} />
        </>
      );
    case SettingsSectionKey.RoutingRules:
      return (
        <>
          {heading}
          <PlannedSection section={section} />
        </>
      );
  }
}
