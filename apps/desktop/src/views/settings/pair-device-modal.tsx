import { Button, Group, Image, Loader, Modal, Stack, Text } from '@mantine/core';
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { useDevices, usePairingCode } from '../../daemon/device-queries';
import { useNow } from '../../shell/relative';

/** How long "Paired" shows before the dialog closes. */
const PAIRED_SHOWN_MS = 1500;

/** The code in two groups of four, as it is read out. */
const grouped = (code: string): string => `${code.slice(0, 4)} ${code.slice(4)}`;

function countdown(msLeft: number): string {
  const seconds = Math.max(0, Math.ceil(msLeft / 1000));
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * Pair a Device: a picture of the link, the code in large type, how long it lasts and New Code. It makes a code
 * when it opens and closes on the pairing it was waiting for (a device the list did not hold when it opened).
 */
export function PairDeviceModal({
  opened,
  onClose,
}: {
  readonly opened: boolean;
  readonly onClose: () => void;
}) {
  return (
    <Modal opened={opened} onClose={onClose} title="Pair a Device" centered size="sm">
      {/* Mounted per opening, so each opening makes its own code and starts from the devices it finds. */}
      <PairBody onClose={onClose} />
    </Modal>
  );
}

function PairBody({ onClose }: { readonly onClose: () => void }) {
  const code = usePairingCode();
  const devices = useDevices();
  const now = useNow(1000);
  const [picture, setPicture] = useState<string | null>(null);
  // The devices there when it opened: any other that appears is the pairing this dialog waits for.
  const [before] = useState<ReadonlySet<string>>(
    () => new Set((devices.data ?? []).map((d) => d.id)),
  );
  const { mutate } = code;

  const draw = (url: string): void => {
    QRCode.toDataURL(url, { margin: 1, width: 240, errorCorrectionLevel: 'M' }).then(
      setPicture,
      () => {
        setPicture(null);
      },
    );
  };
  const make = (): void => {
    mutate(undefined, {
      onSuccess: (made) => {
        draw(made.url);
      },
    });
  };
  useEffect(() => {
    // Once, when the dialog opens.
    make();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const arrived = devices.data?.find((d) => !before.has(d.id));
  useEffect(() => {
    if (arrived === undefined) return undefined;
    const timer = window.setTimeout(onClose, PAIRED_SHOWN_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [arrived, onClose]);

  const expiresAt = code.data === undefined ? null : Date.parse(code.data.expiresAt);
  const expired = expiresAt !== null && now >= expiresAt;

  return (
    <Stack gap="md" align="center">
      {arrived !== undefined ? (
        <Text fw={600} role="status">
          Paired: {arrived.label}
        </Text>
      ) : code.isError ? (
        <Text size="sm" c="red">
          {code.error.message}
        </Text>
      ) : code.data === undefined ? (
        <Loader size="sm" />
      ) : (
        <>
          <Text size="sm" ta="center">
            Scan this with your phone's camera, or open the link it holds and type the code.
          </Text>
          {picture === null ? null : (
            <Image
              src={picture}
              w={240}
              h={240}
              alt="QR code that opens the pairing page on this Mac"
              style={{
                imageRendering: 'pixelated',
                borderRadius: 8,
                opacity: expired ? 0.25 : 1,
              }}
            />
          )}
          <Text
            ff="monospace"
            c="bright"
            fz={32}
            fw={700}
            style={{ letterSpacing: '0.12em' }}
            aria-label={`Pairing code ${grouped(code.data.code)}`}
          >
            {grouped(code.data.code)}
          </Text>
          <Text size="sm" c="dimmed" role="timer">
            {expired
              ? 'This code has expired'
              : `Expires in ${countdown((expiresAt ?? now) - now)}`}
          </Text>
          <Group>
            <Button
              variant={expired ? 'filled' : 'default'}
              onClick={make}
              loading={code.isPending}
            >
              New Code
            </Button>
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
          </Group>
        </>
      )}
    </Stack>
  );
}
