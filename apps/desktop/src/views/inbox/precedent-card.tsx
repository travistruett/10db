import {
  PRECEDENT_CARD_DETAIL,
  PrecedentChoice,
  PrecedentKind,
  ProjectId,
  type InboxItemDto,
  type PrecedentAnswer,
  type PrecedentCandidateDto,
} from '@10db/contracts';
import {
  Alert,
  Box,
  Code,
  Paper,
  SegmentedControl,
  Spoiler,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { useState, type ReactNode } from 'react';
import { useAnswerPrecedents, usePrecedents } from '../../daemon/trust-queries';
import { GRANT_LIMIT_LABELS, PRECEDENT_SCOPE_LABELS } from '../settings/trust-rows';
import { CardActions } from './card-actions';
import { CardSurface } from './card-surface';
import { KEYS_IGNORE_ATTRIBUTE } from './use-inbox-keys';

/** What the builder picks for one kind; Later leaves it on the card. */
const KindAnswer = {
  Approve: 'Approve',
  KeepSkipping: 'Keep Skipping',
  Report: 'Report',
  Later: 'Later',
} as const;
type KindAnswer = (typeof KindAnswer)[keyof typeof KindAnswer];

const PICKS: readonly KindAnswer[] = [
  KindAnswer.Approve,
  KindAnswer.KeepSkipping,
  KindAnswer.Report,
  KindAnswer.Later,
];

/** The answer a pick sends; Later sends none. */
function choiceOf(pick: KindAnswer): PrecedentChoice | null {
  switch (pick) {
    case KindAnswer.Approve:
      return PrecedentChoice.Approve;
    case KindAnswer.KeepSkipping:
      return PrecedentChoice.KeepSkipping;
    case KindAnswer.Report:
      return PrecedentChoice.Report;
    case KindAnswer.Later:
      return null;
  }
}

/** Whether a card is a project's proposal of standing approvals. */
export function isPrecedentCard(item: InboxItemDto): boolean {
  return ProjectId.safeParse(item.detail?.[PRECEDENT_CARD_DETAIL]).success;
}

const entryKey = (c: Pick<PrecedentCandidateDto, 'programKey' | 'scope'>): string =>
  JSON.stringify([c.programKey, c.scope]);

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/** Approve unless a call of the kind was stopped at a named limit lately: that one starts on Later. */
const defaultPick = (c: PrecedentCandidateDto): KindAnswer =>
  c.stoppedAtLimit.length > 0 ? KindAnswer.Later : KindAnswer.Approve;

/** The report Report copies: the pattern, what it runs, the calls and the judge's worry, as plain text. */
function reportOf(c: PrecedentCandidateDto): string {
  return [
    `Standing approval candidate: ${JSON.stringify(c.programKey)} (${PRECEDENT_SCOPE_LABELS[c.scope]})`,
    `${String(c.skips)} skips, ${String(c.runCount)} runs, ${String(c.taskCount)} tasks`,
    c.topWorry === null
      ? "The judge's top worry: none read"
      : `The judge's top worry: ${GRANT_LIMIT_LABELS[c.topWorry.limit]}, ${String(Math.round(c.topWorry.p * 100))}%`,
    `What it runs: ${c.runs ?? "10db can't read what this runs"}`,
    'Calls:',
    ...c.examples.map((call) => `- ${JSON.stringify(call)}`),
  ].join('\n');
}

/** The agent's text, shown as text and folded when long. */
function Folded({ children }: { readonly children: string }) {
  return (
    <Spoiler maxHeight={120} showLabel="Show All" hideLabel="Show Less">
      <Code block style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {children}
      </Code>
    </Spoiler>
  );
}

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <Stack gap={2}>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      {children}
    </Stack>
  );
}

function KindEntry({
  candidate,
  pick,
  kind,
  onPick,
  onKind,
}: {
  readonly candidate: PrecedentCandidateDto;
  readonly pick: KindAnswer;
  readonly kind: string;
  readonly onPick: (pick: KindAnswer) => void;
  readonly onKind: (kind: string) => void;
}) {
  const parsed = PrecedentKind.safeParse(kind);
  const worry = candidate.topWorry;
  return (
    <Paper withBorder p="sm" radius="md">
      <Stack gap="sm">
        <TextInput
          label="Kind"
          description="One line every judge reads."
          value={kind}
          error={parsed.success ? null : parsed.error.issues[0]?.message}
          onChange={(e) => {
            onKind(e.currentTarget.value);
          }}
        />
        <Fact label="What it runs">
          {candidate.runs === null ? (
            <Text size="sm">10db can&apos;t read what this runs</Text>
          ) : (
            <Folded>{candidate.runs}</Folded>
          )}
        </Fact>
        {candidate.examples.length === 0 ? null : (
          <Fact label="Calls">
            <Stack gap={4}>
              {candidate.examples.map((call, index) => (
                <Code
                  key={index}
                  block
                  style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
                >
                  {call}
                </Code>
              ))}
            </Stack>
          </Fact>
        )}
        <Text size="sm" c="dimmed">
          {PRECEDENT_SCOPE_LABELS[candidate.scope]}
          {' · '}
          {`${String(candidate.skips)} ${plural(candidate.skips, 'skip', 'skips')}, ${String(candidate.runCount)} ${plural(candidate.runCount, 'run', 'runs')}, ${String(candidate.taskCount)} ${plural(candidate.taskCount, 'task', 'tasks')}`}
          {worry === null
            ? ''
            : ` · Top worry: ${GRANT_LIMIT_LABELS[worry.limit]}, ${String(Math.round(worry.p * 100))}%`}
        </Text>
        {candidate.stoppedAtLimit.length === 0 ? null : (
          <Alert color="yellow" variant="light">
            A call of this kind was stopped at {candidate.stoppedAtLimit.join(', ')} in the last 30
            days, so it is not ticked. Approving it never lets a call cross a limit.
          </Alert>
        )}
        <SegmentedControl
          aria-label={`Answer for ${kind}`}
          size="xs"
          value={pick}
          data={[...PICKS]}
          onChange={(value) => {
            const next = PICKS.find((p) => p === value);
            if (next !== undefined) onPick(next);
          }}
        />
      </Stack>
    </Paper>
  );
}

