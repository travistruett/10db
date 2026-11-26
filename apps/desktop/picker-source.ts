import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

// Pick on Page spec §3: the picker runs in the Preview window's page, not in 10db's window, so it is
// bundled on its own into one script and handed to the main window as a string (`virtual:picker-source`),
// which passes it to the shell's `open_preview`.

const ID = 'virtual:picker-source';
const RESOLVED = `\0${ID}`;

export function pickerSource(): Plugin {
  return {
    name: 'tendb-picker-source',
    resolveId: (id) => (id === ID ? RESOLVED : null),
    async load(id) {
      if (id !== RESOLVED) return null;
      // Loaded here, not at the top: a config read under jsdom (a test of the window's policy) can't load it,
      // nor read its own folder, which isn't a file URL there.
      const { build } = await import('esbuild');
      const entry = fileURLToPath(new URL('./src/picker/main.ts', import.meta.url));
      const here = fileURLToPath(new URL('.', import.meta.url));
      const result = await build({
        absWorkingDir: here,
        entryPoints: [entry],
        bundle: true,
        format: 'iife',
        target: 'safari18',
        minify: true,
        write: false,
        metafile: true,
        legalComments: 'inline',
      });
      // Absolute: in dev Vite resolves each watched file as an import of this module, and a path relative
      // to esbuild's folder doesn't resolve from a virtual module.
      for (const input of Object.keys(result.metafile.inputs))
        this.addWatchFile(resolve(here, input));
      const code = result.outputFiles[0]?.text ?? '';
      return `export default ${JSON.stringify(code)};`;
    },
  };
}
