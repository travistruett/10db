import { Rigor, StepRole, type FlowDto } from '@10db/contracts';

/**
 * The rigor a flow becomes. The three seeded flows keep their meaning by name; any other flow by what it
 * ran: a plan step makes it Careful, a review without one Standard, and an implement step alone Light.
 */
export function rigorOfFlow(flow: FlowDto): Rigor {
  switch (flow.name) {
    case 'quick':
      return Rigor.Light;
    case 'standard':
      return Rigor.Standard;
    case 'full':
      return Rigor.Careful;
    default: {
      const roles = new Set(flow.steps.map((s) => s.role));
      if (roles.has(StepRole.Plan)) return Rigor.Careful;
      return roles.has(StepRole.Review) ? Rigor.Standard : Rigor.Light;
    }
  }
}
