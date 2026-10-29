import {
  Anchor,
  Button,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
  TextInput,
  VisuallyHidden,
} from '@mantine/core';
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

const withoutTrailingSlashes = (path: string) => path.replace(/\/+$/u, '');

/** The repository's real top level is the one path worth showing; a different pick gets a line saying so. */
function RootNote({ state }: { readonly state: FolderState }) {
  if (state.kind !== 'ready' || state.root === withoutTrailingSlashes(state.path)) return null;
  return (
    <Text size="sm" c="dimmed">
      The repository's top folder.
    </Text>
  );
}

function TypedPath({ state, onInspect }: FolderFieldProps) {
  const [text, setText] = useState(state.kind === 'idle' ? '' : state.path);
  const [typedError, setTypedError] = useState<string | null>(null);
  const inspected = useRef<string | null>(null);
  const inspect = (path: string) => {
    if (!path.startsWith('/')) {
      setTypedError('Enter the full path, starting with /');
      return;
    }
    setTypedError(null);
    inspected.current = path;
    onInspect(path);
  };
  // Blur and Enter both inspect, but not the same path twice: that would reset what the builder edited.
  const inspectIfNew = (force: boolean) => {
    const path = text.trim();
    if (path === '') return;
    if (force && state.kind === 'refused') inspect(path);
    else if (path !== inspected.current) inspect(path);
  };
  const error = typedError ?? (state.kind === 'refused' ? state.message : null);
  return (
    <Stack gap="xs">
      <TextInput
        aria-label="Folder path"
        placeholder="/Users/you/Projects/app"
        styles={MONO_INPUT}
        value={text}
        error={error}
        rightSection={state.kind === 'inspecting' ? <Loader size="xs" /> : null}
        onChange={(e) => {
          setText(e.currentTarget.value);
        }}
        onBlur={() => {
          inspectIfNew(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') inspectIfNew(true);
        }}
      />
      <Status inspecting={state.kind === 'inspecting'} />
      {state.kind === 'ready' && withoutTrailingSlashes(state.path) !== state.root ? (
        <>
          <Text size="sm" ff="monospace" style={{ wordBreak: 'break-all' }}>
            {state.root}
          </Text>
          <RootNote state={state} />
        </>
      ) : null}
    </Stack>
  );
}

/** Tells assistive technology that an inspection is running; the loader beside it is only a picture. */
function Status({ inspecting }: { readonly inspecting: boolean }) {
  return (
    <VisuallyHidden role="status">{inspecting ? 'Inspecting the folder…' : ''}</VisuallyHidden>
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
      <Status inspecting={state.kind === 'inspecting'} />
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
