import type { DecisionModelDto, JudgeDecision, JudgeStatusDto } from '@10db/contracts';
import {
  Button,
  Group,
  Loader,
  Select,
  Stack,
  Text,
  type ComboboxItem,
  type ComboboxItemGroup,
} from '@mantine/core';
import { IconCheck } from '@tabler/icons-react';
import { DaemonRequestError } from '../../daemon/client';
import { useDecisionModels, usePatchJudge } from '../../daemon/judge-queries';

/** Three significant figures: $0.042, $0.02, $0.192. */
const dollars = (usd: number): string => `$${String(Number(usd.toPrecision(3)))}`;

/** What a model costs, per million tokens; decision models answer in a few tokens, so most charge for input only. */
function priceText(
  model: Pick<DecisionModelDto, 'inputUsdPerMillion' | 'outputUsdPerMillion'>,
): string {
  if (model.inputUsdPerMillion === 0 && model.outputUsdPerMillion === 0) return 'Free';
  const input = `${dollars(model.inputUsdPerMillion)} per million input tokens`;
  return model.outputUsdPerMillion === 0
    ? input
    : `${input} · ${dollars(model.outputUsdPerMillion)} per million output tokens`;
}

/** The line under a model's name: why 10db can't call it, or what it is and what it costs. */
function byline(model: DecisionModelDto): string {
  if (model.cantCall !== null) return model.cantCall;
  const what = model.latest ? `Always ${model.maker}'s newest` : model.id;
  return `${what} · ${priceText(model)}`;
}

/** The models by maker; a saved model OpenRouter no longer lists as a decision model stays pickable on its own. */
function optionGroups(
  models: readonly DecisionModelDto[],
  saved: string,
): ComboboxItemGroup<ComboboxItem>[] {
  const groups = new Map<string, { group: string; items: ComboboxItem[] }>();
  for (const m of models) {
    const group = groups.get(m.maker) ?? { group: m.maker, items: [] };
    group.items.push({ value: m.id, label: m.name, disabled: m.cantCall !== null });
    groups.set(m.maker, group);
  }
  const listed = models.some((m) => m.id === saved);
  return listed
    ? [...groups.values()]
    : [{ group: 'Saved', items: [{ value: saved, label: saved }] }, ...groups.values()];
}

/**
 * A decision's model, picked from OpenRouter's decision models with each one's price. The daemon saves a pick only
 * once the model has answered a test decision, so the field shows the pick while it is asked and the saved model
 * again when it is refused.
 */
export function DecisionModelPicker({
  decision,
  status,
  disabled,
}: {
  readonly decision: JudgeDecision;
  readonly status: JudgeStatusDto;
  readonly disabled: boolean;
}) {
  const saved = status.config.decisions[decision].model;
  const keyed = !status.off && status.account?.secretSet === true;
  const models = useDecisionModels(keyed);
  const patch = usePatchJudge();
  const asking = patch.isPending ? patch.variables.decisions?.[decision]?.model : undefined;

  const savedText = (
    <Text size="sm" ff="monospace">
      {saved}
    </Text>
  );
  if (!keyed)
    return (
      <Stack gap={2} align="flex-end">
        {savedText}
        {status.off ? null : (
          <Text size="xs" c="dimmed">
            {status.account === null
              ? 'Add an OpenRouter key to pick another model: choose an account under Runs on.'
              : 'Add an OpenRouter key to pick another model: set the key of the account decisions run on.'}
          </Text>
        )}
      </Stack>
    );
  if (models.isPending) return <Loader size="sm" aria-label="Loading models" />;
  if (models.isError)
    return (
      <Stack gap={2} align="flex-end">
        {savedText}
        <Text size="xs" c="red" role="alert">
          OpenRouter&apos;s decision models could not be read.{' '}
          {models.error instanceof DaemonRequestError ? models.error.message : ''}
        </Text>
        <Button
          size="xs"
          variant="default"
          loading={models.isFetching}
          onClick={() => {
            void models.refetch();
          }}
        >
          Try Again
        </Button>
      </Stack>
    );

  const list = models.data.models;
  const byId = new Map<string, DecisionModelDto>(list.map((m) => [m.id, m]));
  const savedModel = byId.get(saved);
  return (
    <Stack gap={4}>
      <Select
        aria-label="Model"
        searchable
        allowDeselect={false}
        nothingFoundMessage="No decision model matches"
        data={optionGroups(list, saved)}
        value={asking ?? saved}
        disabled={disabled || patch.isPending}
        onChange={(value) => {
          if (value !== null && value !== saved)
            patch.mutate({ decisions: { [decision]: { model: value } } });
        }}
        renderOption={({ option, checked }) => {
          const model = byId.get(option.value);
          return (
            <Group wrap="nowrap" justify="space-between" gap="sm" w="100%">
              <Stack gap={0} miw={0}>
                <Text size="sm">{option.label}</Text>
                <Text size="xs" c="dimmed" truncate>
                  {model === undefined ? 'Not one of OpenRouter’s decision models' : byline(model)}
                </Text>
              </Stack>
              {checked === true ? (
                <IconCheck size={14} stroke={1.5} style={{ flex: 'none' }} />
              ) : null}
            </Group>
          );
        }}
      />
      {asking === undefined ? null : (
        <Group gap="xs">
          <Loader size="xs" />
          <Text size="xs" c="dimmed">
            Asking {asking} a test decision…
          </Text>
        </Group>
      )}
      {patch.isError ? (
        <Text size="xs" c="red" role="alert">
          {patch.error instanceof DaemonRequestError
            ? patch.error.message
            : "Couldn't reach the daemon."}
        </Text>
      ) : null}
      {savedModel?.cantCall ? (
        <Text size="xs" c="yellow.8">
          {savedModel.cantCall}
        </Text>
      ) : savedModel === undefined ? null : (
        <Text size="xs" c="dimmed">
          {priceText(savedModel)}
        </Text>
      )}
    </Stack>
  );
}
