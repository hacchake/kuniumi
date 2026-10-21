// 窪地の湖：雨水が流れ出られない窪地に水をためる（water.lakes）。
// 1. fillDepressions: 高さ場の窪地を「あふれ出す高さ」まで埋めた面を求める（priority-flood。外周から低い順に水を広げる）
// 2. findLakes: 埋めた面と元の面の差がある所（窪地）をひとつずつの湖に分け、水面の高さを決める
// 高さ場は res×res、0..1（リアルタイム表示の高さ場と同じ）。標高 (m) = baseHeight + h × heightScale

// 窪地を埋めた面（各点 ≥ 元の高さ）。外周は水が流れ出る所とする
export function fillDepressions(field, res) {
  const n = res * res;
  const filled = new Float32Array(field);
  const done = new Uint8Array(n);
  const heap = new MinHeap(n);
  for (let i = 0; i < res; i++) {
    for (const k of [i, (res - 1) * res + i, i * res, i * res + res - 1]) {
      if (done[k]) continue;
      done[k] = 1;
      heap.push(k, filled[k]);
    }
  }
  while (heap.size) {
    const c = heap.pop();
    const ci = c % res, cj = (c - ci) / res, hc = filled[c];
    for (let dj = -1; dj <= 1; dj++) {
      const j = cj + dj;
      if (j < 0 || j >= res) continue;
      for (let di = -1; di <= 1; di++) {
        const i = ci + di;
        if (i < 0 || i >= res || (!di && !dj)) continue;
        const k = j * res + i;
        if (done[k]) continue;
        done[k] = 1;
        if (filled[k] < hc) filled[k] = hc; // 流れ出られない：あふれる高さまで水がたまる
        heap.push(k, filled[k]);
      }
    }
  }
  return filled;
}

// 湖を見つける。
//   amount: 窪地をどこまで満たすか（1 = あふれる寸前まで、0.5 = 深さの半分まで）
//   sea: 海面の標高 (m)（海が無ければ null）。海より低い湖は海に含める
//   minDepth: これより浅い窪地 (m) は水たまりとして無視する。minCells: これより小さい湖は無視する
// 戻り値: { level: Float32Array(res×res)（湖の水面の標高 m、湖でない所は -Infinity）, lakes: [{ level, cells }], shore: 周りへ広げた水面（水辺の判定用） }
export function findLakes(field, filled, res, { baseHeight, heightScale, amount = 1, sea = null, minDepth = 1.5, minCells = 12 }) {
  const n = res * res;
  const level = new Float32Array(n).fill(-Infinity);
  const comp = new Int32Array(n).fill(-1);
  const lakes = [];
  const eps = 1e-6;
  const stack = [];
  for (let s = 0; s < n; s++) {
    if (comp[s] !== -1 || filled[s] - field[s] <= eps) continue;
    // つながった窪地をひとつ集める（あふれる高さは窪地の中で同じ）
    const cells = [];
    comp[s] = lakes.length;
    stack.push(s);
    let lo = Infinity, spill = filled[s];
    while (stack.length) {
      const c = stack.pop();
      cells.push(c);
      if (field[c] < lo) lo = field[c];
      if (filled[c] > spill) spill = filled[c];
      const ci = c % res, cj = (c - ci) / res;
      for (const [i, j] of [[ci - 1, cj], [ci + 1, cj], [ci, cj - 1], [ci, cj + 1]]) {
        if (i < 0 || j < 0 || i >= res || j >= res) continue;
        const k = j * res + i;
        if (comp[k] !== -1 || filled[k] - field[k] <= eps) continue;
        comp[k] = lakes.length;
        stack.push(k);
      }
    }
    const a = Math.min(1, Math.max(0, amount));
    const L = baseHeight + (lo + (spill - lo) * a) * heightScale;
    const depth = (spill - lo) * a * heightScale;
    const wet = cells.filter((c) => baseHeight + field[c] * heightScale < L).length;
    const ok = depth >= minDepth && wet >= minCells && !(sea !== null && L <= sea + 0.3);
    lakes.push(ok ? { level: L, cells } : null);
    if (ok) for (const c of cells) level[c] = L;
  }
  const kept = lakes.filter(Boolean);
  // 水辺の判定用：湖の水面を周りへ 3 マス広げる（湖のすぐ外の岸辺にも「水際」が及ぶように）
  let shore = level;
  if (kept.length) {
    for (let it = 0; it < 3; it++) {
      const next = shore.slice();
      for (let j = 0; j < res; j++)
        for (let i = 0; i < res; i++) {
          const k = j * res + i;
          let m = shore[k];
          if (i > 0) m = Math.max(m, shore[k - 1]);
          if (i < res - 1) m = Math.max(m, shore[k + 1]);
          if (j > 0) m = Math.max(m, shore[k - res]);
          if (j < res - 1) m = Math.max(m, shore[k + res]);
          next[k] = m;
        }
      shore = next;
    }
  }
  return { level, lakes: kept, shore, res, field, baseHeight, heightScale };
}

