import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Relative asset paths simplify GitHub Pages project-site hosting.
  base: './',
  plugins: [react()],
});
