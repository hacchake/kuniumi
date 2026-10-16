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
    const { features, extent } = readLayer(await r.arrayBuffer(), 'building');
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
    const P = new Float32Array(pos), C = new Float32Array(col), I = new Uint32Array(ids), M = new Float32Array(centers);
    const RG = new Float32Array(ring), RS = new Uint32Array(ringStart), T = new Float32Array(tops);
    self.postMessage({ key, positions: P, colors: C, ids: I, centers: M, count: bid, ring: RG, ringStart: RS, tops: T }, [P.buffer, C.buffer, I.buffer, M.buffer, RG.buffer, RS.buffer, T.buffer]);
  } catch (err) {
    self.postMessage({ key, error: String(err?.message ?? err) });
  }
};
