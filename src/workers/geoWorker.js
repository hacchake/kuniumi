// 公開されている標高タイルを取り寄せて、大地の高さ場（標高 m、res × res、行 0 = 北）を作る。
// 取り寄せと解釈と標本化はここ（メインスレッドを止めない）。
import { TERRARIUM_URL, TILE, lonLatToTile, gridLonLat, chooseZoom, tilesFor, decodeTerrarium, repairElevation } from '../core/geo.js';
import { decodePng } from '../core/png16.js';
import { imageryUrl, IMAGERY_MAX_ZOOM } from '../core/globe.js';

const cache = new Map(); // "z/x/y" → Float32Array(256×256)（同じ所を何度も取りに行かない）
const CACHE_MAX = 600;

self.onmessage = async (e) => {
  if (e.data.photo) return photoJob(e.data);
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
      if (img && img.width === TILE) return repairElevation(img.data, TILE);
      return repairElevation(await decodeWithBitmap(buf), TILE);
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

// ---- 衛星写真（地表の色） ----
// 範囲の写真を px × px（行 0 = 北）で作り、JPEG の data URL にして返す。
// 写真のタイル（Web メルカトル）を取り寄せ、格子点ごとに経緯度 → タイルの画素 → 双一次補間
const photoCache = new Map(); // "z/x/y" → Uint8ClampedArray(256×256×4)
async function photoJob({ id, region, px, maxTiles = 300, concurrency = 8 }) {
  try {
    const z = Math.min(IMAGERY_MAX_ZOOM, chooseZoom(region, px, maxTiles));
    const tiles = tilesFor(region, z);
    let done = 0;
    const post = (phase) => self.postMessage({ id, progress: { phase, done, total: tiles.length, zoom: z } });
    post('photo');
    const queue = tiles.slice();
    const worker = async () => {
      while (queue.length) {
        const t = queue.shift();
        const key = `${t.z}/${t.x}/${t.y}`;
        if (!photoCache.has(key)) photoCache.set(key, await fetchPhotoTile(t));
        done++;
        if (done % 4 === 0 || done === tiles.length) post('photo');
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    while (photoCache.size > 500) photoCache.delete(photoCache.keys().next().value);

    const n = 2 ** z;
    const out = new Uint8ClampedArray(px * px * 4);
    // 全体の画素座標 (gx, gy) の色を rgb へ（無いタイルは null を返す）
    const rgb = [new Float32Array(3), new Float32Array(3), new Float32Array(3), new Float32Array(3)];
    const look = (gx, gy, dst) => {
      const tx = ((Math.floor(gx / TILE) % n) + n) % n;
      const ty = Math.max(0, Math.min(n - 1, Math.floor(gy / TILE)));
      const d = photoCache.get(`${z}/${tx}/${ty}`);
      if (!d) return false;
      const ix = ((gx % TILE) + TILE) % TILE, iy = Math.max(0, Math.min(TILE - 1, gy - ty * TILE));
      const k = (iy * TILE + ix) * 4;
      dst[0] = d[k];
      dst[1] = d[k + 1];
      dst[2] = d[k + 2];
      return true;
    };
    // 経緯度 → タイルの画素の対応はなめらかなので、S 画素おきの格子点だけ正確に求めて、間は補間する（三角関数を 1/256 に）
    const S = 16, gn = Math.ceil((px - 1) / S) + 1;
    const GX = new Float64Array(gn * gn), GY = new Float64Array(gn * gn);
    for (let b = 0; b < gn; b++) {
      for (let a2 = 0; a2 < gn; a2++) {
        const p = gridLonLat(Math.min(px - 1, a2 * S), Math.min(px - 1, b * S), px, region);
        const t = lonLatToTile(p.lon, p.lat, z);
        GX[b * gn + a2] = t.x * TILE - 0.5;
        GY[b * gn + a2] = t.y * TILE - 0.5;
      }
    }
    const world = n * TILE;
    const mapAt = (i, j) => {
      const a2 = Math.min(gn - 2, Math.floor(i / S)), b = Math.min(gn - 2, Math.floor(j / S));
      const i0 = a2 * S, j0 = b * S, i1 = Math.min(px - 1, i0 + S), j1 = Math.min(px - 1, j0 + S);
      const fx = (i - i0) / Math.max(1, i1 - i0), fy = (j - j0) / Math.max(1, j1 - j0);
      const k = b * gn + a2;
      let x00 = GX[k], x10 = GX[k + 1], x01 = GX[k + gn], x11 = GX[k + gn + 1];
      // 経度 ±180° をまたぐ所は、つながるように 1 周ぶんずらす
      if (Math.max(x00, x10, x01, x11) - Math.min(x00, x10, x01, x11) > world / 2) {
        const fix = (v) => (v < world / 2 ? v + world : v);
        x00 = fix(x00), x10 = fix(x10), x01 = fix(x01), x11 = fix(x11);
      }
      mx = (x00 * (1 - fx) + x10 * fx) * (1 - fy) + (x01 * (1 - fx) + x11 * fx) * fy;
      my = (GY[k] * (1 - fx) + GY[k + 1] * fx) * (1 - fy) + (GY[k + gn] * (1 - fx) + GY[k + gn + 1] * fx) * fy;
    };
    let mx = 0, my = 0;
    for (let j = 0; j < px; j++) {
      for (let i = 0; i < px; i++) {
        mapAt(i, j);
        const gx = mx, gy = my;
        const x0 = Math.floor(gx), y0 = Math.floor(gy), fx = gx - x0, fy = gy - y0;
        const ok0 = look(x0, y0, rgb[0]);
        if (!look(x0 + 1, y0, rgb[1])) rgb[1].set(rgb[0]);
        if (!look(x0, y0 + 1, rgb[2])) rgb[2].set(rgb[0]);
        if (!look(x0 + 1, y0 + 1, rgb[3])) rgb[3].set(rgb[0]);
        const k = (j * px + i) * 4;
        if (!ok0) {
          out[k + 3] = 255;
          continue;
        }
        for (let ch = 0; ch < 3; ch++) {
          out[k + ch] = (rgb[0][ch] * (1 - fx) + rgb[1][ch] * fx) * (1 - fy) + (rgb[2][ch] * (1 - fx) + rgb[3][ch] * fx) * fy;
        }
        out[k + 3] = 255;
      }
      if (j % 256 === 0) self.postMessage({ id, progress: { phase: 'photoSample', done: j, total: px, zoom: z } });
    }
    const canvas = new OffscreenCanvas(px, px);
    canvas.getContext('2d').putImageData(new ImageData(out, px, px), 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.88 });
    const url = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = () => rej(r.error);
      r.readAsDataURL(blob);
    });
    self.postMessage({ id, url, zoom: z, tiles: tiles.length });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message ?? err) });
  }
}

async function fetchPhotoTile(t) {
  const url = imageryUrl(t.z, t.x, t.y);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url);
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const bmp = await createImageBitmap(await r.blob());
      const c = new OffscreenCanvas(TILE, TILE);
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0, TILE, TILE);
      return ctx.getImageData(0, 0, TILE, TILE).data;
    } catch (err) {
      if (attempt === 2) return null; // 写真が欠けても地形は作れるので、止めずに空けておく
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  return null;
}
