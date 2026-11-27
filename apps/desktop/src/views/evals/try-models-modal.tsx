import {
  EvalSweepKind,
  EvalSweepReason,
  EvalSweepState,
  EvalSweepStepState,
  type EvalCandidateDto,
  type EvalLivePreviewDto,
  type EvalSweepDto,
  type ProjectId,
} from '@10db/contracts';
import {
  Anchor,
  Button,
  Checkbox,
  Group,
  Loader,
  Modal,
  NumberInput,
  Stack,
  Table,
  Text,
  TextInput,
} from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import {
  useEvalCandidates,
  useEvalLivePreview,
  useLatestEvalSweep,
  useStartEvalSweep,
  useStopEvalSweep,
  useSwitchEvalModel,
} from '../../daemon/evals-queries';
import { costText, dayTimeText } from './eval-figures';
import { changedRefusal, Notes, REFUSAL_WORDS } from './live-run-modal';

/** What the drawer's two sweep buttons open, and the window of a sweep already going. */
export const TryMode = { Try: 'try', Cheapest: 'cheapest', Window: 'window' } as const;
export type TryMode = (typeof TryMode)[keyof typeof TryMode];

/** The most models a sweep takes (`StartEvalSweepBody`). */
const MAX_PICKS = 10;
/** Candidates drawn at once; an OpenRouter suite lists hundreds, so the search narrows them. */
const SHOWN = 40;

const STEP_WORDS: Readonly<Record<EvalSweepStepState, string>> = {
  [EvalSweepStepState.Waiting]: 'Waiting',
  [EvalSweepStepState.Running]: 'Running',
  [EvalSweepStepState.Passed]: 'Passed every gate',
  [EvalSweepStepState.Failed]: 'Failed',
  [EvalSweepStepState.Unreadable]: 'No result 10db could read',
  [EvalSweepStepState.Stopped]: 'Stopped',
  [EvalSweepStepState.Skipped]: 'Skipped',
};

const REASON_WORDS: Readonly<Record<EvalSweepReason, string>> = {
  [EvalSweepReason.Capped]: 'The next run could cost more than what is left under the cap.',
  [EvalSweepReason.Unreadable]: 'A run finished with no result 10db could read.',
  [EvalSweepReason.CostUnknown]: "The next model's cost can't be estimated, so 10db did not guess.",
  [EvalSweepReason.Interrupted]: '10db stopped while it ran.',
  [EvalSweepReason.Refused]: 'The next run was refused.',
  [EvalSweepReason.ByYou]: 'You stopped it.',
};

/** The sweep's outcome in words: the winner, or why it ended. */
export function sweepVerdict(sweep: EvalSweepDto): string {
  const reason =
    sweep.reason === null
      ? ''
      : sweep.reason === EvalSweepReason.Refused && sweep.reasonText !== null
        ? ` ${sweep.reasonText}`
        : ` ${REASON_WORDS[sweep.reason]}`;
  switch (sweep.state) {
    case EvalSweepState.Running:
      return 'Running.';
    case EvalSweepState.Found:
      return `${sweep.winner ?? 'A model'} is the cheapest that passes every gate.${reason}`;
    case EvalSweepState.Done:
      return sweep.kind === EvalSweepKind.Cheapest
        ? `No cheaper model passed every gate.${reason}`
        : `Every picked model ran.${reason}`;
    case EvalSweepState.Stopped:
      return `Stopped.${reason}`;
  }
}

const lastResult = (c: EvalCandidateDto): string =>
  c.last === null
    ? 'Not run here'
    : `${c.last.passed ? 'Passed' : 'Failed'} ${dayTimeText(c.last.at)}`;

