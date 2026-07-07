import { defineConfig } from 'vite'
import solidPlugin from 'vite-plugin-solid'
import wasm from 'vite-plugin-wasm'
import path from 'path'

export default defineConfig({
  base: './',
  plugins: [
    // wasm() must come before solid so the .wasm transform runs first
    (wasm as any)(),
    solidPlugin(),
  ],

  server: {
    headers: {
      // Required for SharedArrayBuffer (zero-copy Wasm ↔ GPU bridge)
      'Cross-Origin-Opener-Policy':   'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    fs: {
      allow: ['..'],
    },
  },

  build: {
    target: 'esnext', // needed for top-level await + BigInt64Array
  },

  // Alias so JS imports the wasm-pack output from the workspace root
  resolve: {
    alias: {
      '@sim-core': path.resolve(__dirname, '../sim-core/pkg'),
    },
  },
})
