// 月面図をワーカーで一度だけ作って配る。戻り値: Promise<{ W, H, albedo, height }>
let pending = null;
export function loadMoonMap() {
  pending ??= new Promise((resolve, reject) => {
    const w = new Worker(new URL('../workers/moonWorker.js', import.meta.url), { type: 'module' });
    w.onmessage = (e) => {
      resolve(e.data);
      w.terminate();
    };
    w.onerror = (e) => {
      reject(e);
      w.terminate();
    };
  });
  return pending;
}

// 緯度・経度（ラジアン、東経が正）の明るさ（高地 = 1 の相対値、双一次補間）
export function sampleMoon(m, lat, lon) {
  const x = ((lon + Math.PI) / (Math.PI * 2)) * m.W - 0.5;
  const y = Math.min(m.H - 1.001, Math.max(0, ((Math.PI / 2 - lat) / Math.PI) * m.H - 0.5));
  const x0 = Math.floor(x), y0 = Math.floor(y), tx = x - x0, ty = y - y0;
  const xi = (k) => ((k % m.W) + m.W) % m.W;
  const A = m.albedo;
  const a = A[y0 * m.W + xi(x0)], b = A[y0 * m.W + xi(x0 + 1)], c = A[(y0 + 1) * m.W + xi(x0)], d = A[(y0 + 1) * m.W + xi(x0 + 1)];
  return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
}
