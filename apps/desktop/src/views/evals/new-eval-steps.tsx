import {
  EvalBarChoice,
  EvalCaseVerdict,
  EvalCheckKind,
  EvalPick,
  MAX_NEW_EVAL_CASES,
  type EvalSuggestedCase,
  type ModelRowDto,
} from '@10db/contracts';
import {
  ActionIcon,
  Anchor,
  Box,
  Button,
  Group,
  MultiSelect,
  NumberInput,
  Radio,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
  Textarea,
  type ComboboxItem,
} from '@mantine/core';
import { IconX } from '@tabler/icons-react';
import { useState, type ReactNode } from 'react';
import { CreateButton } from '../../shell/create-button';
import { formatCost, formatScore } from '../settings/model-format';
import {
  BAR_HELP,
  BAR_LABEL,
  BEHAVIOR_MAX,
  CHECK_LABEL,
  GOAL_MAX,
  MIN_CASES,
  cleanModelId,
  markedCases,
  type EvalDraft,
} from './new-eval-draft';
import { SuggestButton, type Suggestions } from './new-eval-suggest';

/** A step's state and the way to change it. */
export interface StepProps {
  readonly draft: EvalDraft;
  readonly change: (patch: Partial<EvalDraft>) => void;
}

/** The "why we ask" line under a step's question. */
function Why({ children }: { readonly children: ReactNode }) {
  return (
    <Text size="sm" c="dimmed">
      {children}
    </Text>
  );
}

const SAMPLE = {
  name: 'Order status replies',
  goal: 'When a customer asks where an order is, it replies with the status from the order data and never makes up a tracking number.',
} as const;

/** A suggestion the builder has not accepted yet: the text shown, with Use This and Dismiss. */
function Proposal({
  children,
  onUse,
  onDismiss,
}: {
  readonly children: ReactNode;
  readonly onUse: () => void;
  readonly onDismiss: () => void;
}) {
  return (
    <Box
      p="sm"
      style={{
        border: '1px solid var(--mantine-color-default-border)',
        borderRadius: 'var(--mantine-radius-md)',
      }}
    >
      <Stack gap="xs">
        {children}
        <Group gap="xs">
          <Button size="compact-xs" onClick={onUse}>
            Use This
          </Button>
          <Button size="compact-xs" variant="default" onClick={onDismiss}>
            Dismiss
          </Button>
        </Group>
      </Stack>
    </Box>
  );
}

export function GoalStep({
  draft,
  change,
  suggestions,
}: StepProps & { readonly suggestions: Suggestions }) {
  const [better, setBetter] = useState<string | null>(null);
  const tighten = async (): Promise<void> => {
    const answer = await suggestions.ask({ kind: 'tighten', behavior: draft.goal.trim() });
    if (answer?.kind === 'tighten') setBetter(answer.behavior);
  };
  return (
    <Stack gap="sm">
      <Text fw={600}>What should it do well?</Text>
      <Why>
        An eval is only as sharp as its goal. “Works well” can’t be checked; “never makes up a
        tracking number” can.
      </Why>
      <TextInput
        label="Short name"
        description="It ends up in the task’s title."
        placeholder="Order status replies"
        maxLength={BEHAVIOR_MAX}
        value={draft.name}
        onChange={(e) => {
          change({ name: e.currentTarget.value });
        }}
      />
      <Textarea
        label="In one sentence: what should it do, and what does a good result look like?"
        description="Pick one behavior, not the whole app, and say what you would check by eye."
        placeholder={SAMPLE.goal}
        autosize
        minRows={2}
        maxRows={6}
        maxLength={GOAL_MAX}
        value={draft.goal}
        onChange={(e) => {
          change({ goal: e.currentTarget.value });
        }}
      />
      <Group gap="md">
        <Anchor
          component="button"
          type="button"
          size="sm"
          onClick={() => {
            change({
              goal: SAMPLE.goal,
              ...(draft.name.trim() === '' ? { name: SAMPLE.name } : {}),
            });
          }}
        >
          Show an Example
        </Anchor>
        {suggestions.available ? (
          <SuggestButton
            label="Tighten This"
            busy={suggestions.busy}
            disabled={draft.goal.trim() === ''}
            onClick={() => void tighten()}
          />
        ) : null}
      </Group>
      {better === null ? null : (
        <Proposal
          onUse={() => {
            change({ goal: better });
            setBetter(null);
          }}
          onDismiss={() => {
            setBetter(null);
          }}
        >
          <Text size="xs" c="dimmed">
            Before
          </Text>
          <Text size="sm">{draft.goal}</Text>
          <Text size="xs" c="dimmed">
            After
          </Text>
          <Text size="sm">{better}</Text>
        </Proposal>
      )}
    </Stack>
  );
}

