import tailwindcss from '@tailwindcss/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { nitro } from 'nitro/vite';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Favicons and the social preview live with the rest of the brand assets at the repo root.
const brandAssets = fileURLToPath(new URL('../assets', import.meta.url));

export default defineConfig({
  server: { port: 3000 },
  publicDir: brandAssets,
  // Nitro picks its Vercel preset automatically when building on Vercel. It serves its own public
  // assets in production, so the brand assets are registered there too.
  plugins: [
    tanstackStart(),
    nitro({ publicAssets: [{ dir: brandAssets, maxAge: 86400 }] }),
    viteReact(),
    tailwindcss(),
  ],
});
