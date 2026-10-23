import { z } from 'zod';

/**
 * A branch name 10db hands to git and gh as an argument: never an option (no leading `-`), never a
 * ref expression (`..`, `@{`), and within git's own rules for a ref name.
 */
export const BranchName = z
  .string()
  .min(1)
  .max(200)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/,
    'letters, digits, ".", "_", "/" and "-", starting with a letter or digit',
  )
  .refine(
    (b) =>
      !b.includes('..') &&
      !b.includes('//') &&
      !b.endsWith('/') &&
      !b.endsWith('.') &&
      !b.endsWith('.lock'),
    'not a valid git branch name',
  );

/** A Conventional Commit type with an optional scope and `!`; the PR title is `<prefix>: <batch title>`. */
export const PrTitlePrefix = z
  .string()
  .regex(
    /^[a-z]+(\([a-z0-9][a-z0-9._/-]*\))?!?$/,
    'a Conventional Commit type and scope, such as feat(daemon)',
  );
