import type { ShapeId } from '@10db/contracts';
import { Button, Group } from '@mantine/core';
import { IconLayoutSidebarRight } from '@tabler/icons-react';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useShapeView } from '../../daemon/shape-queries';
import { useSelectedProject } from '../../shell/selected-project';
import { ConversationPane } from './conversation-pane';
import { ProposedPane } from './proposed-pane';
import { groupProposals } from './proposed-groups';
import { RoundAnnouncer } from './round-announcer';
import { SplitPane } from './split-pane';
import { SummaryLine } from './summary-line';
import type { TranscriptProps } from './transcript';

/**
 * Shape (spec §4): the conversation beside the Proposed sidebar. With no `shapeId` it is the new
 * conversation, which exists in the daemon only once the first message is sent.
 */
export function ShapeView({ shapeId }: { readonly shapeId: ShapeId | null }) {
  // Keyed by conversation, so a draft, an open row or a failure never carries into another.
  return <Shape key={shapeId ?? 'new'} shapeId={shapeId} />;
}

function Shape({ shapeId }: { readonly shapeId: ShapeId | null }) {
  const { project } = useSelectedProject();
  const navigate = useNavigate();
  const query = useShapeView(shapeId);
  const view = query.data;
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [why, setWhy] = useState<TranscriptProps['why']>(null);
  const error = query.isError ? query.error.message : null;

  // Esc lets go of the highlight Why? left in the conversation.
  const highlighted = why !== null;
  useEffect(() => {
    if (!highlighted) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setWhy(null);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [highlighted]);

  return (
    <>
      <SplitPane drawerOpen={drawerOpen}>
        {(layout) => ({
          chat: (
            <ConversationPane
              projectId={project?.id ?? null}
              shapeId={shapeId}
              view={view}
              loading={query.isLoading}
              error={error}
              onOpened={(id) => {
                void navigate({ to: '/shape/$shapeId', params: { shapeId: id } });
              }}
              why={why}
            />
          ),
          sidebar: (
            <ProposedPane
              view={view}
              loading={query.isLoading}
              error={error}
              summaryHere={layout.mode === 'split'}
              onWhy={(row) => {
                // A drawer would cover the messages it points at.
                setDrawerOpen(false);
                setWhy((previous) => ({
                  ids: row.sourceMessageIds,
                  nonce: (previous?.nonce ?? 0) + 1,
                }));
              }}
            />
          ),
          bar: (
            <Group gap="sm" px="md" py={6} wrap="nowrap" justify="space-between">
              <SummaryLine
                groups={groupProposals(view?.proposals ?? [])}
                onJump={() => {
                  setDrawerOpen(true);
                }}
              />
              <Button
                variant="default"
                size="xs"
                aria-expanded={drawerOpen}
                leftSection={<IconLayoutSidebarRight size={14} stroke={1.5} />}
                onClick={() => {
                  setDrawerOpen((o) => !o);
                }}
              >
                Proposed
              </Button>
            </Group>
          ),
        })}
      </SplitPane>
      <RoundAnnouncer view={view} />
    </>
  );
}