let nextCaseId = 1;
const newCaseId = (): number => nextCaseId++;

function CaseRow({
  index,
  row,
  onChange,
  onRemove,
}: {
  readonly index: number;
  readonly row: EvalDraft['cases'][number];
  readonly onChange: (patch: Partial<EvalDraft['cases'][number]>) => void;
  readonly onRemove: () => void;
}) {
  const mark = (verdict: EvalCaseVerdict, color: string, label: string) => (
    <Button
      variant={row.verdict === verdict ? 'light' : 'default'}
      {...(row.verdict === verdict ? { color } : {})}
      aria-pressed={row.verdict === verdict}
      onClick={() => {
        onChange({ verdict: row.verdict === verdict ? null : verdict });
      }}
    >
      {label}
    </Button>
  );
  return (
    <Stack
      gap="xs"
      p="sm"
      style={{
        border: '1px solid var(--mantine-color-default-border)',
        borderRadius: 'var(--mantine-radius-md)',
      }}
    >
      <Group gap="xs" wrap="nowrap" align="flex-start">
        <Textarea
          aria-label={`Example ${String(index + 1)} input`}
          placeholder="Where is my order 4412?"
          autosize
          minRows={1}
          maxRows={4}
          maxLength={1000}
          style={{ flex: 1 }}
          value={row.input}
          onChange={(e) => {
            onChange({ input: e.currentTarget.value });
          }}
        />
        <ActionIcon
          variant="subtle"
          color="gray"
          aria-label={`Remove example ${String(index + 1)}`}
          onClick={onRemove}
        >
          <IconX size={16} />
        </ActionIcon>
      </Group>
      <Group gap="xs" wrap="nowrap">
        <Button.Group>
          {mark(EvalCaseVerdict.Good, 'green', 'Good')}
          {mark(EvalCaseVerdict.Bad, 'red', 'Bad')}
        </Button.Group>
        <TextInput
          aria-label={`Example ${String(index + 1)} reason`}
          placeholder="Why, in one line"
          maxLength={300}
          style={{ flex: 1 }}
          value={row.reason}
          onChange={(e) => {
            onChange({ reason: e.currentTarget.value });
          }}
        />
      </Group>
    </Stack>
  );
}

