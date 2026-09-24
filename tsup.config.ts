import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { cli: 'src/cli.ts', index: 'src/index.ts' },
  format: ['esm'],
  target: 'node24',
  dts: {
    entry: { index: 'src/index.ts' },
    // tsup's dts build injects `baseUrl`, which TypeScript 6 deprecates; the
    // project tsconfig never sets it, so silence it for this compile only.
    compilerOptions: { ignoreDeprecations: '6.0' },
  },
  sourcemap: true,
  clean: true,
  splitting: false,
});