/**
 * A project's proposal of standing approvals: one entry per kind of command 10db's judge keeps doubting, each
 * answered Approve, Keep Skipping, Report or Later. One Save Answers sends every kind not on Later, and the
 * daemon rewords or resolves the card in the same write. Answered with its own buttons, never an Inbox key.
 */
export function PrecedentCard({
  item,
  header,
  framed = true,
}: {
  readonly item: InboxItemDto;
  readonly header: ReactNode;
  readonly framed?: boolean;
}) {
  const precedents = usePrecedents(item.projectId);
  const answer = useAnswerPrecedents(item.projectId);
  const [picks, setPicks] = useState<Readonly<Record<string, KindAnswer>>>({});
  const [kinds, setKinds] = useState<Readonly<Record<string, string>>>({});
  const candidates = precedents.data?.candidates ?? [];
  const pickOf = (c: PrecedentCandidateDto): KindAnswer => picks[entryKey(c)] ?? defaultPick(c);
  const kindOf = (c: PrecedentCandidateDto): string => kinds[entryKey(c)] ?? c.kind;
  const chosen = candidates.filter((c) => pickOf(c) !== KindAnswer.Later);
  const invalid = chosen.some((c) => !PrecedentKind.safeParse(kindOf(c)).success);

  const save = (): void => {
    const reports = chosen.filter((c) => pickOf(c) === KindAnswer.Report).map(reportOf);
    if (reports.length > 0) {
      // The copy is a courtesy: a clipboard that refuses never stops the answer.
      void navigator.clipboard.writeText(reports.join('\n\n')).catch(() => undefined);
    }
    const body: PrecedentAnswer = {
      kinds: chosen.flatMap((c) => {
        const choice = choiceOf(pickOf(c));
        return choice === null
          ? []
          : [
              {
                programKey: c.programKey,
                scope: c.scope,
                choice,
                kind: PrecedentKind.parse(kindOf(c)),
              },
            ];
      }),
    };
    answer.mutate(body);
  };

  const skips = candidates.reduce((sum, c) => sum + c.skips, 0);
  const runs = candidates.reduce((sum, c) => sum + c.runCount, 0);
  return (
    <CardSurface framed={framed} selected>
      <Box {...{ [KEYS_IGNORE_ATTRIBUTE]: true }} style={{ flex: 1 }}>
        <Stack gap="md">
          {header}
          {precedents.isError ? <Alert color="red">{precedents.error.message}</Alert> : null}
          {precedents.data === undefined ? null : candidates.length === 0 ? (
            <Text size="sm" c="dimmed">
              Nothing is left to make routine.
            </Text>
          ) : (
            <>
              <Text size="sm">
                {`${String(skips)} skipped ${plural(skips, 'call', 'calls')} in ${String(runs)} ${plural(runs, 'run', 'runs')}. A kind you approve is a standing approval 10db's judge weighs on every later call; it never lets a call cross a limit. Report copies what 10db needs to look at it and leaves the kind here.`}
              </Text>
              {candidates.map((candidate) => (
                <KindEntry
                  key={entryKey(candidate)}
                  candidate={candidate}
                  pick={pickOf(candidate)}
                  kind={kindOf(candidate)}
                  onPick={(pick) => {
                    setPicks((saved) => ({ ...saved, [entryKey(candidate)]: pick }));
                  }}
                  onKind={(kind) => {
                    setKinds((saved) => ({ ...saved, [entryKey(candidate)]: kind }));
                  }}
                />
              ))}
            </>
          )}
        </Stack>
      </Box>
      <CardActions
        framed={framed}
        error={answer.isError ? answer.error.message : null}
        primary={{
          label: 'Save Answers',
          loading: answer.isPending,
          disabled: chosen.length === 0 || invalid,
          onClick: save,
        }}
      />
    </CardSurface>
  );
}
