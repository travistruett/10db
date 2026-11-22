import { ReportLinearPostInput, ReportLinearWorkspaceInput } from './linear-posts';

/** The tools on 10db's own server that a Linear reporter's session calls. */
export const ReporterToolName = {
  ReportLinearWorkspace: 'report_linear_workspace',
  ReportLinearPost: 'report_linear_post',
} as const;
export type ReporterToolName = (typeof ReporterToolName)[keyof typeof ReporterToolName];

export const ReporterToolInputs = {
  [ReporterToolName.ReportLinearWorkspace]: ReportLinearWorkspaceInput,
  [ReporterToolName.ReportLinearPost]: ReportLinearPostInput,
} as const;

/** What the reporter's agent reads about each tool. */
export const REPORTER_TOOL_DESCRIPTIONS: Readonly<Record<ReporterToolName, string>> = {
  [ReporterToolName.ReportLinearWorkspace]:
    "Say which Linear workspace and team your sign-in reaches, by their ids from get_workspace and get_team. 10db accepts the report only when the ids are the project's and appeared in your own results; until it does, every Linear write is refused.",
  [ReporterToolName.ReportLinearPost]:
    'Record the updates you made on the issue, by their post ids: the comment ids you wrote, the status you set and any attachment. Or record them as withheld, naming the pattern a refused write matched. Call it once per update you finished.',
};
