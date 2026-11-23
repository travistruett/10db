import { Stack, Tabs } from '@mantine/core';
import { useState } from 'react';
import { TitleRow } from '../../shell/title-row';
import { KindsSection } from './kinds-section';
import { MoveReportNote } from './move-report-note';
import { PlaybookTable } from './playbook-table';
import { SectionHeading } from './section-heading';
import { useViewedAccount, ViewedAccountSelect } from './viewed-account';

const PlaybookTab = { Rigor: 'rigor', Kinds: 'kinds' } as const;
type PlaybookTab = (typeof PlaybookTab)[keyof typeof PlaybookTab];

const isPlaybookTab = (value: string | null): value is PlaybookTab =>
  Object.values(PlaybookTab).some((tab) => tab === value);

/**
 * Settings › Playbook: who does the work. The Account select sits in the title row, since it only changes
 * which model a cell resolves to. Rigor is the table of steps by rigor; Kinds are the sorts of work.
 */
export function PlaybookSection() {
  const viewed = useViewedAccount();
  const [tab, setTab] = useState<PlaybookTab>(PlaybookTab.Rigor);
  return (
    <Stack gap="xl">
      <TitleRow title="Playbook" actions={<ViewedAccountSelect viewed={viewed} />} />
      <MoveReportNote />
      <Tabs
        value={tab}
        onChange={(next) => {
          if (isPlaybookTab(next)) setTab(next);
        }}
        keepMounted={false}
      >
        <Tabs.List mb="lg">
          <Tabs.Tab value={PlaybookTab.Rigor}>Rigor</Tabs.Tab>
          <Tabs.Tab value={PlaybookTab.Kinds}>Kinds</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value={PlaybookTab.Rigor}>
          <Stack gap="sm" component="section" aria-label="Playbook section">
            <SectionHeading
              title="Rigor"
              line={
                viewed.account === null
                  ? 'What each step runs.'
                  : `What each step runs on ${viewed.account.label}.`
              }
              help="Each rigor runs the steps in its row. A cell shows the model and effort it resolves to, and the setting behind it. Open a cell to change it, or a rigor to change its steps."
            />
            <PlaybookTable projectId={null} accountId={viewed.account?.id ?? null} />
          </Stack>
        </Tabs.Panel>
        <Tabs.Panel value={PlaybookTab.Kinds}>
          <KindsSection />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
