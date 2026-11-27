import { Stack } from '@mantine/core';
import { usePageGuide } from '../../shell/page-guide';
import { PageTabs, type PageTab } from '../../shell/page-intro';
import { useSettingsTab } from './focus-target';
import { KindsButtons, KindsSection, useKindsActions } from './kinds-section';
import { MoveReportNote } from './move-report-note';
import { PlaybookGuide, PLAYBOOK_GUIDE } from './playbook-guide';
import { PlaybookTable } from './playbook-table';
import { SettingsSectionKey } from './sections';
import { SettingsPageHeader } from './settings-page';
import { useViewedAccount, ViewedAccountSelect } from './viewed-account';

const PlaybookTab = { Rigor: 'rigor', Kinds: 'kinds' } as const;
type PlaybookTab = (typeof PlaybookTab)[keyof typeof PlaybookTab];

const PLAYBOOK_TABS: readonly PageTab<PlaybookTab>[] = [
  { value: PlaybookTab.Rigor, label: 'Rigor' },
  { value: PlaybookTab.Kinds, label: 'Kinds' },
];

/**
 * Settings › Playbook: who does the work. Rigor is the table of steps by rigor, resolved on the Account the
 * toolbar picks; Kinds are the sorts of work, with Add Kind in the toolbar while that tab is open. The tab is kept
 * in the address.
 */
export function PlaybookSection() {
  const viewed = useViewedAccount();
  const [tab, setTab] = useSettingsTab(
    SettingsSectionKey.Playbook,
    PLAYBOOK_TABS,
    PlaybookTab.Rigor,
  );
  const kinds = useKindsActions();
  const guide = usePageGuide(PLAYBOOK_GUIDE);
  return (
    <>
      <SettingsPageHeader
        sectionKey={SettingsSectionKey.Playbook}
        guide={guide.opener}
        tabs={<PageTabs label="Playbook" tabs={PLAYBOOK_TABS} value={tab} onChange={setTab} />}
        actions={
          // The account only changes what a rigor's cells resolve to, so the Kinds tab has no use for it.
          tab === PlaybookTab.Rigor ? (
            <ViewedAccountSelect viewed={viewed} />
          ) : (
            <KindsButtons actions={kinds} />
          )
        }
      />
      <Stack gap="xl">
        <MoveReportNote />
        {tab === PlaybookTab.Rigor ? (
          <PlaybookTable projectId={null} accountId={viewed.account?.id ?? null} />
        ) : (
          <KindsSection actions={kinds} />
        )}
      </Stack>
      <PlaybookGuide guide={guide} project={null} />
    </>
  );
}