export function ExamplesStep({
  draft,
  change,
  suggestions,
}: StepProps & { readonly suggestions: Suggestions }) {
  const [proposed, setProposed] = useState<readonly EvalSuggestedCase[]>([]);
  const addRow = (input = ''): void => {
    change({ cases: [...draft.cases, { id: newCaseId(), input, verdict: null, reason: '' }] });
  };
  const suggest = async (): Promise<void> => {
    const answer = await suggestions.ask({
      kind: 'cases',
      behavior: draft.goal.trim(),
      cases: draft.cases
        .filter((c) => c.input.trim() !== '')
        .map((c) => ({ input: c.input, verdict: c.verdict, reason: c.reason })),
    });
    if (answer?.kind === 'cases') setProposed(answer.cases);
  };
  const unmarked = draft.cases.filter((c) => c.input.trim() !== '' && c.verdict === null).length;
  return (
    <Stack gap="sm">
      <Text fw={600}>Real examples, good and bad</Text>
      <Why>
        Real cases show what you actually care about. Start with {MIN_CASES}; aim for 5 or more, and
        include real failures, odd inputs (empty, very long, off-topic) and hard calls. Mark each
        Good or Bad and say why in a line. You mark them, never the AI.
      </Why>
      {draft.cases.map((row, index) => (
        <CaseRow
          key={row.id}
          index={index}
          row={row}
          onChange={(patch) => {
            change({ cases: draft.cases.map((c) => (c.id === row.id ? { ...c, ...patch } : c)) });
          }}
          onRemove={() => {
            change({ cases: draft.cases.filter((c) => c.id !== row.id) });
          }}
        />
      ))}
      {draft.cases.length >= MAX_NEW_EVAL_CASES ? null : (
        <CreateButton
          label="Add Example"
          onClick={() => {
            addRow();
          }}
        />
      )}
      {unmarked === 0 ? null : (
        <Text size="xs" c="dimmed">
          {unmarked === 1
            ? '1 example has no mark yet and won’t be included.'
            : `${String(unmarked)} examples have no mark yet and won’t be included.`}
        </Text>
      )}
      {suggestions.available ? (
        <Group>
          <SuggestButton
            label="Suggest Cases"
            busy={suggestions.busy}
            disabled={draft.goal.trim() === ''}
            onClick={() => void suggest()}
          />
        </Group>
      ) : null}
      {proposed.map((p) => (
        <Proposal
          key={p.input}
          onUse={() => {
            addRow(p.input);
            setProposed((now) => now.filter((x) => x !== p));
          }}
          onDismiss={() => {
            setProposed((now) => now.filter((x) => x !== p));
          }}
        >
          <Text size="sm">{p.input}</Text>
          {p.reason === '' ? null : (
            <Text size="xs" c="dimmed">
              {p.reason}
            </Text>
          )}
        </Proposal>
      ))}
      {proposed.length === 0 ? null : (
        <Text size="xs" c="dimmed">
          A suggestion arrives with no mark: add the ones you want, then mark each Good or Bad.
        </Text>
      )}
    </Stack>
  );
}

const CHECK_HELP = {
  [EvalCheckKind.Rule]:
    'An exact answer, a “contains” or “doesn’t contain”, or a command that passes. Cheapest and most reliable. Recommended when it fits.',
  [EvalCheckKind.Judge]:
    'An AI reads each result, for tone or meaning a rule can’t see. The agent first checks the judge agrees with your Good and Bad marks.',
  [EvalCheckKind.Review]:
    'The agent leaves a short list of results for you to read, with no automatic grade.',
} as const satisfies Record<EvalCheckKind, string>;

const CHECK_ORDER = [EvalCheckKind.Rule, EvalCheckKind.Judge, EvalCheckKind.Review] as const;
const BAR_ORDER = [
  EvalBarChoice.EveryTime,
  EvalBarChoice.NineInTen,
  EvalBarChoice.SevenInTen,
] as const;

