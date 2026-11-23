import { HazardEntryKind, type HazardAdditionDto, type ProjectDto } from '@10db/contracts';
import { Alert, Button, Group, Stack, Text } from '@mantine/core';
import {
  useHazardAssessment,
  useUndoHazardAddition,
  type useLookAgainAtHazards,
} from '../../daemon/hazard-queries';

const KIND_WORDS: Readonly<Record<HazardEntryKind, string>> = {
  [HazardEntryKind.Command]: 'the command',
  [HazardEntryKind.Glob]: 'the path pattern',
};

/** Where 10db found an addition: the file, and the line when a line named it. */
export function foundIn(addition: HazardAdditionDto): string {
  const { file, line } = addition.evidence;
  return line === undefined ? `Found in ${file}` : `Found in ${file}, line ${String(line)}`;
}

const plural = (n: number, one: string, many: string): string =>
  `${String(n)} ${n === 1 ? one : many}`;

function Addition({
  addition,
  onUndo,
  undoing,
}: {
  readonly addition: HazardAdditionDto;
  readonly onUndo: () => void;
  readonly undoing: boolean;
}) {
  return (
    <Group justify="space-between" align="flex-start" wrap="nowrap">
      <Stack gap={0}>
        <Text size="sm">
          {`Added ${KIND_WORDS[addition.kind]} ${addition.value} to "${addition.hazard}": ${addition.reason}`}
        </Text>
        <Text size="xs" c="dimmed">
          {foundIn(addition)}
        </Text>
      </Stack>
      <Button
        variant="default"
        size="compact-sm"
        aria-label={`Undo ${addition.value}`}
        disabled={undoing}
        onClick={onUndo}
      >
        Undo
      </Button>
    </Group>
  );
}

/**
 * What 10db worked out about the project's hazards from its repository and added by itself, each
 * with the reason and the file it came from and an Undo, and the result of the heading's Look Again,
 * which reads the project's main checkout once more. Removals are never applied here; they wait on
 * one Inbox card.
 */
export function HazardAdditions({
  project,
  look,
}: {
  readonly project: ProjectDto;
  readonly look: ReturnType<typeof useLookAgainAtHazards>;
}) {
  const assessment = useHazardAssessment(project.id);
  const undo = useUndoHazardAddition(project.id);
  const additions = assessment.data?.additions ?? [];
  const waiting = look.data?.ok === true ? look.data.assessment.pendingRemovals : 0;
  const pending = assessment.data?.pendingRemovals ?? 0;

  return (
    <Stack gap="xs">
      {look.data?.ok === true ? (
        <Text size="sm">
          {look.data.added === 0
            ? 'Looked again: nothing new to add.'
            : `Looked again. Added ${plural(look.data.added, 'thing', 'things')}.`}
        </Text>
      ) : null}
      {look.data?.ok === false ? (
        <Alert color="yellow" title="Nothing changed">
          {look.data.message}
        </Alert>
      ) : null}
      {look.error ? (
        <Alert color="red" title="Couldn't look again">
          {look.error.message}
        </Alert>
      ) : null}
      {Math.max(waiting, pending) > 0 ? (
        <Text size="sm">
          {Math.max(waiting, pending) === 1
            ? '1 change is waiting in the Inbox for your yes.'
            : `${String(Math.max(waiting, pending))} changes are waiting in the Inbox for your yes.`}
        </Text>
      ) : null}
      {additions.length > 0 ? (
        <Text size="sm" fw={500}>
          Found by 10db
        </Text>
      ) : null}
      {additions.map((addition) => (
        <Addition
          key={addition.id}
          addition={addition}
          undoing={undo.isPending}
          onUndo={() => {
            undo.mutate(addition.id);
          }}
        />
      ))}
      {undo.error ? (
        <Alert color="red" title="Couldn't undo that">
          {undo.error.message}
        </Alert>
      ) : null}
    </Stack>
  );
}
