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
      // Loaded here, not at the top: a config read under jsdom (a test of the window's policy) can't load it.
      const { build } = await import('esbuild');
      const result = await build({
        entryPoints: [new URL('./src/picker/main.ts', import.meta.url).pathname],
        bundle: true,
        format: 'iife',
        target: 'safari18',
        minify: true,
        write: false,
        metafile: true,
        legalComments: 'inline',
      });
      for (const input of Object.keys(result.metafile.inputs)) this.addWatchFile(input);
      const code = result.outputFiles[0]?.text ?? '';
      return `export default ${JSON.stringify(code)};`;
    },
  };
}
