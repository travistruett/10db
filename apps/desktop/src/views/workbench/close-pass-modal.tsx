import {
  PassClosePageChoice,
  type PassClosePreviewDto,
  type PassViewDto,
  type TaskId,
} from '@10db/contracts';
import { Box, Button, Group, List, Loader, Select, Stack, Text, Title } from '@mantine/core';
import { useState, type ReactNode } from 'react';
import { useClosePass, useClosePreview } from '../../daemon/pass-close-queries';
import { FormModal } from '../../shell/form-modal';
import {
  closeRequest,
  landingPages,
  NO_CLOSE_CHOICES,
  pageChoice,
  placement,
  type CloseChoices,
} from './close-choices';
import { SharedChoices } from './shared-choices';

// Workbench spec §5.4, D25: Close Pass… settles every loose end with a safe default before anything
// lands. Opening it stops nothing; on Close Pass the daemon stops the agents and works the lists out
// again, and closes only if they are what the modal showed, else the modal shows them again.

/** The select value that leaves a file out of every page. */
const LEAVE_OUT = 'leave-out';

const PAGE_CHOICES = [
  { value: PassClosePageChoice.TakeOut, label: 'Take Out' },
  { value: PassClosePageChoice.SignOff, label: 'Sign Off Now' },
];

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <Stack gap="xs">
      <Title order={3} size="sm" fw={500}>
        {title}
      </Title>
      {children}
    </Stack>
  );
}

interface ListsProps {
  readonly view: PassViewDto;
  readonly preview: PassClosePreviewDto;
  readonly choices: CloseChoices;
  readonly onChoices: (choices: CloseChoices) => void;
  readonly disabled: boolean;
}

/** The close's lists: each section drawn only when it holds something. */
function CloseLists({ view, preview, choices, onChoices, disabled }: ListsProps) {
  const areaOf = (taskId: TaskId, title: string) =>
    view.pages.find((page) => page.taskId === taskId)?.area ?? title;
  const landing = landingPages(preview, view.pages, choices);
  const fileChoices = [
    { value: LEAVE_OUT, label: 'Leave Out' },
    ...landing.map((page) => ({ value: page.taskId, label: `Add to ${page.area}` })),
  ];
  return (
    <Stack gap="lg">
      {preview.unfinished.length === 0 ? null : (
        <Section title="Not signed off">
          {preview.unfinished.map((page) => {
            const area = areaOf(page.taskId, page.title);
            const choice = pageChoice(choices, page.taskId);
            return (
              <Box key={page.taskId} role="group" aria-label={area}>
                <Stack gap={6}>
                  <Group gap="sm" wrap="nowrap" justify="space-between">
                    <Stack gap={0} style={{ minWidth: 0 }}>
                      <Text size="sm">{area}</Text>
                      {page.working ? (
                        <Text size="xs" c="dimmed">
                          Working · will be stopped
                        </Text>
                      ) : null}
                    </Stack>
                    <Select
                      aria-label={`What happens to ${area}`}
                      size="xs"
                      w={150}
                      allowDeselect={false}
                      disabled={disabled}
                      data={PAGE_CHOICES}
                      value={choice}
                      onChange={(value) => {
                        if (value === null) return;
                        onChoices({
                          ...choices,
                          pages: new Map(choices.pages).set(
                            page.taskId,
                            value === PassClosePageChoice.SignOff
                              ? PassClosePageChoice.SignOff
                              : PassClosePageChoice.TakeOut,
                          ),
                        });
                      }}
                    />
                  </Group>
                  {choice === PassClosePageChoice.TakeOut && page.sharedUnlanded.length > 0 ? (
                    <SharedChoices
                      changes={page.sharedUnlanded}
                      chosen={choices.shared}
                      disabled={disabled}
                      onChoose={(seq, kind) => {
                        onChoices({ ...choices, shared: new Map(choices.shared).set(seq, kind) });
                      }}
                    />
                  ) : null}
                </Stack>
              </Box>
            );
          })}
        </Section>
      )}
      {preview.unowned.length === 0 ? null : (
        <Section title="Edits no page owns">
          {preview.unowned.map((file) => (
            <Group key={file.path} gap="sm" wrap="nowrap" justify="space-between">
              <Stack gap={0} style={{ minWidth: 0 }}>
                <Group gap="xs" wrap="nowrap">
                  <Text size="sm" ff="monospace" style={{ overflowWrap: 'anywhere' }}>
                    {file.path}
                  </Text>
                  <Text size="xs" c="dimmed" style={{ flex: 'none' }}>
                    {`+${String(file.added)} −${String(file.removed)}`}
                  </Text>
                </Group>
                {file.fromBeforePass ? (
                  <Text size="xs" c="dimmed">
                    From before the pass
                  </Text>
                ) : null}
              </Stack>
              <Select
                aria-label={`Where ${file.path} goes`}
                size="xs"
                w={150}
                allowDeselect={false}
                disabled={disabled}
                data={fileChoices}
                value={placement(landing, choices, file.path) ?? LEAVE_OUT}
                onChange={(value) => {
                  const page = landing.find((candidate) => candidate.taskId === value);
                  onChoices({
                    ...choices,
                    files: new Map(choices.files).set(file.path, page?.taskId ?? null),
                  });
                }}
              />
            </Group>
          ))}
        </Section>
      )}
      {preview.foreignCommits.length === 0 ? null : (
        <Section title="Commits 10db did not make">
          <Text size="sm">These commits ride the pull request:</Text>
          <List size="sm" spacing={2}>
            {preview.foreignCommits.map((commit) => (
              <List.Item key={commit.sha}>
                <Text size="sm" ff="monospace" span>
                  {`${commit.sha.slice(0, 7)} ${commit.subject}`}
                </Text>
              </List.Item>
            ))}
          </List>
        </Section>
      )}
    </Stack>
  );
}

