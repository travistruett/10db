/**
 * How a lane's brief carries its task's Plan and knowledge. `full` pastes the Plan block and every
 * decision's choice and rationale, and keeps every rule bullet. `index` names the Plan's section and
 * entries and the decisions' questions, points to the tools that read them, and leaves out the rule
 * bullets whose tool refusal already says what to do instead.
 */
export const LaneBrief = { Full: 'full', Index: 'index' } as const;
export type LaneBrief = (typeof LaneBrief)[keyof typeof LaneBrief];
