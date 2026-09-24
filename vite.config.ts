import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Relative asset paths so the packaged app can load index.html from file://.
  base: './',
  build: {
    outDir: 'dist-renderer',
    emptyOutDir: true
  }
});
