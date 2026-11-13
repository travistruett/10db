import { Component, type ReactNode } from 'react';
import { PlainMarkdown } from './markdown-plain';

interface MarkdownBoundaryProps {
  /** The text being drawn, shown plain if drawing it throws. */
  readonly text: string;
  readonly children: ReactNode;
}

interface MarkdownBoundaryState {
  /** The text the state is about; a new text is drawn again. */
  readonly text: string;
  readonly failed: boolean;
}

/**
 * Keeps a markdown drawing that throws (a parser's stack overflow on a shape the length and depth
 * scan let through) to its own block: the text shows plain and the view around it keeps working.
 */
export class MarkdownBoundary extends Component<MarkdownBoundaryProps, MarkdownBoundaryState> {
  override state: MarkdownBoundaryState = { text: this.props.text, failed: false };

  static getDerivedStateFromProps(
    props: MarkdownBoundaryProps,
    state: MarkdownBoundaryState,
  ): MarkdownBoundaryState | null {
    return props.text === state.text ? null : { text: props.text, failed: false };
  }

  static getDerivedStateFromError(): Partial<MarkdownBoundaryState> {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    console.error('10db: markdown could not be drawn; showing it as plain text', error);
  }

  override render(): ReactNode {
    return this.state.failed ? <PlainMarkdown text={this.props.text} /> : this.props.children;
  }
}
