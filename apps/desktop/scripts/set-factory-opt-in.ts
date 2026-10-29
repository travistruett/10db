import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { FactoryOptIn, factoryOptInPlan } from './factory-opt-in';

// `pnpm dev:factory:enable` and `pnpm dev:factory:disable`.
const action = z.enum(FactoryOptIn).parse(process.argv[2]);
const plan = factoryOptInPlan(action, process.platform);
if (plan.command) execFileSync(plan.command.file, [...plan.command.args], { stdio: 'inherit' });
console.log(plan.message);
