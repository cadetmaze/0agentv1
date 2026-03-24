import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
export default defineConfig({
  plugins: [sveltekit()],
  server: { proxy: { '/api': 'http://localhost:4200', '/ws': { target: 'ws://localhost:4200', ws: true } } }
});
