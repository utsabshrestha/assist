import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

// Vite config for the Electron renderer process only
export default defineConfig({
  root: path.resolve(__dirname, 'renderer'),
  plugins: [
    react(),
    tailwindcss(),
  ],
  build: {
    outDir: path.resolve(__dirname, 'renderer/dist'),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  base: './',
});
