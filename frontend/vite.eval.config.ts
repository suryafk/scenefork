// Bundles the evals for plain Node (no browser): `pnpm --dir frontend eval:mutator`.
import { defineConfig } from 'vite';

export default defineConfig({
  publicDir: false,
  build: {
    ssr: true,
    outDir: 'dist-eval',
    emptyOutDir: true,
    target: 'node22',
    rollupOptions: {
      input: { 'run-mutator': 'src/evals/run-mutator.ts', 'verify-child': 'src/evals/verify-child.ts' },
      output: { format: 'es', entryFileNames: '[name].mjs' },
    },
  },
  ssr: { noExternal: true },
});
