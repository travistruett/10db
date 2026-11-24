import type { GeneralValues } from './general-values';
import { SettingsSectionKey } from './sections';

export interface FieldHome {
  /** The field's label on its page. */
  readonly label: string;
  readonly section: SettingsSectionKey;
}

const { General, PagesAndPictures, Sharing, NetworkHosts, Billing } = SettingsSectionKey;

/** Where each field of the project's typed settings is shown, so a mistake in one can point to it. */
export const FIELD_HOMES: Readonly<Record<keyof GeneralValues, FieldHome>> = {
  name: { label: 'Name', section: General },
  gateCommand: { label: 'Gate Command', section: General },
  changedCheckCommand: { label: 'Check After Each Step', section: General },
  precheckCommand: { label: 'Pre-Check Command', section: General },
  maxLanes: { label: 'Most Tasks at Once', section: General },
  handoffPct: { label: 'Fresh Session', section: General },
  nudgePct: { label: 'Firm Reminder', section: General },
  humanWaitMinutes: { label: 'Wait for Your Answer', section: General },
  budgetCeiling: { label: 'Spending Limit per Task', section: Billing },
  delivery: { label: 'Delivery', section: General },
  baseBranch: { label: 'Base Branch', section: General },
  landing: { label: 'When Checks Pass', section: General },
  landingBranch: { label: 'New Tasks Land In', section: General },
  prTitlePrefix: { label: 'Pull Request Title', section: General },
  allowedCommands: { label: 'Allowed Commands', section: NetworkHosts },
  sandboxLoopback: { label: 'Allow localhost', section: NetworkHosts },
  sandboxDocker: { label: 'Allow Docker', section: NetworkHosts },
  prPictures: { label: 'Pictures in Pull Requests', section: Sharing },
  workspaceMode: { label: 'Default for New Tasks', section: General },
  worktreeSeed: { label: "Copy Into Each Task's Copy", section: General },
  isolate: { label: 'Separate Copy for These Areas', section: General },
  appUrl: { label: 'App Address', section: PagesAndPictures },
  devLoginCommand: { label: 'Dev Login Command', section: PagesAndPictures },
  previewCommand: { label: 'Preview Command', section: PagesAndPictures },
  screens: { label: 'Screenshot Matrix', section: PagesAndPictures },
};