export function CheckingStep({
  draft,
  change,
  suggestions,
}: StepProps & { readonly suggestions: Suggestions }) {
  const [proposal, setProposal] = useState<{
    readonly check: EvalCheckKind;
    readonly rule: string;
  } | null>(null);
  const suggest = async (): Promise<void> => {
    const answer = await suggestions.ask({
      kind: 'check',
      behavior: draft.goal.trim(),
      cases: markedCases(draft).map((c) => ({
        input: c.input,
        verdict: c.verdict,
        reason: c.reason,
      })),
    });
    if (answer?.kind === 'check') setProposal({ check: answer.check, rule: answer.rule });
  };
  return (
    <Stack gap="sm">
      <Text fw={600}>How do we tell good from bad?</Text>
      <Why>
        A rule is cheap and exact, so use one when you can. Keep it pass or fail; a 1 to 5 score is
        harder to trust.
      </Why>
      <Radio.Group
        value={draft.check ?? ''}
        onChange={(value) => {
          const check = CHECK_ORDER.find((c) => c === value) ?? null;
          change({ check });
        }}
        aria-label="How a result is checked"
      >
        <Stack gap="xs">
          {CHECK_ORDER.map((kind) => (
            <Radio.Card key={kind} value={kind} p="sm" radius="md">
              <Group wrap="nowrap" align="flex-start" gap="sm">
                <Radio.Indicator mt={2} />
                <div>
                  <Text size="sm" fw={600}>
                    {CHECK_LABEL[kind]}
                    {kind === EvalCheckKind.Rule ? (
                      <Text span size="xs" c="dimmed" fw={400}>
                        {' '}
                        · recommended
                      </Text>
                    ) : null}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {CHECK_HELP[kind]}
                  </Text>
                </div>
              </Group>
            </Radio.Card>
          ))}
        </Stack>
      </Radio.Group>
      {draft.check === EvalCheckKind.Review ? null : (
        <Textarea
          label="What should the check look at? (optional)"
          placeholder="The reply contains the order status from the data and no tracking number that isn’t in it."
          autosize
          minRows={1}
          maxRows={4}
          maxLength={400}
          value={draft.checkRule}
          onChange={(e) => {
            change({ checkRule: e.currentTarget.value });
          }}
        />
      )}
      {suggestions.available ? (
        <Group>
          <SuggestButton
            label="Suggest a Check"
            busy={suggestions.busy}
            disabled={draft.goal.trim() === ''}
            onClick={() => void suggest()}
          />
        </Group>
      ) : null}
      {proposal === null ? null : (
        <Proposal
          onUse={() => {
            change({ check: proposal.check, checkRule: proposal.rule });
            setProposal(null);
          }}
          onDismiss={() => {
            setProposal(null);
          }}
        >
          <Text size="sm" fw={600}>
            {CHECK_LABEL[proposal.check]}
          </Text>
          {proposal.rule === '' ? null : <Text size="sm">{proposal.rule}</Text>}
        </Proposal>
      )}
      <div>
        <Text size="sm" fw={500} mb={4}>
          How often must it pass?
        </Text>
        <SegmentedControl
          fullWidth
          size="sm"
          aria-label="How often it must pass"
          value={draft.bar ?? ''}
          data={BAR_ORDER.map((bar) => ({ value: bar, label: BAR_LABEL[bar] }))}
          onChange={(value) => {
            change({ bar: BAR_ORDER.find((b) => b === value) ?? null });
          }}
        />
        <Text size="xs" c="dimmed" mt={4}>
          {draft.bar === null
            ? 'This is a product decision, not a score to maximize. Pick the one that fits.'
            : BAR_HELP[draft.bar]}
        </Text>
      </div>
    </Stack>
  );
}

/** One model as the picker shows it: its name, and its score and price where they are known. */
const modelNote = (row: ModelRowDto): string => {
  const score =
    row.intelligence === null ? 'score unknown' : `score ${formatScore(row.intelligence)}`;
  const price =
    row.costPerTaskUsd === null ? 'price unknown' : `${formatCost(row.costPerTaskUsd)} a task`;
  return `${score} · ${price}`;
};

