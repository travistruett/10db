// A Vitest reporter that prints a line as each test file starts. Vitest's own reporters print a file
// only once it finishes, so a gate step that hangs or times out would otherwise not name the file it
// was running. The root vitest.config.ts lists it beside Vitest's default reporters.
import { relative } from 'node:path';

/** @implements {import('vitest/node').Reporter} */
export default class VitestProgress {
  /** @param {import('vitest/node').TestModule} testModule */
  onTestModuleStart(testModule) {
    process.stdout.write(`▶ ${relative(process.cwd(), testModule.moduleId)} started\n`);
  }
}
