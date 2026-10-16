// OpenStreetMap の水域（川・湖・ため池・用水路・海岸線）を取り寄せ、範囲の格子に焼き込む。
// 標高データと衛星写真だけでは、濁った湾や細い川を水と見分けられないため。
//   海  ：海岸線（natural=coastline。進む向きの右が海）で陸と海を切り分ける
//   内水：natural=water・waterway=riverbank の面と、waterway=river / canal の線（幅つき）
// 描くのは OffscreenCanvas（メインスレッドでもワーカーでも使える）。
import { aeqdForward, aeqdInverse } from './geo.js';

export const OSM_ATTRIBUTION = '© OpenStreetMap contributors（ODbL）';
const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
export const OSM_MAX_SIZE = 80e3; // これより広い範囲では取り寄せない（データが多すぎる）

// 範囲（正距方位図法の正方形）を囲む経緯度の枠
export function bboxOf(region) {
  let s = 90, n = -90, w = 180, e = -180;
  for (let k = 0; k <= 8; k++) {
    for (const [a, b] of [[k / 8, 0], [k / 8, 1], [0, k / 8], [1, k / 8]]) {
      const p = aeqdInverse((a - 0.5) * region.size, (b - 0.5) * region.size, region.lat, region.lon);
      s = Math.min(s, p.lat);
      n = Math.max(n, p.lat);
      w = Math.min(w, p.lon);
      e = Math.max(e, p.lon);
    }
  }
  return { s, w, n, e };
}

