import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// 組み立て（npm run build）と開発サーバー（npm run dev）の設定。
// base: './' にして、GitHub Pages のような下層のパスでもそのまま動くようにする
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
  },
  worker: { format: 'es' },
  server: { port: 5194, strictPort: true },
  preview: { port: 5194, strictPort: true },
  plugins: [
    // アプリとしてインストールでき、一度開けばネットがなくても起動できる（PWA）
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false, // 登録は main.js で行う（更新の知らせを出すため）
      includeAssets: ['icon.svg'],
      manifest: {
        name: '国産み KUNIUMI — 星をつくる景観工房',
        short_name: '国産み',
        description: '地形・空・水・雲を組み合わせて、壮大な風景や星そのものをデザインする 3D 景観ソフト',
        lang: 'ja',
        theme_color: '#0b0f1a',
        background_color: '#0b0f1a',
        display: 'standalone',
        start_url: './',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
      },
      workbox: {
        // 新しい版を公開したら、待たせずにすぐ切り替える（古い版が出続けないように）
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        // 本体と学習済みデータは最初に保存。フォント（日本語は文字範囲ごとに分割）は使った分だけ後から保存
        globPatterns: ['**/*.{js,css,html,svg,png,tza,webmanifest}'],
        globIgnores: ['**/files/*.woff', '**/*.woff2'],
        maximumFileSizeToCacheInBytes: 24 * 1024 * 1024,
        runtimeCaching: [
          {
            urlPattern: ({ url }) => /\.woff2?$/.test(url.pathname),
            handler: 'CacheFirst',
            options: { cacheName: 'kuniumi-fonts', expiration: { maxEntries: 400 } },
          },
        ],
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.js'],
    environment: 'node',
  },
});
