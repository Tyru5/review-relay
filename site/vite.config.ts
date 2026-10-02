import tailwindcss from '@tailwindcss/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { nitro } from 'nitro/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 3000 },
  // Favicons and the social preview live with the rest of the brand assets at the repo root.
  publicDir: '../assets',
  // Nitro picks its Vercel preset automatically when building on Vercel.
  plugins: [tanstackStart(), nitro(), viteReact(), tailwindcss()],
});
