import { TrustSurface, type PolicyLine } from '@10db/contracts';
import { quotedValue } from './quoted-value';

/**
 * What 10db coordinates for the sessions that do the work (trust line §7): it runs the gate, commits and
 * pushes, and shares the Mac. Plan and chat change nothing, so they get none.
 */
export function coordinationLines(surface: TrustSurface, gateCommand: string | null): PolicyLine[] {
  switch (surface) {
    case TrustSurface.Plan:
    case TrustSurface.Chat:
      return [];
    case TrustSurface.Lane:
    case TrustSurface.Pass: {
      const command = (gateCommand ?? '').replaceAll(/\s+/g, ' ').trim();
      // A quoted value holds any command, backticks and quotes included, so it cannot break the sentence.
      const gate = command === '' ? 'full gate' : `full gate, the command ${quotedValue(command)}`;
      return [
        {
          label: '10db Runs The Gate',
          text: `Running the project's ${gate}: 10db runs it after the step, so a session never does.`,
        },
        {
          label: '10db Commits And Pushes',
          // In a pass the builder may allow a plain commit, push or merge on a card (the guard asks).
          text:
            surface === TrustSurface.Pass
              ? 'Committing, pushing or merging with git or gh in any way but one plain call the builder allows on a card, force-pushing, pushing to main or the base branch, and creating or switching branches: 10db lands the work when it ships.'
              : 'Committing, pushing, merging, or creating or switching branches with git or gh: 10db commits through its commit tool, and pushes and opens the pull request when the work ships.',
        },
        {
          label: 'Shared Mac',
          text: "Generating CPU load on the builder's Mac: busy loops, yes, stress tools or anything that spins cores. Other sessions share this Mac.",
        },
      ];
    }
  }
}
