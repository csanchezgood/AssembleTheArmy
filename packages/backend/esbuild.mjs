// Bundles every handler in src/handlers/<name>.ts into dist/<name>/index.mjs.
// Each bundle is self-contained (no externals) so Terraform can zip the folder as-is.
import { build } from 'esbuild';
import { readdir, rm } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const handlersDir = join(root, 'src', 'handlers');
const distDir = join(root, 'dist');

const entries = (await readdir(handlersDir)).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
if (entries.length === 0) {
  console.error('No handlers found in src/handlers');
  process.exit(1);
}

await rm(distDir, { recursive: true, force: true });

// Some CommonJS dependencies (AWS SDK internals) reference `require`, `__dirname` or
// `__filename`; provide ESM-compatible shims at the top of every bundle.
const banner = [
  "import { createRequire as __ataCreateRequire } from 'node:module';",
  "import { fileURLToPath as __ataFileURLToPath } from 'node:url';",
  "import { dirname as __ataDirname } from 'node:path';",
  'const require = __ataCreateRequire(import.meta.url);',
  'const __filename = __ataFileURLToPath(import.meta.url);',
  'const __dirname = __ataDirname(__filename);',
].join('\n');

for (const file of entries) {
  const name = basename(file, extname(file));
  const outfile = join(distDir, name, 'index.mjs');
  await build({
    entryPoints: [join(handlersDir, file)],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    minify: false,
    sourcemap: false,
    treeShaking: true,
    mainFields: ['module', 'main'],
    conditions: ['node', 'import', 'module', 'default'],
    banner: { js: banner },
    logLevel: 'warning',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  console.log(`built ${name} -> ${outfile}`);
}
