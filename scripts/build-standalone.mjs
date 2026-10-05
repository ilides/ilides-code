#!/usr/bin/env node
/**
 * Empaqueta ILIDES Code en un único archivo standalone (dist/ilides.mjs)
 * con shebang, ejecutable directamente con node y sin node_modules.
 */
import { build } from 'esbuild';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const outfile = 'dist/ilides.mjs';

await mkdir('dist', { recursive: true });
await build({
  entryPoints: ['src/cli/main.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile,
  // Fix oficial de esbuild para `Dynamic require of "stream"` en output ESM:
  banner: {
    js: "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);",
  },
});

// Shebang (esbuild ya preserva el del entry point; nos aseguramos igualmente)
const body = await readFile(outfile, 'utf8');
if (!body.startsWith('#!')) {
  await writeFile(outfile, `#!/usr/bin/env node\n${body}`);
}

console.log(`Standalone listo: ${outfile}`);
