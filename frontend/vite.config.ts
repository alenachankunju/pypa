import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * FSD 11.5: "Installable as a Progressive Web App on both Android and iOS."
 * FSD 6.8: the judge application must keep working with no network for the
 * duration of a cached session.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const apiTarget = env.VITE_API_BASE_URL || 'http://localhost:4000';

  return {
    plugins: [
      react(),
      VitePWA({
        registerType: 'prompt',
        includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
        manifest: {
          name: 'PYPA Marking System',
          short_name: 'PYPA Marks',
          description: 'Competition registration, live judging and result computation',
          theme_color: '#3b36ad',
          background_color: '#f6f6f9',
          display: 'standalone',
          orientation: 'portrait',
          start_url: '/',
          scope: '/',
          icons: [
            { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
            { src: 'icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
          navigateFallbackDenylist: [/^\/api\//],
          runtimeCaching: [
            {
              // The offline session bundle (JDG-08-01). NetworkFirst so a live
              // device always sees the current roster, with the cached copy as
              // the fallback when the venue network drops.
              urlPattern: /\/api\/judge\/sessions\/[^/]+\/bundle$/,
              handler: 'NetworkFirst',
              options: {
                cacheName: 'judge-session-bundle',
                networkTimeoutSeconds: 4,
                expiration: { maxEntries: 8, maxAgeSeconds: 60 * 60 * 24 },
                cacheableResponse: { statuses: [200] },
              },
            },
            {
              // Member photographs — immutable once uploaded.
              urlPattern: /\/storage\/v1\/object\/public\//,
              handler: 'CacheFirst',
              options: {
                cacheName: 'member-photos',
                expiration: { maxEntries: 600, maxAgeSeconds: 60 * 60 * 24 * 7 },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
          ],
          // Score submissions are NEVER cached or replayed by the service
          // worker. The application's own IndexedDB queue owns that, because
          // only it carries the idempotency keys that make a replay safe
          // (JDG-06-05, JDG-08-03).
        },
        devOptions: { enabled: false },
      }),
    ],
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    server: {
      port: 5173,
      proxy: {
        '/api': { target: apiTarget, changeOrigin: true },
      },
    },
    build: {
      target: 'es2022',
      sourcemap: true,
      rollupOptions: {
        output: {
          manualChunks: {
            // The judge app must load in under 3 seconds on 4G (FSD 11.1).
            // Splitting the vendor bundle keeps the initial payload small and
            // lets the admin console's heavier code load only when reached.
            react: ['react', 'react-dom', 'react-router-dom'],
            query: ['@tanstack/react-query'],
            realtime: ['@supabase/supabase-js'],
          },
        },
      },
    },
  };
});
