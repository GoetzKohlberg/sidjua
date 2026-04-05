import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8')) as { version: string };

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(pkg.version),
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // Tell vite to ignore watching src-tauri
      ignored: ['**/src-tauri/**'],
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    // Tauri uses Chromium on Linux/Windows, WebKit on macOS
    target: process.env['TAURI_ENV_PLATFORM'] === 'windows' ? 'chrome105' : 'safari13',
    // Don't minify in debug builds
    minify: process.env['TAURI_ENV_DEBUG'] ? false : 'esbuild',
    // Produce sourcemaps only in explicit debug mode — never in production builds.
    // TAURI_ENV_DEBUG must be the literal string 'true' to enable sourcemaps.
    sourcemap: process.env['TAURI_ENV_DEBUG'] === 'true',
  },
});
