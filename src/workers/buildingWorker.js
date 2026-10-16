// 建物（OpenFreeMap のベクトルタイル z14 の building 層）を取り寄せ、景観の世界座標（x = 東、z = 南）の立体にする。
// 地面の高さは描く側で足す（建物ごとの番号と中心を返す）。
import { ShapeUtils, Vector2 } from 'three';
import { readLayer, polygonsOf } from '../core/mvt.js';
import { aeqdForward } from '../core/geo.js';

self.onmessage = async (e) => {
  const { key, url, z, x, y, geo } = e.data;
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const buf = await r.arrayBuffer();
    const { features, extent } = readLayer(buf, 'building');
    const n = 2 ** z;
    const toLocal = ([px, py]) => {
      const gx = (x + px / extent) / n, gy = (y + py / extent) / n;
      const lon = gx * 360 - 180;
      const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * gy))) * 180) / Math.PI;
      const p = aeqdForward(lat, lon, geo.lat, geo.lon);
      return [p.e, -p.n];
    };
    const pos = [], col = [], ids = [], centers = [];
    // ぶつかる判定用：建物ごとの外形（x, z の並び）と高さ
    const ring = [], ringStart = [], tops = [];
    let bid = 0;
    for (const f of features) {
      if (f.type !== 3) continue;
      const h = Math.max(3, Number(f.props.render_height) || 6);
      const h0 = Math.max(0, Number(f.props.render_min_height) || 0);
      if (h0 >= h) continue;
      for (const poly of polygonsOf(f.rings)) {
        const outer = poly.outer.map(toLocal);
        if (outer.length < 3) continue;
        // 小さな建物（物置など、床が 30 m² 未満）は省く（数が多く重い。遠くからは見えない）
        let area = 0;
        for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) area += (outer[j][0] - outer[i][0]) * (outer[j][1] + outer[i][1]);
        if (Math.abs(area / 2) < 30) continue;
        const holes = poly.holes.map((hr) => hr.map(toLocal));
        let cx = 0, cz = 0;
        for (const p of outer) (cx += p[0]), (cz += p[1]);
        cx /= outer.length;
        cz /= outer.length;
        // 色：薄い灰〜ベージュ（建物ごとに少し違う）。屋根は少し暗く
        const t = Math.sin(bid * 12.9898 + cx * 0.01) * 43758.5453;
        const v = t - Math.floor(t);
        const wall = [0.62 + v * 0.18, 0.6 + v * 0.14, 0.56 + v * 0.1];
        const roof = wall.map((c) => c * 0.72);
        const push = (p, c) => {
          pos.push(p[0], p[1], p[2]);
          col.push(c[0], c[1], c[2]);
          ids.push(bid);
        };
        // 壁
        for (const ring of [outer, ...holes]) {
          for (let i = 0; i < ring.length; i++) {
            const a = ring[i], b = ring[(i + 1) % ring.length];
            if (a[0] === b[0] && a[1] === b[1]) continue;
            const a0 = [a[0], h0, a[1]], b0 = [b[0], h0, b[1]], a1 = [a[0], h, a[1]], b1 = [b[0], h, b[1]];
            push(a0, wall), push(b0, wall), push(b1, wall);
            push(a0, wall), push(b1, wall), push(a1, wall);
          }
        }
        // 屋根
        const tri = ShapeUtils.triangulateShape(
          outer.map((p) => new Vector2(p[0], p[1])),
          holes.map((hr) => hr.map((p) => new Vector2(p[0], p[1]))),
        );
        const all = [...outer, ...holes.flat()];
        for (const [i0, i1, i2] of tri) {
          push([all[i0][0], h, all[i0][1]], roof);
          push([all[i1][0], h, all[i1][1]], roof);
          push([all[i2][0], h, all[i2][1]], roof);
        }
        centers.push(cx, cz);
        ringStart.push(ring.length / 2);
        for (const p of outer) ring.push(p[0], p[1]);
        tops.push(h);
        bid++;
      }
    }
    ringStart.push(ring.length / 2);
    // 道（夜の街灯の光の帯）：transportation 層の線。広い道ほど太く明るく
    const roads = readLayer(buf, 'transportation');
    const W = { motorway: [14, 1.0], trunk: [12, 0.9], primary: [10, 0.85], secondary: [8, 0.7], tertiary: [7, 0.6], minor: [5, 0.4], service: [3, 0.25] };
    const rpos = [], rglow = [];
    for (const f of roads.features) {
      if (f.type !== 2) continue;
      const w = W[f.props.class];
      if (!w) continue;
      for (const line of f.rings) {
        const pts = line.map(toLocal);
        for (let i = 0; i + 1 < pts.length; i++) {
          const a = pts[i], b = pts[i + 1];
          const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz);
          if (l < 0.5) continue;
          const nx = (-dz / l) * w[0] * 0.5, nz = (dx / l) * w[0] * 0.5;
          const q = [[a[0] + nx, a[1] + nz], [a[0] - nx, a[1] - nz], [b[0] + nx, b[1] + nz], [b[0] - nx, b[1] - nz]];
          for (const k of [0, 1, 2, 2, 1, 3]) {
            rpos.push(q[k][0], 0, q[k][1]);
            rglow.push(w[1]);
          }
        }
      }
    }
    const RP = new Float32Array(rpos), RW = new Float32Array(rglow);
    const P = new Float32Array(pos), C = new Float32Array(col), I = new Uint32Array(ids), M = new Float32Array(centers);
    const RG = new Float32Array(ring), RS = new Uint32Array(ringStart), T = new Float32Array(tops);
    self.postMessage({ key, positions: P, colors: C, ids: I, centers: M, count: bid, ring: RG, ringStart: RS, tops: T, roads: RP, roadGlow: RW }, [P.buffer, C.buffer, I.buffer, M.buffer, RG.buffer, RS.buffer, T.buffer, RP.buffer, RW.buffer]);
  } catch (err) {
    self.postMessage({ key, error: String(err?.message ?? err) });
  }
};
