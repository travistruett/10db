/**
 * What a session's setup asks the lane sandbox to bring along: the builder's skill folders, the plugins to
 * load and the project's cleaned definition files. The sandbox judges every real path before it opens one.
 */
export interface SetupInput {
  readonly skills: readonly {
    readonly name: string;
    /** The folder as found; it may be a link. */
    readonly path: string;
    /** The real path of its `SKILL.md`. */
    readonly skillFile: string;
  }[];
  readonly plugins: readonly { readonly id: string; readonly path: string }[];
  readonly projectFiles: readonly {
    /** Under the `project` plugin's root. */
    readonly relative: string;
    /** Where it was read, under the checkout. */
    readonly source: string;
    readonly content: Buffer;
    readonly mode: number;
  }[];
}
