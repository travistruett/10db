import { Effort, type KindDto, type Rigor, type TaskKind } from '@10db/contracts';
import { MultiSelect, Select, type SelectProps } from '@mantine/core';
import { useKinds } from '../../daemon/kind-queries';
import { rigorOptions } from './rigor-options';

/** The value for "follow the project's rigor": Select cannot hold null as an option. */
const FOLLOW = '';

export interface RigorSelectProps extends Omit<SelectProps, 'data' | 'value' | 'onChange'> {
  readonly value: Rigor | null;
  /** The keys of the task's kinds, whose minimums disable the weaker rigors. */
  readonly kindKeys: readonly string[];
  readonly onChange: (rigor: Rigor | null) => void;
}

/** Picks a task's rigor, or the project's; a rigor below the task's kinds' floor is off and names the kind. */
export function RigorSelect({ value, kindKeys, onChange, ...props }: RigorSelectProps) {
  const kinds = useKinds().data ?? [];
  const options = rigorOptions(kinds, kindKeys);
  return (
    <Select
      {...props}
      allowDeselect={false}
      data={[
        { value: FOLLOW, label: 'Project default' },
        ...options.map((o) => ({ value: o.value, label: o.label, disabled: o.disabled })),
      ]}
      value={value ?? FOLLOW}
      onChange={(v) => {
        onChange(options.find((o) => o.value === v)?.value ?? null);
      }}
    />
  );
}

export interface KindsSelectProps {
  readonly value: readonly TaskKind[];
  readonly onChange: (kinds: TaskKind[]) => void;
  readonly label?: string;
  readonly description?: string;
  readonly 'aria-label'?: string;
  readonly size?: 'sm' | 'md';
}

/** Picks a task's kinds; a kind the builder adds is pinned to them, and one an agent gave stays its own. */
export function KindsSelect({ value, onChange, ...props }: KindsSelectProps) {
  const kinds = useKinds().data ?? [];
  return (
    <MultiSelect
      {...props}
      placeholder={value.length === 0 ? 'None' : undefined}
      data={kinds.map((k: KindDto) => ({ value: k.key, label: k.label }))}
      value={value.map((k) => k.key)}
      onChange={(keys) => {
        onChange(keys.map((key) => value.find((k) => k.key === key) ?? { key, source: 'builder' }));
      }}
    />
  );
}

export interface EffortPinSelectProps extends Omit<SelectProps, 'data' | 'value' | 'onChange'> {
  readonly value: Effort | null;
  readonly onChange: (effort: Effort | null) => void;
}

const EFFORTS: readonly Effort[] = Object.values(Effort);

/** Picks the effort every step of the task runs at, or leaves it to the playbook. */
export function EffortPinSelect({ value, onChange, ...props }: EffortPinSelectProps) {
  return (
    <Select
      {...props}
      allowDeselect={false}
      data={[
        { value: FOLLOW, label: 'Automatic' },
        ...EFFORTS.map((e) => ({ value: e, label: e })),
      ]}
      value={value ?? FOLLOW}
      onChange={(v) => {
        onChange(EFFORTS.find((e) => e === v) ?? null);
      }}
    />
  );
}
