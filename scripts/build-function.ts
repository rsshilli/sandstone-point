import { build } from 'esbuild';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');

/**
 * Bundles the portal API (lib/portal/function-entry.ts and everything it imports) into
 * functions/lib/index.js, the file Firebase deploys. firebase-functions stays outside the bundle
 * because Firebase installs it from functions/package.json.
 */
async function main(): Promise<void> {
  await build({
    entryPoints: [join(ROOT, 'lib', 'portal', 'function-entry.ts')],
    outfile: join(ROOT, 'functions', 'lib', 'index.js'),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    external: ['firebase-functions', 'firebase-admin'],
    logLevel: 'warning',
  });
  console.log('Built functions/lib/index.js');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