/** What a confirm found changed in the lists, said before the builder confirms again; null when nothing. */
function changedLine(changed: readonly string[]): string | null {
  if (changed.length === 0) return null;
  return `The lists changed since you looked: ${changed.join('; ')}. Check them and close again.`;
}

export interface ClosePassModalProps {
  readonly view: PassViewDto;
  readonly onClose: () => void;
}

/**
 * Close Pass…'s form modal: the lists `GET /passes/:passId/close` gives, each with its safe default,
 * the gate's consequence and the summary above the footer, and Cancel and Close Pass.
 */
export function ClosePassModal({ view, onClose }: ClosePassModalProps) {
  const read = useClosePreview(view.pass.id);
  const closing = useClosePass();
  // The lists the daemon answered a confirm with, once they changed, and what changed in them.
  const [again, setAgain] = useState<{
    readonly preview: PassClosePreviewDto;
    readonly changed: readonly string[];
  } | null>(null);
  const [choices, setChoices] = useState<CloseChoices>(NO_CLOSE_CHOICES);
  const preview = again?.preview ?? read.data;
  return (
    <FormModal
      opened
      onClose={onClose}
      title="Close Pass"
      size="lg"
      // What changed goes beside Close Pass, where the next click lands, and is announced there.
      error={closing.error?.message ?? read.error?.message ?? changedLine(again?.changed ?? [])}
      actions={
        <>
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={closing.isPending}
            disabled={preview === undefined}
            onClick={() => {
              if (preview === undefined) return;
              closing.mutate(
                { passId: view.pass.id, request: closeRequest(preview, view.pages, choices) },
                {
                  onSuccess: (answer) => {
                    if (answer.outcome === 'closing') onClose();
                    else setAgain({ preview: answer.preview, changed: answer.changed });
                  },
                },
              );
            }}
          >
            Close Pass
          </Button>
        </>
      }
    >
      {preview === undefined ? (
        read.isPending ? (
          <Loader size="sm" role="status" aria-label="Reading what the close settles" />
        ) : null
      ) : (
        <Stack gap="lg">
          <CloseLists
            view={view}
            preview={preview}
            choices={choices}
            onChoices={setChoices}
            disabled={closing.isPending}
          />
          <Stack gap={4}>
            {preview.gate.consequence === null ? null : (
              <Text size="sm" c="dimmed">
                {preview.gate.consequence}
              </Text>
            )}
            <Text size="sm">{preview.summary}</Text>
          </Stack>
        </Stack>
      )}
    </FormModal>
  );
}
