import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Relative asset URLs so dist/ loads from file:// (Electron), Capacitor and any hub sub-path.
  base: './',
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 800,
  },
  worker: { format: 'es' },
  server: { port: 5173, strictPort: false },
});
