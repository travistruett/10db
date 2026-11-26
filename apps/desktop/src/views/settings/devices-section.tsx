import { DevicePlatform, type DeviceDto } from '@10db/contracts';
import { Alert, Button, Loader, Stack, Table, Text } from '@mantine/core';
import { IconDeviceMobile } from '@tabler/icons-react';
import dayjs from 'dayjs';
import { useState } from 'react';
import { useDevices, useRevokeDevice } from '../../daemon/device-queries';
import { ConfirmModal } from '../../shell/confirm-modal';
import { EmptyState } from '../../shell/empty-state';
import { RaisedPanel } from '../../shell/raised-panel';
import { fromNow, absoluteTime } from '../../shell/relative';
import { SectionHeading } from './section-heading';

const PLATFORM_LABEL: Readonly<Record<DevicePlatform, string>> = {
  [DevicePlatform.Android]: 'Android',
  [DevicePlatform.Ios]: 'iOS',
  [DevicePlatform.Macos]: 'macOS',
  [DevicePlatform.Other]: 'Other',
};

/** Settings › Devices: the phones and Macs paired to this Mac, each with Revoke. */
export function DevicesSection() {
  const devices = useDevices();
  const revoke = useRevokeDevice();
  const [revoking, setRevoking] = useState<DeviceDto | null>(null);
  const rows = devices.data ?? [];
  return (
    <Stack gap="md">
      <SectionHeading
        title="Devices"
        line="Phones and Macs that can use this Mac's 10db. Each has full access. Revoke cuts one off at once."
      />
      {devices.isPending ? <Loader size="sm" /> : null}
      {devices.isError ? (
        <Alert color="red" title="Couldn't load devices">
          {devices.error.message}
        </Alert>
      ) : null}
      {devices.isSuccess && rows.length === 0 ? (
        <EmptyState icon={IconDeviceMobile} title="No devices paired">
          A phone or another Mac you pair shows here.
        </EmptyState>
      ) : null}
      {rows.length > 0 ? (
        <RaisedPanel>
          <Table.ScrollContainer minWidth={560}>
            <Table verticalSpacing="sm" horizontalSpacing="md">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Device</Table.Th>
                  <Table.Th>Paired</Table.Th>
                  <Table.Th>Last Used</Table.Th>
                  <Table.Th aria-label="Actions" />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((device) => (
                  <Table.Tr key={device.id}>
                    <Table.Td>
                      <Text size="sm" fw={500}>
                        {device.label}
                      </Text>
                      <Text size="xs" c="dimmed">
                        {PLATFORM_LABEL[device.platform]}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" title={absoluteTime(device.createdAt)}>
                        {dayjs(device.createdAt).format('MMM D')}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">
                        {device.lastUsedAt === null ? 'Never' : fromNow(device.lastUsedAt)}
                      </Text>
                    </Table.Td>
                    <Table.Td ta="right">
                      <Button
                        size="compact-sm"
                        variant="default"
                        color="red"
                        aria-label={`Revoke ${device.label}`}
                        onClick={() => {
                          revoke.reset();
                          setRevoking(device);
                        }}
                      >
                        Revoke
                      </Button>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </RaisedPanel>
      ) : null}
      <ConfirmModal
        opened={revoking !== null}
        title={`Revoke ${revoking?.label ?? 'this device'}?`}
        confirmLabel="Revoke"
        destructive
        loading={revoke.isPending}
        error={revoke.isError ? revoke.error.message : null}
        onCancel={() => {
          setRevoking(null);
        }}
        onConfirm={() => {
          if (revoking === null) return;
          revoke.mutate(revoking.id, {
            onSuccess: () => {
              setRevoking(null);
            },
          });
        }}
      >
        {`${revoking?.label ?? 'This device'} loses access to this Mac's 10db at once. It can pair again with a new code.`}
      </ConfirmModal>
    </Stack>
  );
}
