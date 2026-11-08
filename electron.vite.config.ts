import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const shared = { '@shared': resolve(__dirname, 'src/shared') }
const version = { __APP_VERSION__: JSON.stringify(JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')).version) }

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: shared }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: shared }
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react()],
    define: version,
    resolve: { alias: shared },
    build: { rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') } }
  }
})
