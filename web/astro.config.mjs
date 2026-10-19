import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://awesomeprojects.tech',
  trailingSlash: 'ignore',
  build: { format: 'directory' },
  vite: {
    // The shared tokens (../brand) and the docs (../docs) live outside this folder.
    server: { fs: { allow: ['..'] } },
  },
});
