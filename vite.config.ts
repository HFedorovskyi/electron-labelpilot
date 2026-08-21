import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    host: '127.0.0.1',
  },
  base: './',
  build: {
    // No prod sourcemaps — smaller install, faster writes on weak eMMC.
    sourcemap: false,
    rollupOptions: {
      input: {
        main: 'index.html',
      },
      output: {
        // Split stable vendor code into separate cacheable chunks so the main app
        // chunk is smaller to parse/compile on a weak CPU each cold start. bwip-js is
        // intentionally NOT listed here — it is dynamically imported (LabelRenderer),
        // so Rollup emits it as its own lazily-loaded chunk.
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-dom/client'],
          'vendor-icons': ['lucide-react'],
        },
      },
    },
  },
})
