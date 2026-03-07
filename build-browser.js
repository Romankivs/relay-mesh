#!/usr/bin/env node

// Browser build script using esbuild
// Creates a browser-compatible bundle from the TypeScript source

const esbuild = require('esbuild');
const path = require('path');

async function build() {
  try {
    console.log('Building browser bundle...');

    // Build browser bundle (IIFE format for direct script tag usage)
    await esbuild.build({
      entryPoints: ['src/client/index.ts'],
      bundle: true,
      outfile: 'dist/browser/relay-mesh.js',
      format: 'iife',
      globalName: 'RelayMesh',
      platform: 'browser',
      target: ['es2020'],
      sourcemap: true,
      minify: false,
      define: {
        'process.env.NODE_ENV': '"production"'
      },
      banner: {
        js: '/* RelayMesh Browser Bundle */'
      }
    });

    console.log('✓ Browser bundle created: dist/browser/relay-mesh.js');

    // Build minified version
    await esbuild.build({
      entryPoints: ['src/client/index.ts'],
      bundle: true,
      outfile: 'dist/browser/relay-mesh.min.js',
      format: 'iife',
      globalName: 'RelayMesh',
      platform: 'browser',
      target: ['es2020'],
      sourcemap: true,
      minify: true,
      define: {
        'process.env.NODE_ENV': '"production"'
      }
    });

    console.log('✓ Minified bundle created: dist/browser/relay-mesh.min.js');

    // Build ES module version for modern browsers
    await esbuild.build({
      entryPoints: ['src/client/index.ts'],
      bundle: true,
      outfile: 'dist/browser/relay-mesh.esm.js',
      format: 'esm',
      platform: 'browser',
      target: ['es2020'],
      sourcemap: true,
      minify: false,
      define: {
        'process.env.NODE_ENV': '"production"'
      }
    });

    console.log('✓ ES module bundle created: dist/browser/relay-mesh.esm.js');
    console.log('\nBrowser build complete!');

  } catch (error) {
    console.error('Build failed:', error);
    process.exit(1);
  }
}

build();
