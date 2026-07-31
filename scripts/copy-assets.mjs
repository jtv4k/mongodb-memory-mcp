// Copies runtime (non-TypeScript) assets into dist/ after `tsc`.
//
// EJS templates and the compiled Tailwind stylesheet are resolved relative to
// the running module's directory (see src/app.ts), so `dist/` needs its own
// copy of `views/` and `public/` for the production image to work.
import { cp, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const assets = [
  ['src/views', 'dist/views'],
  ['src/public', 'dist/public'],
];

for (const [from, to] of assets) {
  const src = resolve(root, from);
  const dest = resolve(root, to);
  await mkdir(dirname(dest), { recursive: true });
  await cp(src, dest, { recursive: true });
  console.log(`copied ${from} -> ${to}`);
}
