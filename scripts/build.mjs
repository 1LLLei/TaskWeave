import * as esbuild from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('apps/vscode/dist', { recursive: true });
await copyFile('README.md', 'apps/vscode/README.md');
await copyFile('LICENSE', 'apps/vscode/LICENSE');
const configs = [
  {
    entryPoints: ['apps/vscode/src/extension.ts'],
    outfile: 'apps/vscode/dist/extension.js',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode'],
    sourcemap: true,
  },
  {
    entryPoints: ['packages/ui/src/main.tsx'],
    outfile: 'apps/vscode/dist/webview.js',
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    sourcemap: true,
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
  },
];
for (const config of configs) {
  if (process.argv.includes('--watch')) {
    const ctx = await esbuild.context(config);
    await ctx.watch();
  } else await esbuild.build(config);
}
