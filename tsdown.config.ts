import { defineConfig } from 'tsdown';

// Two builds, so each entry is one self-contained file with no shared chunk:
// the library with its bundled declarations, then the CLI without any. Only
// the first cleans `dist/`. `fixedExtension: false` keeps the `.js` / `.d.ts`
// names `package.json` points at; on `platform: 'node'` tsdown would otherwise
// write `.mjs` / `.d.mts`.
const shared = {
  format: 'esm',
  target: 'node24',
  platform: 'node',
  fixedExtension: false,
  sourcemap: true,
  outDir: 'dist',
} as const;

export default defineConfig([
  { ...shared, entry: { index: 'src/index.ts' }, dts: true, clean: true },
  { ...shared, entry: { cli: 'src/cli.ts' }, dts: false, clean: false },
]);
