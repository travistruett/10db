function carriesFiles(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes('Files') === true;
}

/**
 * Keeps a file dropped outside a drop target from being opened in the window, which would replace the
 * app with the file. A target that takes files handles the same events first and is unaffected.
 * Returns the function that removes the guard.
 */
export function guardFileDrops(target: Window): () => void {
  const stop = (event: DragEvent): void => {
    if (carriesFiles(event)) event.preventDefault();
  };
  target.addEventListener('dragover', stop);
  target.addEventListener('drop', stop);
  return () => {
    target.removeEventListener('dragover', stop);
    target.removeEventListener('drop', stop);
  };
}
