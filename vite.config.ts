import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  // Everything runs in the browser — no server, so the build is a static bundle
  // that can be dropped on any host (GitHub Pages included).
  base: './',
  build: {
    target: 'es2022',
  },
})
