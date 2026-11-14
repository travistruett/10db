import { z } from 'zod';
import {
  PicturesStatusDto,
  ScreensMatrix,
  TaskScreenAddedData,
  TaskScreenDto,
  TaskScreensDto,
} from './task-screens';
import { TaskFileDto, TaskMessageDto, TaskMessageInput, TaskThreadDto } from './task-thread';
import {
  PassAbandonedDto,
  PassCheckDetail,
  PassDto,
  PassOpenedDto,
  PassOpenRequest,
  PassTurnDto,
  PassViewDto,
  SharedChoice,
  TakeOutResultDto,
} from './passes';
import { SessionActivityData, TurnActivityDto } from './pass-activity';
import {
  GoalPassPagesDto,
  PassJoinRequest,
  PassRename,
  PassStartDto,
  PassTurnWithFilesDto,
} from './pass-view';
import { PassCardDetail } from './pass-cards';
import { WorkbenchSetupDto } from './workbench-setup';
import {
  PlanBundle,
  PlanExportInput,
  PlanExportResult,
  PlanImportError,
  PlanImportInput,
  PlanImportPreview,
  PlanImportResult,
} from './plan-bundle';
import { AnchorCheckDto, PlanAnchor, PlanContext, PlanRef, SectionIndexEntry } from './plan-record';
import {
  PlanDocumentRevisionDto,
  PlanRecordDto,
  PlanRecordPage,
  PlanRecordQuery,
  TaskPlanContextDto,
} from './plan-record-view';
import {
  PassCloseAnswerDto,
  PassCloseContinueDto,
  PassClosePreviewDto,
  PassCloseRequest,
  PassPullRequestDto,
  PassPullRequestPreviewDto,
  PassSignOffDto,
  TakeOutPreviewDto,
  TakeOutRequest,
} from './pass-close';
import {
  PassClosedData,
  PassPageSignedOffData,
  PassPreviewBrokenData,
  PassPreviewMendedData,
  PassSettledData,
  PassSharedChangedData,
} from './pass-events';
import { PassHoldDto, PassSharedChangeDto } from './pass-shared';
import {
  BatchDto,
  BatchStartInput,
  BatchStartResult,
  ProjectViewDto,
  TaskStartResult,
} from './batches';
import {
  AccountCreatedDto,
  AccountDto,
  AccountIdentityDto,
  AccountInput,
  AccountPatch,
  AccountPauseDto,
  AccountSecretInput,
  AccountSignInDto,
  AccountConnectDto,
  AccountConnectingDto,
  AccountUsageDto,
} from './accounts';
import {
  AaModelDto,
  BenchmarkKeyInput,
  BenchmarkStatusDto,
  OpenRouterSyncStatusDto,
} from './benchmarks';
import { GithubSigninDto, GithubStatusDto } from './github';
import { DecisionModelListDto } from './decision-models';
import { DecisionStatsListDto } from './decision-stats';
import {
  JudgeCallDto,
  JudgeCallsPageDto,
  JudgeCallsPageQuery,
  JudgeConfigPatch,
  JudgeStatusDto,
  JudgeTestResultDto,
} from './judge';
import {
  AccountModelDto,
  CatalogueStatusDto,
  ModelEffortDto,
  ModelRowDto,
  ModelsQuery,
  RolePickDto,
  RolePicksDto,
  ModelSetting,
} from './catalogue';
import {
  ModelEvalDto,
  ModelMeasuresDto,
  ModelMeasuresQuery,
  ProviderSpeedDto,
} from './model-measures';
import { AdvertisedBuilderToolInputs, BuilderToolName } from './builder-mcp-tools';
import {
  BoardColumnDelete,
  BoardColumnDto,
  BoardColumnInput,
  BoardColumnPatch,
  TaskMove,
} from './board';
import {
  InboxItemDto,
  ProjectDto,
  ProjectPatch,
  TaskDto,
  TaskPatch,
  WorkstreamDto,
} from './entities';
import { DaemonEvent } from './events';
import {
  KindDto,
  KindInput,
  KindOrderInput,
  KindPatch,
  ModelPicksQuery,
  PlaybookDto,
  PlaybookInput,
} from './rigor';
import {
  AreaProposalInput,
  AreaProposalResult,
  FolderInspectInput,
  FolderInspection,
  FolderInspectResult,
} from './folders';
import {
  GoalAdoptError,
  GoalAdoptInput,
  GoalAdoptPreview,
  GoalBrief,
  GoalCriterionDto,
  GoalDigestDto,
  GoalDto,
  GoalListDto,
} from './goals';
import { HumanTouchDayDto, HumanTouchDto } from './human-touch';
import { HandoffInput } from './handoff';
import { HealthResponse } from './health';
import {
  DecisionDto,
  DecisionInput,
  PrincipleDraft,
  PrincipleDto,
  PrincipleInput,
  ProposalAccept,
  ProposalDto,
  ProposalReject,
  ProvenanceDto,
  ReasonInput,
} from './knowledge';
import {
  DecisionEdit,
  DecisionWrite,
  KnowledgeDryRunDto,
  KnowledgeItemDto,
  KnowledgeListDto,
  KnowledgeSource,
  PrincipleEdit,
  PrincipleWrite,
  ProposalVerdictAccept,
  ProposalVerdictReject,
} from './knowledge-api';
import { SelfUpdateInput, SelfUpdateStatusDto, SelfUpdateWaitInput } from './self-update';
import { McpToolInputs, McpToolName, McpToolOutputs } from './mcp-tools';
import { ModelProfileDto, ModelProfilePatch } from './model-profiles';
import { PickerProposalDto } from './picker';
import { RunNextResult } from './run-next';
import {
  PlanDraft,
  ShapeDto,
  ShapeMessageDto,
  ShapeModelInput,
  ShapeToolInputs,
  ShapeToolName,
} from './shape';
import {
  ShapeConvertError,
  ShapeConvertInput,
  ShapeConvertResult,
  ShapeInput,
  ShapeMessageInput,
  ShapeModelsDto,
  ShapeOfDto,
  ShapeProposeResult,
  ShapeResumeInput,
  ShapeViewDto,
  ShapeWithdrawInput,
} from './shape-view';
import { ShapeJevSettingDto, ShapeMeasuresDto } from './shape-measures';
import {
  OneWayPathsDto,
  ShapeDismissInput,
  ShapeRehearseInput,
  ShapeRehearseResult,
  SmallProposalLimitDto,
} from './shape-review';
import {
  AskSomeoneInput,
  ComposePreviewDto,
  QuestionRouteDto,
  SendInput,
  SlackConnectionDto,
  SlackMemberDto,
  SlackTokenInput,
  StakeholderSendDto,
} from './slack';
import { StepPlanDto } from './steps';
import { WorkstreamChangesDto } from './workstream-changes';
import {
  PersonaDto,
  PersonaInput,
  PersonaPatch,
  PersonDto,
  PersonInput,
  RoutingRuleDto,
  RoutingRulesInput,
  StakeholderTimersDto,
} from './team';
import {
  EventsHead,
  KeepAwakeInput,
  KeepAwakeStatus,
  LanePermissionsDto,
  McpServerReview,
  McpServerStatusDto,
  SystemCheckDto,
} from './system';
import { AgentCapabilitiesDto } from './agent-capabilities';
import {
  InstalledPluginDto,
  ProjectTrustDto,
  SetupPreviewDto,
  TrustOverrides,
  TrustSettingsDto,
  TrustSwitches,
} from './trust';
import { LiveSystemsDto } from './trust-policy';
import { ToolCallView } from './tool-call-view';

