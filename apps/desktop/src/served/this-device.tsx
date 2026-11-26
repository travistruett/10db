import { Button, Stack, Switch, Text } from '@mantine/core';
import { useState } from 'react';
import { useDevices, useForgetThisDevice } from '../daemon/device-queries';
import { ConfirmModal } from '../shell/confirm-modal';
import { RaisedPanel } from '../shell/raised-panel';
import { fromNow, useNow } from '../shell/relative';
import { TitleRow } from '../shell/title-row';
import { forgetDevice, readDevice } from './device-session';
import { PushState, usePushSwitch } from './push-subscription';

const pushDescription = (state: PushState): string => {
  switch (state) {
    case PushState.Blocked:
      return 'Notifications are blocked for this app. Allow them in the browser’s site settings.';
    case PushState.Unsupported:
      return 'This browser can’t show notifications here. Install the app, then open it from the home screen.';
    case PushState.Loading:
    case PushState.Off:
    case PushState.On:
      return 'The lock screen shows only what kind of card it is and its title.';
  }
};

/**
 * Settings › This Device: what this phone is to the Mac it is paired with, the notification switch, and Forget This
 * Device, which has the Mac revoke it (the same revoke Devices offers) and drops the token here.
 */
export function ThisDevice() {
  const device = readDevice();
  const devices = useDevices();
  const forgetThis = useForgetThisDevice();
  const now = useNow();
  const [forgetting, setForgetting] = useState(false);
  const push = usePushSwitch();
  const self = devices.data?.find((d) => d.id === device?.deviceId);

  const forget = (): void => {
    forgetThis.mutate(undefined, {
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
          description={pushDescription(push.state)}
          checked={push.state === PushState.On}
          disabled={push.busy || (push.state !== PushState.Off && push.state !== PushState.On)}
          onChange={(event) => {
            push.toggle(event.currentTarget.checked);
          }}
          error={push.error}
          // The off track is the panel's own tone, so its edge is what shows it is a switch.
          styles={{ track: { boxShadow: 'inset 0 0 0 1px var(--mantine-color-dimmed)' } }}
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
        loading={forgetThis.isPending}
        error={forgetThis.error?.message ?? null}
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
