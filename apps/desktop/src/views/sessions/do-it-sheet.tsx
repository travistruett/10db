import {
  Delivery,
  DoItPlace,
  type ChatDto,
  type DoItOfferDto,
  type DoItResult,
  type ProjectViewDto,
} from '@10db/contracts';
import {
  Anchor,
  Box,
  Button,
  Group,
  SegmentedControl,
  Stack,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { OWNS_ESCAPE_ATTRIBUTE } from '../../conversation/escape';
import { useAskBrief, useCancelBrief, useDoIt, useDoItPreview } from '../../daemon/do-it-queries';
import { CodeSpans } from '../../shell/code-spans';
import { FormModal } from '../../shell/form-modal';
import { useSelectedProject } from '../../shell/selected-project';
import {
  briefSourceLine,
  changedHeading,
  changedShown,
  chatFate,
  fateLine,
  linkLabel,
  parseRefusalLink,
  placeLabel,
  placeLine,
  startLine,
} from './do-it-words';

// Sessions UI §8.1: Do It's sheet. It says where the work goes, which files stay or join, and what
// happens to the chat, before the builder presses it.

const BRIEF_LABEL = 'Brief';

export interface DoItSheetProps {
  readonly chat: ChatDto;
  readonly project: ProjectViewDto;
  /** The chat's agent (`capabilities.label`) and its model, which the sheet shows as one dimmed line. */
  readonly agentLabel: string;
  readonly model: string | null;
  /** The place picked when the sheet opens; Separate copy otherwise. */
  readonly place?: DoItPlace;
  /** The builder's unsent draft, which the brief's request includes. */
  readonly draft?: string;
  readonly onClose: () => void;
  /** Do It was accepted: the work is a task (or a pass waiting to open). */
  readonly onDone: (result: DoItResult, title: string) => void;
}

function Refusal({
  offer,
  onNavigate,
}: {
  readonly offer: DoItOfferDto;
  readonly onNavigate: (projectId: string) => void;
}) {
  if (offer.refusal === null) return null;
  const link = parseRefusalLink(offer.refusal.link);
  return (
    <Group gap="xs" wrap="nowrap" align="flex-start">
      <Text size="sm" c="dimmed" role="status">
        <CodeSpans text={offer.refusal.message} />
      </Text>
      {link === null || link.kind === 'session' ? null : (
        <Anchor
          size="sm"
          style={{ flex: 'none' }}
          onClick={() => {
            onNavigate(link.projectId);
          }}
          renderRoot={(props) => (
            <Link {...props} to={link.kind === 'workbench' ? '/workbench' : '/board'} />
          )}
        >
          {linkLabel(link)}
        </Anchor>
      )}
    </Group>
  );
}

/** The sheet: a title, the brief, where the work goes, the files left uncommitted, and Do It. */
export function DoItSheet({
  chat,
  project,
  agentLabel,
  model,
  place: initialPlace,
  draft,
  onClose,
  onDone,
}: DoItSheetProps) {
  const preview = useDoItPreview(chat.id, true);
  const ask = useAskBrief();
  const cancel = useCancelBrief();
  const doIt = useDoIt();
  const { select } = useSelectedProject();
  // What the builder typed; null while the field still takes the daemon's brief. Typing stops the brief
  // being taken, not the agent writing it.
  const [typedTitle, setTypedTitle] = useState<string | null>(null);
  const [typedBrief, setTypedBrief] = useState<string | null>(null);
  const [picked, setPicked] = useState<DoItPlace | null>(initialPlace ?? null);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const asked = useRef(false);

  // The brief is asked for once when the sheet opens; mid-turn the daemon answers with the chat so far.
  const askBrief = ask.mutate;
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    askBrief(
      draft === undefined || draft.trim() === '' ? { chatId: chat.id } : { chatId: chat.id, draft },
    );
  }, [askBrief, chat.id, draft]);

  const data = preview.data;
  const brief = data?.brief;
  const title = typedTitle ?? brief?.title ?? '';
  const text = typedBrief ?? brief?.text ?? '';
  const offers = (p: DoItPlace): boolean =>
    data === undefined || (p === DoItPlace.Here ? data.here : data.worktree).offered;
  // A place that is refused is never the one in force: the sheet falls to the other when only it is offered.
  const effective: DoItPlace =
    picked !== null && offers(picked)
      ? picked
      : offers(DoItPlace.Worktree)
        ? DoItPlace.Worktree
        : offers(DoItPlace.Here)
          ? DoItPlace.Here
          : DoItPlace.Worktree;
  const offer =
    data === undefined ? null : effective === DoItPlace.Here ? data.here : data.worktree;
  const canSubmit =
    data !== undefined &&
    offer?.offered === true &&
    title.trim() !== '' &&
    text.trim() !== '' &&
    !doIt.isPending;

  const submit = (): void => {
    if (!canSubmit || brief === undefined) return;
    setError(null);
    doIt.mutate(
      {
        chatId: chat.id,
        request: {
          place: effective,
          title: title.trim(),
          brief: text,
          ...(brief.areas.length === 0 ? {} : { areas: brief.areas }),
          ...(brief.criteria.length === 0 ? {} : { acceptanceCriteria: brief.criteria }),
        },
      },
      {
        onSuccess: (result) => {
          onDone(result, title.trim());
        },
        onError: (failure) => {
          setError(failure.message);
        },
      },
    );
  };

  const close = (): void => {
    // A brief still being written is dropped with the sheet; a turn the builder began since is not touched.
    if (brief?.writing === true) cancel.mutate(chat.id);
    onClose();
  };

  const shown = data === undefined ? null : changedShown(data.changed, expanded);
  const words = {
    name: project.name,
    baseBranch: project.baseBranch,
    local: project.delivery === Delivery.Local,
  };
  const start = data === undefined || effective !== DoItPlace.Worktree ? null : startLine(data);

  return (
    <FormModal
      opened
      onClose={close}
      title="Do It"
      size={560}
      error={error}
      actions={
        <>
          <Button variant="default" onClick={close}>
            Cancel
          </Button>
          <Button disabled={!canSubmit} loading={doIt.isPending} onClick={submit}>
            Do It
          </Button>
        </>
      }
    >
      <Box
        {...{ [OWNS_ESCAPE_ATTRIBUTE]: '' }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit();
          }
        }}
      >
        <Stack gap="md">
          <TextInput
            label="Title"
            value={title}
            onChange={(event) => {
              setTypedTitle(event.currentTarget.value);
            }}
          />
          <Stack gap={4}>
            <Textarea
              label={BRIEF_LABEL}
              autosize
              minRows={5}
              maxRows={12}
              value={text}
              placeholder={brief?.writing === true ? 'Writing the brief…' : undefined}
              aria-busy={brief?.writing === true}
              onChange={(event) => {
                setTypedBrief(event.currentTarget.value);
              }}
            />
            {brief?.writing === true && typedBrief === null ? (
              <Text size="xs" c="dimmed" role="status">
                Writing the brief…
              </Text>
            ) : brief === undefined ? null : (
              <Text size="xs" c="dimmed">
                {briefSourceLine(brief, agentLabel)}
              </Text>
            )}
            {brief === undefined ||
            (brief.areas.length === 0 && brief.criteria.length === 0) ? null : (
              <Stack gap={2}>
                {brief.areas.length === 0 ? null : (
                  <Text size="xs" c="dimmed">
                    Areas: {brief.areas.join(', ')}
                  </Text>
                )}
                {brief.criteria.map((criterion) => (
                  <Text key={criterion} size="xs" c="dimmed">
                    ✓ {criterion}
                  </Text>
                ))}
              </Stack>
            )}
          </Stack>
          <Stack gap="xs">
            <Text size="sm" fw={500}>
              Where
            </Text>
            <SegmentedControl
              aria-label="Where the work goes"
              size="xs"
              value={effective}
              data={Object.values(DoItPlace).map((p) => ({
                value: p,
                label: placeLabel(p),
                disabled:
                  data !== undefined && !(p === DoItPlace.Here ? data.here : data.worktree).offered,
              }))}
              onChange={(value) => {
                const next = Object.values(DoItPlace).find((p) => p === value);
                if (next !== undefined) setPicked(next);
              }}
            />
            {data === undefined ? null : (
              <>
                {(['worktree', 'here'] as const).map((p) => {
                  const o = p === DoItPlace.Here ? data.here : data.worktree;
                  return o.offered ? null : (
                    <Refusal
                      key={p}
                      offer={o}
                      onNavigate={(id) => {
                        select(id as ProjectViewDto['id']);
                      }}
                    />
                  );
                })}
                {offer?.offered === true ? (
                  <>
                    <Text size="sm" c="dimmed">
                      <CodeSpans text={placeLine(effective, words)} />
                    </Text>
                    {start === null ? null : (
                      <Text size="sm" c="dimmed">
                        <CodeSpans text={start} />
                      </Text>
                    )}
                    {effective === DoItPlace.Here && data.stacksOn !== null ? (
                      <Text size="sm" c="dimmed">
                        It waits on the pass ‘{data.stacksOn}’ for its pull request to merge.
                      </Text>
                    ) : null}
                  </>
                ) : null}
                {shown !== null && data.changed.length > 0 ? (
                  <Stack gap={2} data-testid="changed-files">
                    <Text size="sm">{changedHeading(data.changed.length, data.more)}</Text>
                    <Box
                      component="ul"
                      m={0}
                      pl={0}
                      style={{ listStyle: 'none', columnCount: 2, columnGap: 16 }}
                    >
                      {shown.shown.map((entry) => (
                        <Box component="li" key={entry.path} style={{ breakInside: 'avoid' }}>
                          <Text size="xs" ff="monospace" component="span">
                            {entry.status} {entry.path}
                          </Text>
                        </Box>
                      ))}
                    </Box>
                    {shown.hidden > 0 ? (
                      <Anchor
                        component="button"
                        type="button"
                        size="xs"
                        style={{ alignSelf: 'flex-start' }}
                        onClick={() => {
                          setExpanded(true);
                        }}
                      >
                        Show {shown.hidden} More
                      </Anchor>
                    ) : data.more > 0 ? (
                      <Text size="xs" c="dimmed">
                        and {data.more} more
                      </Text>
                    ) : null}
                    <Text size="sm" c="dimmed">
                      {fateLine(effective)}
                    </Text>
                  </Stack>
                ) : null}
              </>
            )}
          </Stack>
          <Text size="xs" c="dimmed">
            {model === null ? agentLabel : `${agentLabel} · ${model}`}
          </Text>
          <Stack gap={2}>
            {data?.runningTurn === true ? (
              <Text size="sm">The turn that&apos;s running stops first.</Text>
            ) : null}
            <Text size="sm">{chatFate(effective)}</Text>
          </Stack>
        </Stack>
      </Box>
    </FormModal>
  );
}
