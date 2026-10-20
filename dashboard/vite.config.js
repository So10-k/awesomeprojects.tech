import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  plugins: [preact()],
  // brand/tokens.css lives one level up, shared with the website.
  server: { fs: { allow: ['..'] } },
  build: { target: 'es2022', sourcemap: false },
});