/** A sweep's steps, what it spent of its cap and Stop; the end shows the verdict in words. */
function SweepWindow({
  projectId,
  suiteKey,
  sweep,
  onClose,
}: {
  readonly projectId: ProjectId;
  readonly suiteKey: string;
  readonly sweep: EvalSweepDto;
  readonly onClose: () => void;
}) {
  const stop = useStopEvalSweep(projectId);
  const running = sweep.state === EvalSweepState.Running;
  const stopping = stop.isPending || stop.isSuccess;
  const switchTo = useSwitchEvalModel(projectId, suiteKey);
  return (
    <Stack gap="sm" data-testid="sweep-window">
      <Group justify="space-between" wrap="nowrap">
        <Text size="sm" fw={600}>
          {`Spent ${costText(sweep.spentUsd)} of ${costText(sweep.capUsd)}`}
        </Text>
        {running ? (
          stopping ? (
            <Text size="sm" c="dimmed">
              Stopping
            </Text>
          ) : (
            <Button
              size="xs"
              color="red"
              variant="light"
              onClick={() => {
                stop.mutate(sweep.id);
              }}
            >
              Stop
            </Button>
          )
        ) : (
          <Button size="xs" variant="default" onClick={onClose}>
            Close
          </Button>
        )}
      </Group>
      <Table withRowBorders={false} verticalSpacing={4} horizontalSpacing={0} fz="sm">
        <Table.Tbody>
          {sweep.steps.map((step) => (
            <Table.Tr key={step.model}>
              <Table.Td style={{ overflowWrap: 'anywhere' }}>{step.model}</Table.Td>
              <Table.Td
                c={
                  step.state === EvalSweepStepState.Failed ||
                  step.state === EvalSweepStepState.Unreadable
                    ? 'red'
                    : 'dimmed'
                }
              >
                {STEP_WORDS[step.state]}
              </Table.Td>
              <Table.Td ta="right">
                {step.costUsd !== null
                  ? costText(step.costUsd)
                  : step.state === EvalSweepStepState.Waiting && step.estimateUsd !== null
                    ? `about ${costText(step.estimateUsd)}`
                    : ''}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {stop.isError ? (
        <Text size="sm" c="red">
          {stop.error.message}
        </Text>
      ) : null}
      {running ? null : (
        <Text size="sm" fw={500}>
          {sweepVerdict(sweep)}
        </Text>
      )}
      {sweep.state === EvalSweepState.Found && sweep.winner !== null ? (
        switchTo.data ? (
          <Text size="sm">
            Task created:{' '}
            <Anchor
              onClick={onClose}
              renderRoot={(props) => (
                <Link {...props} to="/board" search={{ task: switchTo.data.id }} />
              )}
            >
              {switchTo.data.title}
            </Anchor>
            . An agent edits the binding; the suites on the slot show "not run" until you run them.
          </Text>
        ) : (
          <Group gap="xs">
            <Button
              size="xs"
              loading={switchTo.isPending}
              onClick={() => {
                if (sweep.winner !== null) switchTo.mutate(sweep.winner);
              }}
            >
              {`Switch to ${sweep.winner}`}
            </Button>
            {switchTo.isError ? (
              <Text size="sm" c="red">
                {switchTo.error.message}
              </Text>
            ) : null}
          </Group>
        )
      ) : null}
    </Stack>
  );
}

/** The cap that opens the window: three runs' worth of the latest run's cost, to the next dollar. */
function defaultCap(
  lastRunCostUsd: number | null,
  models: number,
  kind: EvalSweepKind,
): number | null {
  if (lastRunCostUsd === null) return null;
  const runs = kind === EvalSweepKind.Cheapest ? 3 : Math.max(3, models);
  return Math.max(1, Math.ceil(lastRunCostUsd * runs));
}

/** Candidates the sweep would start with: Find Cheapest preselects the known estimates under today's cheapest pass. */
function preselected(
  candidates: readonly EvalCandidateDto[],
  kind: EvalSweepKind,
  cheapestPassUsd: number | null,
): readonly string[] {
  if (kind === EvalSweepKind.Try) return [];
  return candidates
    .filter(
      (c) =>
        c.estimateUsd !== null && (cheapestPassUsd === null || c.estimateUsd < cheapestPassUsd),
    )
    .slice(0, MAX_PICKS)
    .map((c) => c.model);
}

function Picker({
  candidates,
  kind,
  cheapestPassUsd,
  lastRunCostUsd,
  onContinue,
}: {
  readonly candidates: readonly EvalCandidateDto[];
  readonly kind: EvalSweepKind;
  readonly cheapestPassUsd: number | null;
  readonly lastRunCostUsd: number | null;
  readonly onContinue: (models: readonly string[], capUsd: number) => void;
}) {
  const [picked, setPicked] = useState<readonly string[]>(() =>
    preselected(candidates, kind, cheapestPassUsd),
  );
  const [search, setSearch] = useState('');
  const [cap, setCap] = useState<number | null>(null);
  const needle = search.trim().toLowerCase();
  const matching = candidates.filter(
    (c) =>
      needle === '' ||
      c.model.toLowerCase().includes(needle) ||
      (c.name ?? '').toLowerCase().includes(needle),
  );
  const shown = matching.slice(0, SHOWN);
  const capUsd = cap ?? defaultCap(lastRunCostUsd, picked.length, kind);
  const problem =
    picked.length === 0
      ? 'Pick at least one model.'
      : capUsd === null || capUsd <= 0
        ? 'Set the most to spend.'
        : null;
  if (candidates.length === 0)
    return (
      <Text size="sm" c="dimmed">
        This suite has no models to try.
      </Text>
    );
  return (
    <Stack gap="sm">
      <Text size="xs" c="dimmed">
        {kind === EvalSweepKind.Cheapest
          ? "Tries the picked models cheapest first and stops at the first that passes every gate. Preselected: models cheaper than today's cheapest pass."
          : 'Runs the suite on every picked model, in order. The estimate scales the latest run by output price.'}
      </Text>
      {candidates.length > SHOWN ? (
        <TextInput
          size="xs"
          aria-label="Search models"
          placeholder="Search models"
          value={search}
          onChange={(e) => {
            setSearch(e.currentTarget.value);
          }}
        />
      ) : null}
      <Table verticalSpacing={4} horizontalSpacing="xs" fz="sm" data-testid="candidates">
        <Table.Thead>
          <Table.Tr>
            <Table.Th w={28} />
            <Table.Th fz="xs" c="dimmed" fw={500}>
              Model
            </Table.Th>
            <Table.Th fz="xs" c="dimmed" fw={500} ta="right">
              Intelligence
            </Table.Th>
            <Table.Th fz="xs" c="dimmed" fw={500} ta="right">
              Output / 1M
            </Table.Th>
            <Table.Th fz="xs" c="dimmed" fw={500} ta="right">
              Estimate
            </Table.Th>
            <Table.Th fz="xs" c="dimmed" fw={500}>
              Last result
            </Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {shown.map((c) => {
            const on = picked.includes(c.model);
            return (
              <Table.Tr key={c.model}>
                <Table.Td>
                  <Checkbox
                    size="xs"
                    aria-label={`Pick ${c.model}`}
                    checked={on}
                    disabled={!on && picked.length >= MAX_PICKS}
                    onChange={(e) => {
                      const next = e.currentTarget.checked;
                      setPicked((now) =>
                        next ? [...now, c.model] : now.filter((m) => m !== c.model),
                      );
                    }}
                  />
                </Table.Td>
                <Table.Td style={{ overflowWrap: 'anywhere' }}>{c.name ?? c.model}</Table.Td>
                <Table.Td ta="right">
                  {c.intelligence === null ? '—' : String(Math.round(c.intelligence * 10) / 10)}
                </Table.Td>
                <Table.Td ta="right">
                  {c.outputPrice === null ? '—' : `$${c.outputPrice.toFixed(2)}`}
                </Table.Td>
                <Table.Td ta="right">
                  {c.estimateUsd === null ? '—' : costText(c.estimateUsd)}
                </Table.Td>
                <Table.Td c={c.last?.passed === false ? 'red' : 'dimmed'}>{lastResult(c)}</Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
      {matching.length > SHOWN ? (
        <Text size="xs" c="dimmed">
          {`${String(matching.length - SHOWN)} more; search to narrow the list.`}
        </Text>
      ) : null}
      <Group justify="space-between" align="flex-end" wrap="nowrap">
        <NumberInput
          size="xs"
          label="Most to spend"
          description="The sweep stops before a run that could pass this."
          prefix="$"
          min={0.01}
          max={500}
          decimalScale={2}
          allowNegative={false}
          value={capUsd ?? ''}
          onChange={(v) => {
            setCap(typeof v === 'number' ? v : null);
          }}
          w={200}
        />
        <Group gap="xs" wrap="nowrap">
          {problem === null ? null : (
            <Text size="xs" c="dimmed">
              {problem}
            </Text>
          )}
          <Button
            disabled={problem !== null}
            onClick={() => {
              if (capUsd !== null) onContinue(picked, capUsd);
            }}
          >
            Continue
          </Button>
        </Group>
      </Group>
    </Stack>
  );
}

interface ConfirmProps {
  readonly projectId: ProjectId;
  readonly suiteKey: string;
  readonly kind: EvalSweepKind;
  readonly models: readonly string[];
  readonly capUsd: number;
  readonly candidates: readonly EvalCandidateDto[];
  readonly onBack: () => void;
  readonly onStarted: (sweep: EvalSweepDto) => void;
}

/** Waits for the preview of these picks, then holds the window to the one it first showed. */
function Confirm(props: ConfirmProps) {
  const preview = useEvalLivePreview(props.projectId, props.suiteKey, true, props.models);
  if (preview.data === undefined)
    return preview.isError ? (
      <Text size="sm" c="red">
        {preview.error.message}
      </Text>
    ) : (
      <Loader size="sm" />
    );
  return <ConfirmWindow key={props.models.join(',')} {...props} data={preview.data} />;
}

function ConfirmWindow({
  suiteKey,
  projectId,
  kind,
  models,
  capUsd,
  candidates,
  onBack,
  onStarted,
  data,
}: ConfirmProps & { readonly data: EvalLivePreviewDto }) {
  const start = useStartEvalSweep(projectId, suiteKey);
  // The hash of the preview the builder was shown, held from the first load: Start always sends it, and a
  // refetch that changes the live hash waits for the builder to accept the new window. New picks mount anew.
  const [shownHash, setSeen] = useState(data.previewHash);
  const changed = data.previewHash !== shownHash;
  const estimates = models.map((m) => candidates.find((c) => c.model === m)?.estimateUsd ?? null);
  const known = estimates.filter((e): e is number => e !== null);
  const unknown = estimates.length - known.length;
  const total = known.reduce((a, b) => a + b, 0);
  return (
    <Stack gap="md">
      <Stack gap={2}>
        {models.map((m) => (
          <Text key={m} size="sm" style={{ overflowWrap: 'anywhere' }}>
            {m}
          </Text>
        ))}
      </Stack>
      <Text size="sm">
        {`Estimated ${known.length === 0 ? 'unknown' : costText(total)}${unknown > 0 && known.length > 0 ? ` plus ${String(unknown)} with no estimate` : ''}, cap ${costText(capUsd)}; one run can cost more than its estimate.`}
        {kind === EvalSweepKind.Cheapest ? ' It stops at the first model that passes.' : ''}
      </Text>
      {changed ? (
        <Text size="sm" c="yellow">
          This window now shows what changed. Check it, then press Start.
        </Text>
      ) : null}
      {data.refusal !== null ? (
        <Text size="sm" c="red" data-testid="live-refusal">
          {REFUSAL_WORDS[data.refusal]}
        </Text>
      ) : (
        <>
          <Notes preview={data} />
          {start.isError && !changedRefusal(start.error) ? (
            <Text size="sm" c="red">
              {start.error.message}
            </Text>
          ) : null}
        </>
      )}
      <Group justify="space-between">
        <Button variant="subtle" onClick={onBack}>
          Back
        </Button>
        {data.refusal !== null ? null : changed ? (
          <Button
            variant="default"
            onClick={() => {
              setSeen(data.previewHash);
            }}
          >
            Show what runs now
          </Button>
        ) : (
          <Button
            loading={start.isPending}
            onClick={() => {
              start.mutate(
                { kind, models: [...models], capUsd, previewHash: shownHash },
                { onSuccess: onStarted },
              );
            }}
          >
            Start
          </Button>
        )}
      </Group>
    </Stack>
  );
}

function Body({
  projectId,
  suiteKey,
  mode,
  cheapestPassUsd,
  onClose,
}: {
  readonly projectId: ProjectId;
  readonly suiteKey: string;
  readonly mode: TryMode;
  readonly cheapestPassUsd: number | null;
  readonly onClose: () => void;
}) {
  const candidates = useEvalCandidates(projectId, suiteKey, mode !== TryMode.Window);
  const preview = useEvalLivePreview(projectId, suiteKey, true);
  const latest = useLatestEvalSweep(projectId, suiteKey);
  const [picks, setPicks] = useState<{
    readonly models: readonly string[];
    readonly capUsd: number;
  } | null>(null);
  const [started, setStarted] = useState<EvalSweepDto | null>(null);
  const kind = mode === TryMode.Cheapest ? EvalSweepKind.Cheapest : EvalSweepKind.Try;
  // The sweep this window started shows until the refetch brings the same one (or a newer) back.
  const sweep = latest.data?.id === started?.id || started === null ? latest.data : started;
  if (mode === TryMode.Window || started !== null) {
    return sweep ? (
      <SweepWindow projectId={projectId} suiteKey={suiteKey} sweep={sweep} onClose={onClose} />
    ) : (
      <Loader size="sm" />
    );
  }
  if (candidates.data === undefined)
    return candidates.isError ? (
      <Text size="sm" c="red">
        {candidates.error.message}
      </Text>
    ) : (
      <Loader size="sm" />
    );
  if (picks === null)
    return (
      <Picker
        candidates={candidates.data}
        kind={kind}
        cheapestPassUsd={cheapestPassUsd}
        lastRunCostUsd={preview.data?.lastRunCostUsd ?? null}
        onContinue={(models, capUsd) => {
          setPicks({ models, capUsd });
        }}
      />
    );
  return (
    <Confirm
      projectId={projectId}
      suiteKey={suiteKey}
      kind={kind}
      models={picks.models}
      capUsd={picks.capUsd}
      candidates={candidates.data}
      onBack={() => {
        setPicks(null);
      }}
      onStarted={setStarted}
    />
  );
}

const TITLES: Readonly<Record<TryMode, string>> = {
  [TryMode.Try]: 'Try other models',
  [TryMode.Cheapest]: 'Find the cheapest passing model',
  [TryMode.Window]: 'Model sweep',
};

/** The picker, the confirm window and the sweep's progress, one after the other in one modal. */
export function TryModelsModal({
  projectId,
  suiteKey,
  mode,
  cheapestPassUsd,
  onClose,
}: {
  readonly projectId: ProjectId;
  readonly suiteKey: string;
  /** Null while closed. */
  readonly mode: TryMode | null;
  /** The cheapest model that passes in the suite's latest run, when its cost is known. */
  readonly cheapestPassUsd: number | null;
  readonly onClose: () => void;
}) {
  return (
    <Modal
      opened={mode !== null}
      onClose={onClose}
      title={mode === null ? '' : TITLES[mode]}
      size="xl"
    >
      {mode === null ? null : (
        <Body
          projectId={projectId}
          suiteKey={suiteKey}
          mode={mode}
          cheapestPassUsd={cheapestPassUsd}
          onClose={onClose}
        />
      )}
    </Modal>
  );
}