export function ModelsStep({
  draft,
  change,
  models,
}: StepProps & { readonly models: readonly ModelRowDto[] }) {
  const [other, setOther] = useState('');
  const byId = new Map(models.map((m) => [m.model, m]));
  // A model typed by hand, or carried in by a plan, stays pickable and removable even though the list lacks it.
  const data: ComboboxItem[] = [
    ...models.map((m) => ({ value: m.model, label: m.name })),
    ...draft.modelIds.filter((id) => !byId.has(id)).map((id) => ({ value: id, label: id })),
  ];
  const addOther = (): void => {
    const id = cleanModelId(other);
    if (id === '') return;
    if (!draft.modelIds.includes(id)) change({ modelIds: [...draft.modelIds, id] });
    setOther('');
  };
  return (
    <Stack gap="sm">
      <Text fw={600}>Which models, and what can it cost?</Text>
      <Why>
        The same eval can show which cheaper model is good enough. Try the one you use now and one
        cheaper.
      </Why>
      <MultiSelect
        label="Models to try"
        placeholder={draft.modelIds.length === 0 ? 'Search models' : ''}
        searchable
        clearable
        data={data}
        value={[...draft.modelIds]}
        maxDropdownHeight={260}
        onChange={(modelIds) => {
          change({ modelIds });
        }}
        renderOption={({ option }) => {
          const row = byId.get(option.value);
          return (
            <div>
              <Text size="sm">{option.label}</Text>
              {row === undefined ? null : (
                <Text size="xs" c="dimmed">
                  {modelNote(row)}
                </Text>
              )}
            </div>
          );
        }}
      />
      <Group gap="xs" align="flex-end" wrap="nowrap">
        <TextInput
          style={{ flex: 1 }}
          label="A model that isn’t listed"
          placeholder="its id, such as acme/model-b"
          value={other}
          onChange={(e) => {
            setOther(e.currentTarget.value);
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            addOther();
          }}
        />
        <Button variant="default" disabled={cleanModelId(other) === ''} onClick={addOther}>
          Add Model
        </Button>
      </Group>
      <NumberInput
        label="Most one run may cost (optional)"
        description="A run is every example, on every model above."
        placeholder="No cap"
        prefix="$"
        min={0}
        decimalScale={2}
        allowNegative={false}
        hideControls
        value={draft.costCap ?? ''}
        onChange={(value) => {
          change({ costCap: typeof value === 'number' ? value : null });
        }}
      />
      <div>
        <Text size="sm" fw={500} mb={4}>
          If several models pass
        </Text>
        <SegmentedControl
          fullWidth
          size="sm"
          aria-label="If several models pass"
          value={draft.pick}
          data={[
            { value: EvalPick.Cheapest, label: 'Pick the cheapest model that passes' },
            { value: EvalPick.Best, label: 'Pick the best score' },
          ]}
          onChange={(value) => {
            change({ pick: value === EvalPick.Best ? EvalPick.Best : EvalPick.Cheapest });
          }}
        />
      </div>
    </Stack>
  );
}

function Line({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text size="sm">{children}</Text>
    </div>
  );
}

export function ReviewStep({
  draft,
  models,
}: {
  readonly draft: EvalDraft;
  readonly models: readonly ModelRowDto[];
}) {
  const marked = markedCases(draft);
  const good = marked.filter((c) => c.verdict === EvalCaseVerdict.Good).length;
  const nameOf = (id: string): string => models.find((m) => m.model === id)?.name ?? id;
  return (
    <Stack gap="sm">
      <Text fw={600}>What the agent will build</Text>
      <Why>Nothing runs yet. This is the brief the agent gets; go back to change any of it.</Why>
      <Line label="Task">{`Write the eval for ${draft.name.trim()}`}</Line>
      <Line label="What it should do well">{draft.goal.trim()}</Line>
      <Line label="Examples">
        {`${String(marked.length)} real examples: ${String(good)} good, ${String(marked.length - good)} bad`}
      </Line>
      <Line label="How it tells good from bad">
        {draft.check === null ? '' : CHECK_LABEL[draft.check]}
        {draft.checkRule.trim() === '' ? '' : `: ${draft.checkRule.trim()}`}
      </Line>
      <Line label="How often it must pass">{draft.bar === null ? '' : BAR_LABEL[draft.bar]}</Line>
      <Line label="Models">
        {draft.modelIds.map(nameOf).join(', ')}
        {draft.costCap === null ? '' : `; at most $${String(draft.costCap)} a run`}
        {draft.pick === EvalPick.Best ? '; pick the best score' : '; pick the cheapest that passes'}
      </Line>
      <Line label="How it runs">
        The free check runs with your project’s other checks. A paid run happens only when you start
        it.
      </Line>
    </Stack>
  );
}