const shapeMcpSchemas: Record<string, z.ZodType> = Object.fromEntries(
  Object.values(ShapeToolName).map((tool): [string, z.ZodType] => [
    `shape-mcp-${tool.replaceAll('_', '-')}-input`,
    ShapeToolInputs[tool],
  ]),
);

const mcpSchemas: Record<string, z.ZodType> = Object.fromEntries(
  Object.values(McpToolName).flatMap((tool): [string, z.ZodType][] => [
    [`mcp-${tool.replaceAll('_', '-')}-input`, McpToolInputs[tool]],
    [`mcp-${tool.replaceAll('_', '-')}-output`, McpToolOutputs[tool]],
  ]),
);

const builderMcpSchemas: Record<string, z.ZodType> = Object.fromEntries(
  Object.values(BuilderToolName).map((tool): [string, z.ZodType] => [
    `builder-mcp-${tool.replaceAll('_', '-')}-input`,
    AdvertisedBuilderToolInputs[tool],
  ]),
);

/** Every schema visible outside the daemon, keyed by the file stem of its generated JSON Schema. */
export const CONTRACT_SCHEMAS: Record<string, z.ZodType> = {
  'health-response': HealthResponse,
  'agent-capabilities-dto': AgentCapabilitiesDto,
  'account-created-dto': AccountCreatedDto,
  'account-dto': AccountDto,
  'account-identity-dto': AccountIdentityDto,
  'account-input': AccountInput,
  'account-patch': AccountPatch,
  'account-pause-dto': AccountPauseDto,
  'account-secret-input': AccountSecretInput,
  'account-sign-in-dto': AccountSignInDto,
  'account-connect-dto': AccountConnectDto,
  'account-connecting-dto': AccountConnectingDto,
  'account-usage-dto': AccountUsageDto,
  'daemon-event': DaemonEvent,
  'handoff-input': HandoffInput,
  'batch-dto': BatchDto,
  'batch-start-input': BatchStartInput,
  'batch-start-result': BatchStartResult,
  'project-view-dto': ProjectViewDto,
  'task-start-result': TaskStartResult,
  'project-dto': ProjectDto,
  'task-dto': TaskDto,
  'project-patch': ProjectPatch,
  'task-patch': TaskPatch,
  'workstream-dto': WorkstreamDto,
  'inbox-item-dto': InboxItemDto,
  'system-check-dto': SystemCheckDto,
  'keep-awake-status': KeepAwakeStatus,
  'events-head': EventsHead,
  'keep-awake-input': KeepAwakeInput,
  'self-update-input': SelfUpdateInput,
  'self-update-status-dto': SelfUpdateStatusDto,
  'self-update-wait-input': SelfUpdateWaitInput,
  'lane-permissions-dto': LanePermissionsDto,
  'trust-switches': TrustSwitches,
  'live-systems-dto': LiveSystemsDto,
  'tool-call-view': ToolCallView,
  'trust-overrides': TrustOverrides,
  'trust-settings-dto': TrustSettingsDto,
  'project-trust-dto': ProjectTrustDto,
  'setup-preview-dto': SetupPreviewDto,
  'installed-plugin-dto': InstalledPluginDto,
  'mcp-server-review': McpServerReview,
  'mcp-server-status-dto': McpServerStatusDto,
  'aa-model-dto': AaModelDto,
  'benchmark-key-input': BenchmarkKeyInput,
  'benchmark-status-dto': BenchmarkStatusDto,
  'github-signin-dto': GithubSigninDto,
  'github-status-dto': GithubStatusDto,
  'decision-model-list-dto': DecisionModelListDto,
  'decision-stats-list-dto': DecisionStatsListDto,
  'judge-call-dto': JudgeCallDto,
  'judge-calls-page-dto': JudgeCallsPageDto,
  'judge-calls-page-query': JudgeCallsPageQuery,
  'openrouter-sync-status-dto': OpenRouterSyncStatusDto,
  'judge-config-patch': JudgeConfigPatch,
  'judge-status-dto': JudgeStatusDto,
  'judge-test-result-dto': JudgeTestResultDto,
  'board-column-delete': BoardColumnDelete,
  'board-column-dto': BoardColumnDto,
  'board-column-input': BoardColumnInput,
  'board-column-patch': BoardColumnPatch,
  'task-move': TaskMove,
  'run-next-result': RunNextResult,
  'kind-dto': KindDto,
  'kind-input': KindInput,
  'kind-patch': KindPatch,
  'kind-order-input': KindOrderInput,
  'playbook-dto': PlaybookDto,
  'playbook-input': PlaybookInput,
  'folder-inspect-input': FolderInspectInput,
  'folder-inspection': FolderInspection,
  'folder-inspect-result': FolderInspectResult,
  'area-proposal-input': AreaProposalInput,
  'area-proposal-result': AreaProposalResult,
  'account-model-dto': AccountModelDto,
  'catalogue-status-dto': CatalogueStatusDto,
  'model-effort-dto': ModelEffortDto,
  'model-row-dto': ModelRowDto,
  'models-query': ModelsQuery,
  'model-measures-query': ModelMeasuresQuery,
  'model-measures-dto': ModelMeasuresDto,
  'model-eval-dto': ModelEvalDto,
  'provider-speed-dto': ProviderSpeedDto,
  'model-picks-query': ModelPicksQuery,
  'role-pick-dto': RolePickDto,
  'role-picks-dto': RolePicksDto,
  'model-setting': ModelSetting,
  'model-profile-dto': ModelProfileDto,
  'model-profile-patch': ModelProfilePatch,
  'picker-proposal-dto': PickerProposalDto,
  'decision-input': DecisionInput,
  'decision-dto': DecisionDto,
  'principle-draft': PrincipleDraft,
  'principle-input': PrincipleInput,
  'principle-dto': PrincipleDto,
  'reason-input': ReasonInput,
  'proposal-dto': ProposalDto,
  'proposal-accept': ProposalAccept,
  'proposal-reject': ProposalReject,
  'provenance-dto': ProvenanceDto,
  'knowledge-list-dto': KnowledgeListDto,
  'knowledge-item-dto': KnowledgeItemDto,
  'knowledge-dry-run-dto': KnowledgeDryRunDto,
  'knowledge-source': KnowledgeSource,
  'decision-write': DecisionWrite,
  'decision-edit': DecisionEdit,
  'principle-write': PrincipleWrite,
  'principle-edit': PrincipleEdit,
  'proposal-verdict-accept': ProposalVerdictAccept,
  'proposal-verdict-reject': ProposalVerdictReject,
  'person-dto': PersonDto,
  'person-input': PersonInput,
  'persona-dto': PersonaDto,
  'persona-input': PersonaInput,
  'persona-patch': PersonaPatch,
  'routing-rule-dto': RoutingRuleDto,
  'routing-rules-input': RoutingRulesInput,
  'stakeholder-timers-dto': StakeholderTimersDto,
  'stakeholder-send-dto': StakeholderSendDto,
  'send-input': SendInput,
  'ask-someone-input': AskSomeoneInput,
  'question-route-dto': QuestionRouteDto,
  'slack-connection-dto': SlackConnectionDto,
  'slack-member-dto': SlackMemberDto,
  'slack-token-input': SlackTokenInput,
  'compose-preview-dto': ComposePreviewDto,
  'step-plan-dto': StepPlanDto,
  'workstream-changes-dto': WorkstreamChangesDto,
  'goal-adopt-error': GoalAdoptError,
  'goal-adopt-input': GoalAdoptInput,
  'goal-adopt-preview': GoalAdoptPreview,
  'goal-brief': GoalBrief,
  'goal-criterion-dto': GoalCriterionDto,
  'goal-digest-dto': GoalDigestDto,
  'goal-dto': GoalDto,
  'goal-list-dto': GoalListDto,
  'human-touch-day-dto': HumanTouchDayDto,
  'human-touch-dto': HumanTouchDto,
  'plan-draft': PlanDraft,
  'shape-dto': ShapeDto,
  'shape-message-dto': ShapeMessageDto,
  'shape-view-dto': ShapeViewDto,
  'shape-input': ShapeInput,
  'shape-message-input': ShapeMessageInput,
  'shape-propose-result': ShapeProposeResult,
  'shape-convert-input': ShapeConvertInput,
  'shape-convert-result': ShapeConvertResult,
  'shape-convert-error': ShapeConvertError,
  'shape-withdraw-input': ShapeWithdrawInput,
  'shape-resume-input': ShapeResumeInput,
  'shape-of-dto': ShapeOfDto,
  'shape-measures-dto': ShapeMeasuresDto,
  'shape-jev-setting-dto': ShapeJevSettingDto,
  'one-way-paths-dto': OneWayPathsDto,
  'small-proposal-limit-dto': SmallProposalLimitDto,
  'shape-rehearse-input': ShapeRehearseInput,
  'shape-rehearse-result': ShapeRehearseResult,
  'shape-dismiss-input': ShapeDismissInput,
  'shape-model-input': ShapeModelInput,
  'shape-models-dto': ShapeModelsDto,
  'plan-bundle': PlanBundle,
  'plan-import-input': PlanImportInput,
  'plan-import-error': PlanImportError,
  'plan-import-preview': PlanImportPreview,
  'plan-import-result': PlanImportResult,
  'plan-export-input': PlanExportInput,
  'plan-export-result': PlanExportResult,
  'plan-anchor': PlanAnchor,
  'plan-ref': PlanRef,
  'section-index-entry': SectionIndexEntry,
  'anchor-check-dto': AnchorCheckDto,
  'plan-context': PlanContext,
  'plan-record-dto': PlanRecordDto,
  'plan-document-revision-dto': PlanDocumentRevisionDto,
  'plan-record-query': PlanRecordQuery,
  'plan-record-page': PlanRecordPage,
  'task-plan-context-dto': TaskPlanContextDto,
  'task-file-dto': TaskFileDto,
  'task-message-dto': TaskMessageDto,
  'task-message-input': TaskMessageInput,
  'task-thread-dto': TaskThreadDto,
  'task-screen-dto': TaskScreenDto,
  'task-screens-dto': TaskScreensDto,
  'task-screen-added-data': TaskScreenAddedData,
  'screens-matrix': ScreensMatrix,
  'pictures-status-dto': PicturesStatusDto,
  'pass-dto': PassDto,
  'pass-view-dto': PassViewDto,
  'pass-turn-dto': PassTurnDto,
  'pass-check-detail': PassCheckDetail,
  'pass-open-request': PassOpenRequest,
  'pass-opened-dto': PassOpenedDto,
  'take-out-result-dto': TakeOutResultDto,
  'pass-abandoned-dto': PassAbandonedDto,
  'shared-choice': SharedChoice,
  'pass-start-dto': PassStartDto,
  'pass-join-request': PassJoinRequest,
  'pass-rename': PassRename,
  'workbench-setup-dto': WorkbenchSetupDto,
  'goal-pass-pages-dto': GoalPassPagesDto,
  'pass-turn-with-files-dto': PassTurnWithFilesDto,
  'turn-activity-dto': TurnActivityDto,
  'session-activity-data': SessionActivityData,
  'pass-hold-dto': PassHoldDto,
  'pass-shared-change-dto': PassSharedChangeDto,
  'pass-card-detail': PassCardDetail,
  'pass-sign-off-dto': PassSignOffDto,
  'pass-pull-request-preview-dto': PassPullRequestPreviewDto,
  'pass-pull-request-dto': PassPullRequestDto,
  'take-out-preview-dto': TakeOutPreviewDto,
  'take-out-request': TakeOutRequest,
  'pass-close-preview-dto': PassClosePreviewDto,
  'pass-close-request': PassCloseRequest,
  'pass-close-answer-dto': PassCloseAnswerDto,
  'pass-close-continue-dto': PassCloseContinueDto,
  'pass-shared-changed-data': PassSharedChangedData,
  'pass-page-signed-off-data': PassPageSignedOffData,
  'pass-closed-data': PassClosedData,
  'pass-settled-data': PassSettledData,
  'pass-preview-broken-data': PassPreviewBrokenData,
  'pass-preview-mended-data': PassPreviewMendedData,
  ...mcpSchemas,
  ...builderMcpSchemas,
  ...shapeMcpSchemas,
};

/** Renders each registered schema as JSON Schema text, keyed by file name. */
export function renderJsonSchemas(): Map<string, string> {
  return new Map(
    Object.entries(CONTRACT_SCHEMAS)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([stem, schema]) => [
        `${stem}.schema.json`,
        `${JSON.stringify(z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input', unrepresentable: 'any' }), null, 2)}\n`,
      ]),
  );
}
