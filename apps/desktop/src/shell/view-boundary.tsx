import { Alert, Button, Stack, Text } from '@mantine/core';
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ViewBoundaryProps {
  readonly name: string;
  readonly children: ReactNode;
}

interface ViewBoundaryState {
  readonly error: Error | null;
}

/** Keeps one view's crash inside that view (spec §12); the shell and other views keep working. */
export class ViewBoundary extends Component<ViewBoundaryProps, ViewBoundaryState> {
  override state: ViewBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ViewBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(`10db: the ${this.props.name} view crashed`, error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <Alert color="red" title={`Something went wrong in ${this.props.name}.`}>
        <Stack gap="sm" align="flex-start">
          <Text size="sm" ff="monospace">
            {error.message}
          </Text>
          <Button
            size="sm"
            variant="light"
            color="red"
            onClick={() => {
              this.setState({ error: null });
            }}
          >
            Reload view
          </Button>
        </Stack>
      </Alert>
    );
  }
}
