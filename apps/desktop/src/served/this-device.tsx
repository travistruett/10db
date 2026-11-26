import { Button, Stack, Switch, Text } from '@mantine/core';
import { useState } from 'react';
import { useDevices, useRevokeDevice } from '../daemon/device-queries';
import { ConfirmModal } from '../shell/confirm-modal';
import { RaisedPanel } from '../shell/raised-panel';
import { fromNow, useNow } from '../shell/relative';
import { TitleRow } from '../shell/title-row';
import { forgetDevice, readDevice } from './device-session';

/**
 * Settings › This Device: what this phone is to the Mac it is paired with, the notification switch, and Forget This
 * Device, which has the Mac revoke it (the same revoke Devices offers) and drops the token here.
 */
export function ThisDevice() {
  const device = readDevice();
  const devices = useDevices();
  const revoke = useRevokeDevice();
  const now = useNow();
  const [forgetting, setForgetting] = useState(false);
  const self = devices.data?.find((d) => d.id === device?.deviceId);

  const forget = (): void => {
    if (device === null) return;
    revoke.mutate(device.deviceId, {
      onSuccess: () => {
        forgetDevice(null);
        window.location.assign('/app/pair');
      },
    });
  };

  return (
    <Stack gap="md">
      <TitleRow title="This Device" />
      <RaisedPanel padded>
        <Stack gap={4}>
          <Text size="sm" fw={600}>
            {device === null ? 'Not paired' : `Paired with ${device.host}`}
          </Text>
          {self === undefined ? null : (
            <Text size="xs" c="dimmed">
              {self.label}, paired {fromNow(self.createdAt, now)}
            </Text>
          )}
        </Stack>
      </RaisedPanel>
      <RaisedPanel padded>
        <Switch
          label="Notify me when a card needs me"
          description="Arrives in a later update. Until then the Inbox shows what is waiting when you open it."
          disabled
          checked={false}
          onChange={() => undefined}
        />
      </RaisedPanel>
      {device === null ? null : (
        <Button
          color="red"
          variant="default"
          onClick={() => {
            setForgetting(true);
          }}
        >
          Forget This Device
        </Button>
      )}
      <ConfirmModal
        opened={forgetting}
        title="Forget this device?"
        confirmLabel="Forget This Device"
        destructive
        loading={revoke.isPending}
        error={revoke.error?.message ?? null}
        onConfirm={forget}
        onCancel={() => {
          setForgetting(false);
        }}
      >
        {device === null
          ? ''
          : `${device.host} stops accepting this phone. To use it again, pair it with a new code.`}
      </ConfirmModal>
    </Stack>
  );
}
