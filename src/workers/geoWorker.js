// 公開されている標高タイルを取り寄せて、大地の高さ場（標高 m、res × res、行 0 = 北）を作る。
// 取り寄せと解釈と標本化はここ（メインスレッドを止めない）。
import { TERRARIUM_URL, TILE, lonLatToTile, gridLonLat, chooseZoom, tilesFor, decodeTerrarium } from '../core/geo.js';
import { decodePng } from '../core/png16.js';

const cache = new Map(); // "z/x/y" → Float32Array(256×256)（同じ所を何度も取りに行かない）
const CACHE_MAX = 600;

self.onmessage = async (e) => {
  const { id, region, res, maxTiles = 400, concurrency = 8 } = e.data;
  try {
    const z = chooseZoom(region, res, maxTiles);
    const tiles = tilesFor(region, z);
    let done = 0;
    const post = (phase) => self.postMessage({ id, progress: { phase, done, total: tiles.length, zoom: z } });
    post('fetch');
    // 取り寄せ（同時にいくつか）
    const queue = tiles.slice();
    const worker = async () => {
      while (queue.length) {
        const t = queue.shift();
        const key = `${t.z}/${t.x}/${t.y}`;
        if (!cache.has(key)) cache.set(key, await fetchTile(t));
        done++;
        if (done % 4 === 0 || done === tiles.length) post('fetch');
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);

    // 標本化：格子点ごとに経緯度 → タイルの画素 → 双一次補間
    post('sample');
    const n = 2 ** z;
    const at = (gx, gy) => {
      // gx, gy: ズーム z の全体での画素座標（整数）
      const tx = ((Math.floor(gx / TILE) % n) + n) % n;
      const ty = Math.max(0, Math.min(n - 1, Math.floor(gy / TILE)));
      const px = ((gx % TILE) + TILE) % TILE;
      const py = Math.max(0, Math.min(TILE - 1, gy - ty * TILE));
      const d = cache.get(`${z}/${tx}/${ty}`);
      // 範囲の縁で隣のタイルが無いときは、直前の値で代える
      if (d) last = d[py * TILE + px];
      return last;
    };
    let last = 0;
    const out = new Float32Array(res * res);
    let min = Infinity, max = -Infinity;
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const p = gridLonLat(i, j, res, region);
        const t = lonLatToTile(p.lon, p.lat, z);
        const gx = t.x * TILE - 0.5, gy = t.y * TILE - 0.5;
        const x0 = Math.floor(gx), y0 = Math.floor(gy), fx = gx - x0, fy = gy - y0;
        const h =
          (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) +
          (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
        out[j * res + i] = h;
        if (h < min) min = h;
        if (h > max) max = h;
      }
      if (j % 256 === 0) self.postMessage({ id, progress: { phase: 'sample', done: j, total: res, zoom: z } });
    }
    self.postMessage({ id, heights: out, min, max, zoom: z, tiles: tiles.length }, [out.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String(err?.message ?? err) });
  }
};

async function fetchTile(t) {
  const url = TERRARIUM_URL.replace('{z}', t.z).replace('{x}', t.x).replace('{y}', t.y);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url);
      if (r.status === 404) return null; // 無い所（海の真ん中など）は 0 m 扱い
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buf = await r.arrayBuffer();
      const img = await decodePng(buf, { terrarium: true });
      if (img && img.width === TILE) return img.data;
      return await decodeWithBitmap(buf);
    } catch (err) {
      if (attempt === 2) throw new Error(`標高タイルを取り寄せられません（${url}）: ${err.message ?? err}`);
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  return null;
}

// 予備：ブラウザの画像解釈で読む（色の変換をしないよう指定）
async function decodeWithBitmap(buf) {
  const bmp = await createImageBitmap(new Blob([buf], { type: 'image/png' }), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const px = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
  const out = new Float32Array(bmp.width * bmp.height);
  for (let k = 0; k < out.length; k++) out[k] = decodeTerrarium(px[k * 4], px[k * 4 + 1], px[k * 4 + 2]);
  return out;
}
