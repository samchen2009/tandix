import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { outDir, sharedPlugins } from './vite.shared.ts'

/** Side panel: React application (html entry). */
export default defineConfig({
  plugins: [react(), ...sharedPlugins],
  build: {
    outDir,
    emptyOutDir: false,
    rollupOptions: {
      input: [resolve(import.meta.dirname, 'panel/index.html'), resolve(import.meta.dirname, 'web-access/index.html'),
        resolve(import.meta.dirname, 'src/web-api/client.ts')],
      preserveEntrySignatures: 'strict',
      output: {
        entryFileNames: (chunk) => chunk.facadeModuleId?.endsWith('/web-api/client.ts')
          ? 'web-api/tandix.js' : 'panel/assets/[name].js',
        chunkFileNames: 'panel/assets/[name]-[hash].js',
        assetFileNames: 'panel/assets/[name][extname]',
      },
    },
  },
})

export { outDir }
