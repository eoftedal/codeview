import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  // Everything runs in the browser — no server, so the build is a static bundle
  // that can be dropped on any host (GitHub Pages included).
  base: './',
  // The model workers import their libraries, so they have to be ES modules, not classic workers.
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    // Pre-bundling tries to parse onnxruntime-web's wasm imports and falls over; both libraries
    // are dynamically imported into workers anyway, so there is nothing to gain here.
    exclude: ['@huggingface/transformers', '@mlc-ai/web-llm'],
  },
  build: {
    target: 'es2022',
  },
})
