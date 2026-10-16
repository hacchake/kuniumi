import { t } from '../i18n/index.js';

// 歩いている間の地図（画面の右上）。北が上、真ん中が自分（矢印は向いている方）。
// 地球から取り込んだ地形は衛星写真（範囲の外は周りの地形の写真）、そうでなければ起伏の陰影図。
// 地図をたたくと広さが変わる（約 500 m → 2 km → 8 km → 全体）。
const SPANS = [500, 2000, 8000, 0]; // 地図の一辺の半分 (m)。0 = 大地全体

export class MiniMap {
  constructor(stage, view, store) {
    this.view = view;
    this.store = store;
    this.zoom = 1;
    this.layers = []; // { img, size }（大きい順）
    this.track = []; // 歩いた道すじ（平らな地図の座標 { x, z, y, jump }。y = 足元の標高）。3 m 動くごとに 1 点、新しい 5000 点まで
    this.dist = 0; // 歩いた（飛んだ）道のり (m)
    this.key = null;
    const el = document.createElement('div');
    el.className = 'minimap';
    el.hidden = true;
    el.innerHTML = `<canvas></canvas><div class="minimap-scale"></div>`;
    stage.appendChild(el);
    this.el = el;
    this.canvas = el.querySelector('canvas');
    this.scaleEl = el.querySelector('.minimap-scale');
    el.title = t('たたくと地図の広さが変わる');
    el.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.zoom = (this.zoom + 1) % SPANS.length;
      this.draw();
    });
  }

  show(on) {
    this.el.hidden = !on;
    cancelAnimationFrame(this.raf);
    if (!on) return;
    this.#prepare();
    const loop = () => {
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    loop();
  }

  // 地図の絵を用意する（地形が変わったときだけ作り直す）
  #prepare() {
    const s = this.store.get();
    const tr = s.terrain;
    const hm = tr.mode === 'heightmap' ? tr.heightmap : null;
    const usePhoto = hm && tr.photo !== false && hm.photo;
    const key = usePhoto ? `p:${hm.id}` : `r:${this.view.fieldKey}:${tr.size}:${s.water.level}:${s.water.enabled}`;
    if (key === this.key && this.layers.length) return;
    this.key = key;
    this.layers = [];
    if (usePhoto) {
      const load = (url, size) => {
        const img = new Image();
        img.onload = () => this.draw();
        img.src = url;
        return { img, size };
      };
      if (hm.surround?.photo) this.layers.push(load(hm.surround.photo, hm.surround.size));
      this.layers.push(load(hm.photo, tr.size));
    } else {
      const relief = this.#relief(s);
      if (relief) this.layers.push({ img: relief, size: tr.size });
    }
  }

  // 高さ場から陰影つきの地図（512 画素）
  #relief(s) {
    const d = this.view.terrainData;
    if (!d) return null;
    const { field, res } = d;
    const tr = s.terrain;
    const N = 512;
    const c = document.createElement('canvas');
    c.width = c.height = N;
    const ctx = c.getContext('2d');
    const im = ctx.createImageData(N, N);
    const at = (i, j) => field[Math.min(res - 1, Math.max(0, j)) * res + Math.min(res - 1, Math.max(0, i))];
    const cell = tr.size / (res - 1);
    const sea = s.water.enabled ? s.water.level : -Infinity;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const i = Math.round((x / (N - 1)) * (res - 1)), j = Math.round((y / (N - 1)) * (res - 1));
        const st = Math.max(1, Math.round(res / N));
        const h = tr.baseHeight + at(i, j) * tr.heightScale;
        const gx = ((at(i + st, j) - at(i - st, j)) * tr.heightScale) / (2 * st * cell);
        const gz = ((at(i, j + st) - at(i, j - st)) * tr.heightScale) / (2 * st * cell);
        // 北西から光が当たる陰影
        const shade = Math.max(0.25, Math.min(1.3, 0.85 + (gx + gz) * -0.35));
        let col;
        if (h < sea) col = [40, 80, 110];
        else {
          const a = Math.min(1, Math.max(0, (h - Math.max(sea, tr.baseHeight)) / Math.max(1, tr.heightScale)));
          col = a < 0.5 ? [90 + a * 120, 130 + a * 60, 70 + a * 40] : [150 + (a - 0.5) * 160, 150 + (a - 0.5) * 140, 120 + (a - 0.5) * 220];
        }
        const k = (y * N + x) * 4;
        im.data[k] = col[0] * shade;
        im.data[k + 1] = col[1] * shade;
        im.data[k + 2] = col[2] * shade;
        im.data[k + 3] = 255;
      }
    }
    ctx.putImageData(im, 0, 0);
    return c;
  }

  draw() {
    if (this.el.hidden) return;
    const cv = this.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = this.el.clientWidth;
    if (cv.width !== Math.round(W * dpr)) cv.width = cv.height = Math.round(W * dpr);
    const ctx = cv.getContext('2d');
    const px = cv.width;
    const tr = this.store.get().terrain;
    const half = SPANS[this.zoom] || tr.size / 2;
    const k = px / (2 * half); // 画素 / m
    const p = this.view.camera.position;
    // 道すじを記録（大きく飛び移ったときは線をつながない）
    const last = this.track[this.track.length - 1];
    const d = last ? Math.hypot(p.x - last.x, p.z - last.z) : Infinity;
    if (d > 3) {
      if (d < 500) this.dist += d;
      const y = p.y - (this.view.walk?.mode === 'walk' ? 1.65 : 0);
      this.track.push(d < 500 ? { x: p.x, z: p.z, y } : { x: p.x, z: p.z, y, jump: true });
      if (this.track.length > 5000) this.track.shift();
    }
    ctx.fillStyle = '#0b0f1a';
    ctx.fillRect(0, 0, px, px);
    // 写真・陰影図（どれも原点が中心の正方形）
    for (const { img, size } of this.layers) {
      if (img instanceof HTMLImageElement && !img.complete) continue;
      ctx.drawImage(img, px / 2 + (-size / 2 - p.x) * k, px / 2 + (-size / 2 - p.z) * k, size * k, size * k);
    }
    // 大地の範囲の枠
    ctx.strokeStyle = 'rgba(241, 215, 154, 0.5)';
    ctx.lineWidth = 1 * dpr;
    ctx.strokeRect(px / 2 + (-tr.size / 2 - p.x) * k, px / 2 + (-tr.size / 2 - p.z) * k, tr.size * k, tr.size * k);
    // 歩いた道すじ（赤い線）
    if (this.track.length > 1) {
      ctx.beginPath();
      for (const { x, z, jump } of this.track) {
        const sx = px / 2 + (x - p.x) * k, sy = px / 2 + (z - p.z) * k;
        if (jump) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      }
      ctx.lineTo(px / 2, px / 2);
      ctx.strokeStyle = 'rgba(255, 110, 90, 0.85)';
      ctx.lineWidth = 2 * dpr;
      ctx.lineJoin = 'round';
      ctx.stroke();
    }
    // 地名（取り込んだ地形の山・市・町・村）。広く見ているときは大きな所だけ
    const labels = tr.mode === 'heightmap' && tr.labels !== false ? tr.heightmap?.labels ?? [] : [];
    if (labels.length) {
      const minRank = half > 6000 ? 1 : half > 1500 ? 2 : 4; // 0 市, 1 山, 2 町, 3 地区, 4 村
      const rank = { city: 0, peak: 1, town: 2, suburb: 3, village: 4 };
      ctx.font = `${10.5 * dpr}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.lineWidth = 3 * dpr;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
      // 大事な順（市 → 高い山 → 町 …）に置き、重なるものは出さない
      const order = labels.filter((l) => rank[l.kind] <= minRank).sort((a, b) => rank[a.kind] - rank[b.kind] || (b.ele ?? 0) - (a.ele ?? 0));
      const placed = [];
      for (const l of order) {
        const x = px / 2 + (l.x - p.x) * k, y = px / 2 + (l.z - p.z) * k;
        if (x < 0 || y < 0 || x > px || y > px) continue;
        const text = l.kind === 'peak' ? `▲${l.name}` : l.name;
        const w = ctx.measureText(text).width, h = 12 * dpr;
        const r = { l: x - w / 2 - 2, r: x + w / 2 + 2, t: y - h, b: y + 2 };
        if (placed.some((q) => r.l < q.r && r.r > q.l && r.t < q.b && r.b > q.t)) continue;
        placed.push(r);
        ctx.fillStyle = l.kind === 'peak' ? '#ffe8b0' : '#ffffff';
        ctx.strokeText(text, x, y);
        ctx.fillText(text, x, y);
      }
    }
    // 自分（向いている方へ矢印）
    const f = this.view.walk.forward();
    const ang = Math.atan2(f.z, f.x);
    ctx.save();
    ctx.translate(px / 2, px / 2);
    ctx.rotate(ang);
    const r = 9 * dpr;
    ctx.beginPath();
    ctx.moveTo(r * 1.4, 0);
    ctx.lineTo(-r, r * 0.8);
    ctx.lineTo(-r * 0.5, 0);
    ctx.lineTo(-r, -r * 0.8);
    ctx.closePath();
    ctx.fillStyle = '#ffdf8a';
    ctx.strokeStyle = '#1a1206';
    ctx.lineWidth = 2 * dpr;
    ctx.stroke();
    ctx.fill();
    ctx.restore();
    // 北
    ctx.fillStyle = '#e07a6a';
    ctx.font = `700 ${12 * dpr}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('N', px / 2, 14 * dpr);
    // 縮尺（地図の幅の 1/4 ほどのきりのいい長さ）
    const target = (half * 2) / 4;
    const nice = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000, 200000, 500000, 1e6].find((v) => v >= target) ?? target;
    this.scaleEl.textContent = nice >= 1000 ? `${nice / 1000} km` : `${nice} m`;
    this.scaleEl.style.setProperty('--w', `${(nice * k) / dpr}px`);
  }
}
