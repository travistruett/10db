import { Anchor, Button, Group, Loader, Paper, Stack, Text, TextInput } from '@mantine/core';
import { useRef, useState } from 'react';
import { canChooseFolder, chooseFolder } from '../../desktop/choose-folder';

/** Monospace for the typed value only; `ff` on an input would set its label in monospace too. */
export const MONO_INPUT = { input: { fontFamily: 'var(--mantine-font-family-monospace)' } };

export type FolderState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'inspecting'; readonly path: string }
  | { readonly kind: 'ready'; readonly path: string; readonly root: string }
  | { readonly kind: 'refused'; readonly path: string; readonly message: string };

export interface FolderFieldProps {
  readonly state: FolderState;
  readonly onInspect: (path: string) => void;
}

/** The repository's real top level is the one path worth showing; a different pick gets a line saying so. */
function RootNote({ state }: { readonly state: FolderState }) {
  if (state.kind !== 'ready' || state.root === state.path) return null;
  return (
    <Text size="sm" c="dimmed">
      The repository's top folder.
    </Text>
  );
}

function TypedPath({ state, onInspect }: FolderFieldProps) {
  const [text, setText] = useState(state.kind === 'idle' ? '' : state.path);
  const inspected = useRef<string | null>(null);
  const inspect = (path: string) => {
    inspected.current = path;
    onInspect(path);
  };
  return (
    <Stack gap="xs">
      <TextInput
        aria-label="Folder path"
        placeholder="/Users/you/Projects/app"
        styles={MONO_INPUT}
        value={text}
        error={state.kind === 'refused' ? state.message : null}
        rightSection={state.kind === 'inspecting' ? <Loader size="xs" /> : null}
        onChange={(e) => {
          setText(e.currentTarget.value);
        }}
        onBlur={() => {
          const path = text.trim();
          if (path !== '' && path !== inspected.current) inspect(path);
        }}
        onKeyDown={(e) => {
          const path = text.trim();
          if (e.key === 'Enter' && path !== '') inspect(path);
        }}
      />
      <RootNote state={state} />
      {state.kind === 'ready' && state.root !== state.path ? (
        <Text size="sm" ff="monospace" style={{ wordBreak: 'break-all' }}>
          {state.root}
        </Text>
      ) : null}
    </Stack>
  );
}

function ChosenFolder({
  state,
  onInspect,
  onType,
}: FolderFieldProps & { readonly onType: () => void }) {
  const [pickError, setPickError] = useState<string | null>(null);
  const choose = () => {
    setPickError(null);
    chooseFolder().then(
      (path) => {
        if (path !== null) onInspect(path);
      },
      (error: unknown) => {
        setPickError(error instanceof Error ? error.message : 'The folder panel failed.');
      },
    );
  };
  const refused = state.kind === 'refused';
  return (
    <Stack gap="xs">
      {state.kind === 'idle' ? (
        <Group>
          <Button onClick={choose}>Choose Folder…</Button>
          <Anchor component="button" type="button" size="sm" onClick={onType}>
            or type a path
          </Anchor>
        </Group>
      ) : (
        <Paper
          withBorder
          p="sm"
          radius="md"
          style={refused ? { borderColor: 'var(--mantine-color-error)' } : undefined}
        >
          <Group justify="space-between" wrap="nowrap">
            <Text ff="monospace" size="sm" style={{ wordBreak: 'break-all' }}>
              {state.kind === 'ready' ? state.root : state.path}
            </Text>
            {state.kind === 'inspecting' ? (
              <Loader size="xs" aria-label="Inspecting the folder" />
            ) : null}
            <Button size="xs" variant="default" onClick={choose}>
              Change
            </Button>
          </Group>
        </Paper>
      )}
      {refused ? (
        <Text size="sm" c="red" role="alert">
          {state.message}
        </Text>
      ) : null}
      {pickError === null ? null : (
        <Text size="sm" c="red" role="alert">
          {pickError}
        </Text>
      )}
      <RootNote state={state} />
    </Stack>
  );
}

/**
 * Where the builder says which folder to add: the native panel inside the desktop app (with a way to
 * type instead), a typed path in the browser, which has no panel.
 */
export function FolderField(props: FolderFieldProps) {
  const [typing, setTyping] = useState(false);
  if (!canChooseFolder() || typing) return <TypedPath {...props} />;
  return (
    <ChosenFolder
      {...props}
      onType={() => {
        setTyping(true);
      }}
    />
  );
}