// 湖の水面の標高 (m) を世界座標で引く（最も近い格子点。湖でなければ -Infinity）
export function lakeLevelAt(grid, size, x, z) {
  if (!grid) return -Infinity;
  const { shore, res } = grid;
  const i = Math.round((x / size + 0.5) * (res - 1)), j = Math.round((z / size + 0.5) * (res - 1));
  if (i < 0 || j < 0 || i >= res || j >= res) return -Infinity;
  return shore[j * res + i];
}

// 湖の水面の三角形（世界座標 x, 標高 y, z）。格子の升目ごとに、水に沈む角と、辺の上で地面が水面を横切る点を結ぶ
// （マーチングスクエア）。水面は岸の線で止まり、湖の縁の外へはみ出さない
export function lakeMeshData(grid, size) {
  const { level, res, field, baseHeight, heightScale } = grid;
  const cell = size / (res - 1);
  const pos = [];
  const hAt = (k) => baseHeight + field[k] * heightScale;
  const poly = [];
  for (let j = 0; j < res - 1; j++) {
    for (let i = 0; i < res - 1; i++) {
      const ks = [j * res + i, j * res + i + 1, (j + 1) * res + i + 1, (j + 1) * res + i]; // 角を一周する順
      const L = Math.max(level[ks[0]], level[ks[1]], level[ks[2]], level[ks[3]]);
      if (L === -Infinity) continue;
      const xs = [0, 1, 1, 0], zs = [0, 0, 1, 1];
      const h = ks.map(hAt);
      const wet = h.map((v) => v < L);
      if (!wet.some(Boolean)) continue;
      poly.length = 0;
      for (let c = 0; c < 4; c++) {
        const n = (c + 1) % 4;
        if (wet[c]) poly.push(xs[c], zs[c]);
        if (wet[c] !== wet[n]) {
          // 辺の上で地面の高さが水面を横切る所
          const t = Math.min(1, Math.max(0, (L - h[c]) / (h[n] - h[c])));
          poly.push(xs[c] + (xs[n] - xs[c]) * t, zs[c] + (zs[n] - zs[c]) * t);
        }
      }
      const x0 = i * cell - size / 2, z0 = j * cell - size / 2;
      for (let p = 2; p + 3 < poly.length; p += 2) {
        // 上から見て反時計回り（上向きの面）
        pos.push(x0 + poly[0] * cell, L, z0 + poly[1] * cell);
        pos.push(x0 + poly[p + 2] * cell, L, z0 + poly[p + 3] * cell);
        pos.push(x0 + poly[p] * cell, L, z0 + poly[p + 1] * cell);
      }
    }
  }
  return new Float32Array(pos);
}

class MinHeap {
  constructor(cap) {
    this.idx = new Int32Array(cap);
    this.key = new Float32Array(cap);
    this.size = 0;
  }
  push(i, k) {
    let p = this.size++;
    const { idx, key } = this;
    while (p > 0) {
      const q = (p - 1) >> 1;
      if (key[q] <= k) break;
      idx[p] = idx[q];
      key[p] = key[q];
      p = q;
    }
    idx[p] = i;
    key[p] = k;
  }
  pop() {
    const { idx, key } = this;
    const top = idx[0];
    const n = --this.size;
    if (n > 0) {
      const li = idx[n], lk = key[n];
      let p = 0;
      for (;;) {
        let c = p * 2 + 1;
        if (c >= n) break;
        if (c + 1 < n && key[c + 1] < key[c]) c++;
        if (key[c] >= lk) break;
        idx[p] = idx[c];
        key[p] = key[c];
        p = c;
      }
      idx[p] = li;
      key[p] = lk;
    }
    return top;
  }
}
