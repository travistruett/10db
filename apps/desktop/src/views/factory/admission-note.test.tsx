import { AdmissionDto, AdmissionHoldKind } from '@10db/contracts';
import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderWithDaemon, server } from '../../test/daemon';
import { AdmissionNote } from './admission-note';

// Factory says why new lanes and gates wait: one line per hold the daemon reports, and nothing when
// none holds.

const LOAD_LINE =
  'New lanes and gates wait: the load has stayed above 20 (2× the 10 cores) since 09:05.';
const CAP_LINE =
  '3 of 3 lanes are running across all projects; queued work waits for one to finish.';

function serveAdmission(holds: AdmissionDto['holds']): void {
  server.use(
    http.get(daemonUrl('/admission'), () =>
      HttpResponse.json(
        AdmissionDto.parse({
          holds,
          freeBytes: 100_000_000_000,
          diskFloorBytes: 20_000_000_000,
          lanesRunning: 3,
          machineLaneCap: 3,
        }),
      ),
    ),
    ...baseHandlers(),
  );
}

describe('AdmissionNote', () => {
  it('shows each hold’s line', async () => {
    serveAdmission([
      { kind: AdmissionHoldKind.Load, line: LOAD_LINE },
      { kind: AdmissionHoldKind.LaneCap, line: CAP_LINE },
    ]);
    renderWithDaemon(<AdmissionNote />);
    const note = await screen.findByRole('status', { name: 'New work held' });
    expect(note.textContent).toContain(LOAD_LINE);
    expect(note.textContent).toContain(CAP_LINE);
  });

  it('shows nothing when nothing holds', async () => {
    let asked = false;
    server.use(
      http.get(daemonUrl('/admission'), () => {
        asked = true;
        return HttpResponse.json(
          AdmissionDto.parse({
            holds: [],
            freeBytes: null,
            diskFloorBytes: 20_000_000_000,
            lanesRunning: 0,
            machineLaneCap: 4,
          }),
        );
      }),
      ...baseHandlers(),
    );
    renderWithDaemon(<AdmissionNote />);
    await waitFor(() => {
      expect(asked).toBe(true);
    });
    expect(screen.queryByRole('status', { name: 'New work held' })).toBeNull();
  });
});
