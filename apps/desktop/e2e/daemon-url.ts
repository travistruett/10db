import { e2ePorts } from './ports';

/** The E2E daemon's origin; the runner and its workers read the same ports. */
export const daemonUrl = `http://127.0.0.1:${String((await e2ePorts(process.env)).daemon)}`;
