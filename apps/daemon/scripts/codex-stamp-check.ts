import { CODEX_VERIFIED_ON } from '../src/environment';
import { GENERATED_DIR, stampProblem } from './codex-stamp';

// The gate's drift step: the generated Codex types are what the pinned release wrote. It reads only
// the STAMP and the folder, so it runs anywhere, never the darwin binary.
const problem = stampProblem(GENERATED_DIR, CODEX_VERIFIED_ON);
if (problem !== null) {
  console.error(problem);
  process.exit(1);
}
