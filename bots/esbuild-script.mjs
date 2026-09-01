// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/* global console */
/* global process */

import botLayer from '@medplum/bot-layer/package.json' with { type: 'json' };
import esbuild from 'esbuild';
import fastGlob from 'fast-glob';

// Same build settings as examples/medplum-demo-bots in the Medplum repo.
const entryPoints = fastGlob.sync('./src/**/*.ts').filter((file) => !file.endsWith('test.ts'));

const botLayerDeps = [...Object.keys(botLayer.dependencies), '@aws-sdk/client-*'];

esbuild
  .build({
    entryPoints,
    bundle: true,
    outdir: './dist',
    platform: 'node',
    loader: { '.ts': 'ts' },
    resolveExtensions: ['.ts', '.js'],
    external: botLayerDeps,
    format: 'cjs',
    target: 'es2020',
    tsconfig: 'tsconfig.json',
    footer: { js: 'Object.assign(exports, module.exports);' }, // Required for VM Context Bots
  })
  .then(() => {
    console.log('Build completed successfully!');
  })
  .catch((error) => {
    console.error('Build failed:', JSON.stringify(error, null, 2));
    process.exit(1);
  });
