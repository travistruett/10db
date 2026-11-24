import type { ShapeImage } from '../sessions';

/**
 * What a tool answers when its result is pictures: the MCP endpoint turns it into text and image
 * content blocks, which the session receives as the tool's result. Any other output is JSON text.
 * A session whose agent drops image blocks in a tool result is handed the pictures as a message
 * too (`McpDeps.showImages`).
 */
export class ToolImages {
  readonly text: string;
  readonly images: readonly ShapeImage[];

  constructor(text: string, images: readonly ShapeImage[]) {
    this.text = text;
    this.images = images;
  }
}
