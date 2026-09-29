import { build } from 'esbuild';
import { writeBuildManifest } from '../src/build-identity.mjs';
await build({
  entryPoints: ['vendor/orca/src/main/computer/desktop-script-provider-client.ts'],
  outfile: 'dist/provider.mjs', bundle: true, platform: 'node', format: 'esm',
  target: 'node22', legalComments: 'inline'
});
await writeBuildManifest();
