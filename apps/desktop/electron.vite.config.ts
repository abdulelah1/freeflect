import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  // qrcode is bundled so the installed app needs no node_modules.
  main: { plugins: [externalizeDepsPlugin({ exclude: ['qrcode'] })] },
  preload: {
    plugins: [externalizeDepsPlugin()],
    // Sandboxed preloads must be CommonJS.
    build: { rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } } }
  },
  renderer: {
    resolve: { alias: { '@': resolve(__dirname, 'src/renderer/src') } },
    plugins: [react(), tailwindcss()]
  }
})
