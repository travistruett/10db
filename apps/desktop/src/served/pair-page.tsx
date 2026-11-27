import { Alert, Button, Center, Loader, Stack, Text, TextInput, Title } from '@mantine/core';
import { useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { createDaemonClient } from '../daemon/client';
import { readDevice } from './device-session';
import { pairingFailureText, pairWithThisHost, takeCodeFromAddress, thisPlatform } from './pairing';
import { PushState, usePushSwitchFor } from './push-subscription';

/** Chrome's offer to install the page, held until the builder presses Install. */
interface InstallOffer extends Event {
  prompt(): Promise<void>;
}
function isInstallOffer(event: Event): event is InstallOffer {
  return 'prompt' in event && typeof event.prompt === 'function';
}

type Stage =
  | { readonly kind: 'pairing' }
  | { readonly kind: 'asking'; readonly reason: string | null }
  | { readonly kind: 'paired'; readonly host: string };

/**
 * `/app/pair`: reads the code the QR link carried and pairs this phone with the Mac that served the page. With no
 * code, or one the Mac refused, it asks for the code to be typed. When it has paired it offers notifications first,
 * then Install.
 */
export function PairPage() {
  const fromAddress = takeCodeFromAddress();
  const [stage, setStage] = useState<Stage>(
    fromAddress === null ? { kind: 'asking', reason: null } : { kind: 'pairing' },
  );
  const [code, setCode] = useState('');
  const [installOffer, setInstallOffer] = useState<InstallOffer | null>(null);
  const started = useRef(false);

  const pair = (typed: string): void => {
    const { platform, label } = thisPlatform();
    pairWithThisHost({ code: typed, label, platform }).then(
      (host) => {
        setStage({ kind: 'paired', host });
      },
      (error: unknown) => {
        setStage({
          kind: 'asking',
          reason: pairingFailureText(error),
        });
      },
    );
  };

  useEffect(() => {
    const onOffer = (event: Event): void => {
      event.preventDefault();
      if (isInstallOffer(event)) setInstallOffer(event);
    };
    window.addEventListener('beforeinstallprompt', onOffer);
    return () => {
      window.removeEventListener('beforeinstallprompt', onOffer);
    };
  }, []);

  useEffect(() => {
    // Once: a second pass (StrictMode) must not spend the code twice.
    if (started.current || fromAddress === null) return;
    started.current = true;
    pair(fromAddress);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once, for the code the page opened with.
  }, []);

  if (stage.kind === 'pairing') {
    return (
      <Center h="100dvh">
        <Stack align="center" gap="xs">
          <Loader size="sm" />
          <Text>Pairing with this Mac…</Text>
        </Stack>
      </Center>
    );
  }
  if (stage.kind === 'paired') return <Paired host={stage.host} installOffer={installOffer} />;
  return (
    <Center h="100dvh" p="lg">
      <Stack
        gap="md"
        maw={420}
        w="100%"
        component="form"
        onSubmit={(event: SyntheticEvent) => {
          event.preventDefault();
          setStage({ kind: 'pairing' });
          pair(code);
        }}
      >
        <Title order={2}>Pair this phone</Title>
        <Text size="sm">
          On your Mac, open Settings › Devices and press Pair a Device, then type the code shown or
          scan its picture.
        </Text>
        {stage.reason === null ? null : (
          <Alert color="red" title="Not paired">
            {stage.reason}
          </Alert>
        )}
        <TextInput
          label="Code"
          value={code}
          onChange={(event) => {
            setCode(event.currentTarget.value);
          }}
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          styles={{ input: { letterSpacing: '0.2em', fontVariantNumeric: 'tabular-nums' } }}
        />
        <Button type="submit" disabled={code.trim() === ''}>
          Pair
        </Button>
      </Stack>
    </Center>
  );
}

/** What a paired phone does next: Turn On Notifications is the main button (Chrome needs a tap to ask), then Install. */
function Paired({
  host,
  installOffer,
}: {
  readonly host: string;
  readonly installOffer: InstallOffer | null;
}) {
  // Pairing has just stored the token; the app's own connection starts only on the next page.
  const token = readDevice()?.token ?? '';
  const client = createDaemonClient({ url: window.location.origin, token });
  const push = usePushSwitchFor(client);
  const offerPush = push.state === PushState.Off;
  return (
    <Center h="100dvh" p="lg">
      <Stack gap="md" maw={420} w="100%">
        <Title order={2}>Paired with {host}</Title>
        <Text size="sm">
          You're set. When an agent needs a decision, this phone buzzes and you can answer it from
          wherever you are, without walking back to your Mac.
        </Text>
        {offerPush ? (
          <Button
            loading={push.busy}
            onClick={() => {
              push.toggle(true);
            }}
          >
            Turn On Notifications
          </Button>
        ) : null}
        {push.state === PushState.On ? (
          <Text size="sm" c="dimmed">
            Notifications are on. The lock screen shows only what kind of card it is and its title.
          </Text>
        ) : null}
        {push.state === PushState.Blocked ? (
          <Text size="sm" c="dimmed">
            Notifications are blocked for this app. Allow them in the browser’s site settings.
          </Text>
        ) : null}
        {push.state === PushState.Unsupported ? (
          <Text size="sm" c="dimmed">
            This browser can’t show notifications here. Install 10db, open it from the home screen,
            then turn them on in This Device.
          </Text>
        ) : null}
        {push.error === null ? null : (
          <Text size="sm" c="red" role="alert">
            {push.error}
          </Text>
        )}
        <Text size="sm" c="dimmed">
          Install 10db to open it from your home screen in one tap.
        </Text>
        {installOffer === null ? null : (
          <Button
            variant={offerPush ? 'default' : 'filled'}
            onClick={() => {
              void installOffer.prompt();
            }}
          >
            Install
          </Button>
        )}
        <Button
          variant={offerPush || installOffer !== null ? 'default' : 'filled'}
          component="a"
          href="/app/inbox"
        >
          Open Inbox
        </Button>
      </Stack>
    </Center>
  );
}
