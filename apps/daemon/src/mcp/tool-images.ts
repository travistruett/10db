/**
 * What a tool answers when its result is pictures: the MCP endpoint turns it into text and image
 * content blocks, which the session receives as the tool's result. Any other output is JSON text.
 */
export class ToolImages {
  readonly text: string;
  readonly images: readonly { readonly mediaType: string; readonly data: string }[];

  constructor(
    text: string,
    images: readonly { readonly mediaType: string; readonly data: string }[],
  ) {
    this.text = text;
    this.images = images;
  }
}
