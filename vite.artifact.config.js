import { defineConfig } from 'vite';

// Claude のアーティファクトとして公開する版：アーティファクトは 1 つに 511 ファイルまでなので、
// 日本語フォントの分割ファイル（1000 余り）を同梱せず Google Fonts から読む。PWA（サービスワーカー）も使えないので外す
const out = process.env.KUNIUMI_ARTIFACT_OUT;
export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 4000, outDir: out, emptyOutDir: true },
  worker: { format: 'es' },
  plugins: [
    {
      name: 'kuniumi-artifact',
      enforce: 'pre',
      resolveId(id) {
        if (id.startsWith('@fontsource/')) return '\0empty-css';
        if (id === 'virtual:pwa-register') return '\0pwa-stub';
        return null;
      },
      load(id) {
        if (id === '\0empty-css') return '';
        if (id === '\0pwa-stub') return 'export function registerSW() { return () => {}; }';
        return null;
      },
      transformIndexHtml(html) {
        const link =
          '<link rel="preconnect" href="https://fonts.googleapis.com">\n' +
          '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n' +
          '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Shippori+Mincho:wght@500;700&family=Zen+Kaku+Gothic+New:wght@400;500;700&display=swap">\n';
        return html.replace('</head>', link + '</head>');
      },
    },
  ],
});
