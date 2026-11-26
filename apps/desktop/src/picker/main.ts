// Pick on Page spec §3: the picker's entry, bundled into one script that the shell adds as the Preview
// window's initialization script. Importing react-grab's primitives installs React's devtools hook,
// which must happen before the page's React loads; the overlay waits for the document.

import { startPicker } from './picker';

/** Written by the shell around this script: the app's origin and the project's folder. */
declare const __tendbPreview: { readonly origin: string; readonly repoPath: string };

const start = () => {
  startPicker({ repoPath: __tendbPreview.repoPath });
};
if (document.readyState === 'loading')
  document.addEventListener('DOMContentLoaded', start, { once: true });
else start();
