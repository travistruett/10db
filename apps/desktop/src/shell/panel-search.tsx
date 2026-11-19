import { TextInput, type TextInputProps } from '@mantine/core';
import { IconSearch } from '@tabler/icons-react';
import type { Ref } from 'react';
import classes from './panel-search.module.css';

/** The search at the head of a panel's list: the switch's darker tone, a magnifier, the panel's width. */
export function PanelSearch({
  ref,
  ...props
}: Omit<TextInputProps, 'size' | 'leftSection' | 'classNames'> & {
  readonly ref?: Ref<HTMLInputElement>;
}) {
  return (
    <TextInput
      ref={ref}
      size="xs"
      classNames={{ input: classes['input'] }}
      leftSection={<IconSearch size={14} stroke={1.5} />}
      {...props}
    />
  );
}