export async function fetchOsmWater(region, { timeoutMs = 60000 } = {}) {
  const b = bboxOf(region);
  const bb = `${b.s.toFixed(5)},${b.w.toFixed(5)},${b.n.toFixed(5)},${b.e.toFixed(5)}`;
  const q =
    `[out:json][timeout:60];(` +
    `way["natural"="water"](${bb});relation["natural"="water"](${bb});` +
    `way["waterway"="riverbank"](${bb});relation["waterway"="riverbank"](${bb});` +
    `way["waterway"~"^(river|canal)$"](${bb});` +
    `way["natural"="coastline"](${bb});` +
    `node["natural"="peak"]["name"](${bb});node["place"~"^(city|town|village|suburb)$"]["name"](${bb});` +
    `);out tags geom;`;
  let lastErr = null;
  // 混み合っていることがあるので、全部だめなら少し待ってもう一度
  for (const ep of [...ENDPOINTS, 'wait', ...ENDPOINTS]) {
    if (ep === 'wait') {
      await new Promise((r) => setTimeout(r, 8000));
      continue;
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(`${ep}?data=${encodeURIComponent(q)}`, { signal: ctl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      return j.elements ?? [];
    } catch (err) {
      lastErr = err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr ?? new Error('Overpass');
}

// 取り寄せた水域を、範囲の格子（res × res、行 0 = 北）に焼き込む。
// heightAt(i, j): その格子点の標高 (m)（海岸線の向きの確かめに使う）
// 戻り値：{ inland: Uint8Array（内水 0/255）, sea: Uint8Array|null（海 1）}
export function rasterizeOsmWater(elements, region, res, heightAt) {
  const P = res;
  const toPx = (lat, lon) => {
    const { e, n } = aeqdForward(lat, lon, region.lat, region.lon);
    return [(e / region.size + 0.5) * (P - 1), (0.5 - n / region.size) * (P - 1)];
  };
  const mpp = region.size / (P - 1); // 1 画素の m
  // ---- 内水（面と線）----
  const cv = new OffscreenCanvas(P, P);
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#fff';
  ctx.lineCap = ctx.lineJoin = 'round';
  const pathOf = (geom) => {
    ctx.moveTo(...toPx(geom[0].lat, geom[0].lon));
    for (let k = 1; k < geom.length; k++) ctx.lineTo(...toPx(geom[k].lat, geom[k].lon));
  };
  const coast = [];
  for (const el of elements) {
    const tg = el.tags ?? {};
    if (tg.natural === 'coastline') {
      if (el.geometry?.length > 1) coast.push(el.geometry);
      continue;
    }
    const isArea = tg.natural === 'water' || tg.waterway === 'riverbank';
    if (isArea) {
      ctx.beginPath();
      if (el.type === 'way' && el.geometry?.length > 2) pathOf(el.geometry);
      else if (el.type === 'relation') for (const m of el.members ?? []) if (m.geometry?.length > 2) pathOf(m.geometry);
      ctx.fill('evenodd');
    } else if (el.type === 'way' && el.geometry?.length > 1) {
      // 川の線：幅の値があればそれ、無ければ川 20 m・用水路 6 m（1 画素より細くはしない）
      const w = parseFloat(tg.width) || (tg.waterway === 'river' ? 20 : 6);
      ctx.lineWidth = Math.max(1.2, w / mpp);
      ctx.beginPath();
      pathOf(el.geometry);
      ctx.stroke();
    }
  }
  const px = ctx.getImageData(0, 0, P, P).data;
  const inland = new Uint8Array(P * P);
  for (let k = 0; k < inland.length; k++) inland[k] = px[k * 4] > 127 ? 255 : 0;

  // ---- 海（海岸線で切り分ける）----
  let sea = null;
  if (coast.length) {
    const lc = new OffscreenCanvas(P, P);
    const lx = lc.getContext('2d', { willReadFrequently: true });
    lx.strokeStyle = '#fff';
    lx.lineWidth = 2;
    lx.beginPath();
    // 海岸線の両側に「右（海）」「左（陸）」の印を置き、海岸線で区切られた区画ごとに多数決で海か陸かを決める
    // （狭い水路や崩れた向きの所で、印が向こう側に落ちても全体は崩れない）
    const marks = []; // [画素, +1 = 海 / −1 = 陸]
    for (const g of coast) {
      const pts = g.map((p) => toPx(p.lat, p.lon));
      lx.moveTo(...pts[0]);
      for (let k = 1; k < pts.length; k++) {
        lx.lineTo(...pts[k]);
        const dx = pts[k][0] - pts[k - 1][0], dy = pts[k][1] - pts[k - 1][1];
        const l = Math.hypot(dx, dy);
        if (l < 1) continue;
        const mx = (pts[k][0] + pts[k - 1][0]) / 2, my = (pts[k][1] + pts[k - 1][1]) / 2;
        // 進む向きの右（画面では (−dy, dx)）が海
        for (const [sgn, d] of [[1, 2.5], [-1, -2.5]]) {
          const sx = Math.round(mx + (-dy / l) * d), sy = Math.round(my + (dx / l) * d);
          if (sx >= 0 && sy >= 0 && sx < P && sy < P) marks.push(sy * P + sx, sgn);
        }
      }
    }
    lx.stroke();
    const line = lx.getImageData(0, 0, P, P).data;
    const wall = new Uint8Array(P * P);
    for (let k = 0; k < wall.length; k++) wall[k] = line[k * 4 + 3] > 40 ? 1 : 0;
    // 区画に番号をつける
    const label = new Int32Array(P * P).fill(-1);
    let nl = 0;
    const stack = [];
    for (let k0 = 0; k0 < label.length; k0++) {
      if (wall[k0] || label[k0] >= 0) continue;
      label[k0] = nl;
      stack.push(k0);
      while (stack.length) {
        const k = stack.pop();
        const i = k % P, j = (k - i) / P;
        if (i > 0 && label[k - 1] < 0 && !wall[k - 1]) (label[k - 1] = nl), stack.push(k - 1);
        if (i < P - 1 && label[k + 1] < 0 && !wall[k + 1]) (label[k + 1] = nl), stack.push(k + 1);
        if (j > 0 && label[k - P] < 0 && !wall[k - P]) (label[k - P] = nl), stack.push(k - P);
        if (j < P - 1 && label[k + P] < 0 && !wall[k + P]) (label[k + P] = nl), stack.push(k + P);
      }
      nl++;
    }
    const vote = new Float64Array(nl);
    for (let q = 0; q < marks.length; q += 2) {
      const lb = label[marks[q]];
      if (lb >= 0) vote[lb] += marks[q + 1];
    }
    sea = new Uint8Array(P * P);
    for (let k = 0; k < sea.length; k++) if (label[k] >= 0 && vote[label[k]] > 0) sea[k] = 1;
    // 海岸線の上の画素は、となりに海があれば海に
    for (let k = 0; k < sea.length; k++) if (wall[k] && (sea[k - 1] === 1 || sea[k + 1] === 1 || sea[k - P] === 1 || sea[k + P] === 1)) sea[k] = 2;
    for (let k = 0; k < sea.length; k++) if (sea[k] === 2) sea[k] = 1;
    // 確かめ：海とした所の多くが高い陸なら、海岸線がうまく閉じていない（使わない）
    let n = 0, high = 0;
    for (let k = 0; k < sea.length; k += 97) {
      if (!sea[k]) continue;
      n++;
      if (heightAt(k % P, Math.floor(k / P)) > 15) high++;
    }
    if (n && high / n > 0.1) sea = null;
  }
  return { inland, sea };
}

// 地名（山・市・町・村）を、範囲の世界座標（x = 東、z = 南）に。多すぎるときは大事なものから
export function labelsFrom(elements, region, { maxPeaks = 150, maxPlaces = 250 } = {}) {
  const half = region.size / 2;
  const out = [];
  for (const el of elements) {
    if (el.type !== 'node' || !el.tags?.name) continue;
    const kind = el.tags.natural === 'peak' ? 'peak' : el.tags.place;
    if (!['peak', 'city', 'town', 'village', 'suburb'].includes(kind)) continue;
    const { e, n } = aeqdForward(el.lat, el.lon, region.lat, region.lon);
    if (Math.abs(e) > half || Math.abs(n) > half) continue;
    const ele = parseFloat(el.tags.ele);
    out.push({ name: el.tags['name:ja'] || el.tags.name, kind, x: Math.round(e), z: Math.round(-n), ...(Number.isFinite(ele) ? { ele } : {}) });
  }
  const peaks = out.filter((l) => l.kind === 'peak').sort((a, b) => (b.ele ?? 0) - (a.ele ?? 0)).slice(0, maxPeaks);
  const rank = { city: 0, town: 1, suburb: 2, village: 3 };
  const places = out.filter((l) => l.kind !== 'peak').sort((a, b) => rank[a.kind] - rank[b.kind]).slice(0, maxPlaces);
  return [...places, ...peaks];
}

// 内水の印を PNG（グレー）の data URL に。一辺 maxSize まで縮める
export async function maskToDataUrl(mask, P, maxSize = 2048) {
  const s = Math.min(P, maxSize);
  const cv = new OffscreenCanvas(P, P);
  const ctx = cv.getContext('2d');
  const im = ctx.createImageData(P, P);
  for (let k = 0; k < mask.length; k++) {
    im.data[k * 4] = im.data[k * 4 + 1] = im.data[k * 4 + 2] = mask[k];
    im.data[k * 4 + 3] = 255;
  }
  ctx.putImageData(im, 0, 0);
  let out = cv;
  if (s < P) {
    out = new OffscreenCanvas(s, s);
    out.getContext('2d').drawImage(cv, 0, 0, s, s);
  }
  const blob = await out.convertToBlob({ type: 'image/png' });
  return await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}
