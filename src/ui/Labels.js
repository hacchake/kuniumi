// 景観の上に地名（山・市・町・村）を出す。取り込んだ地形の OpenStreetMap の地名（heightmap.labels）を、
// 描くたびに画面の位置へ置き直す（RealtimeRenderer の #draw から呼ばれる）。
// 小さい所ほど近づかないと出さない。重なる所は、大事なもの（市・高い山）を優先して後のものは出さない。
const REACH = { city: 80000, peak: 60000, town: 30000, suburb: 8000, village: 10000, waypoint: 15000 }; // 見える距離 (m)
const RANK = { city: 0, waypoint: 0.5, peak: 1, town: 2, suburb: 3, village: 4 }; // waypoint = 読み込んだ経路（GPX）の地点

export class Labels {
  constructor(stage) {
    this.el = document.createElement('div');
    this.el.className = 'labels';
    stage.appendChild(this.el);
    this.items = [];
    this.key = null;
    this.frame = 0;
  }

  // labels: [{ name, kind, x, z, ele? }]（世界座標、平らな地図の上）
  set(labels) {
    const key = labels ?? null;
    if (key === this.key) return;
    this.key = key;
    this.el.replaceChildren();
    this.items = (labels ?? [])
      .slice()
      .sort((a, b) => RANK[a.kind] - RANK[b.kind] || (b.ele ?? 0) - (a.ele ?? 0))
      .map((l) => {
        const d = document.createElement('div');
        d.className = `label label-${l.kind}`;
        d.textContent = l.kind === 'peak' ? `▲ ${l.name}${l.ele ? ` ${Math.round(l.ele)} m` : ''}` : l.kind === 'waypoint' ? `◆ ${l.name}` : l.name;
        d.hidden = true;
        this.el.appendChild(d);
        return { ...l, d, w: 0 };
      });
  }

  // project(x, y, z) → { x, y（画面の画素）, front, dist } | null、groundAt(x, z) → 標高
  // blocked(x, y, z): 手前の山に隠れているか
  update(project, groundAt, visible, blocked = null) {
    this.el.hidden = !visible || !this.items.length;
    if (this.el.hidden) return;
    // 毎コマでなくてよい（重さを抑える）
    if (this.frame++ % 2) return;
    const W = this.el.clientWidth, H = this.el.clientHeight;
    const placed = [];
    for (const it of this.items) {
      it.y ??= groundAt(it.x, it.z);
      const p = project(it.x, it.y + (it.kind === 'peak' ? 40 : 80), it.z);
      let show = p && p.front && p.dist < REACH[it.kind] && p.x > -50 && p.x < W + 50 && p.y > -20 && p.y < H + 20;
      if (show && blocked) show = !blocked(it.x, it.y + (it.kind === 'peak' ? 40 : 80), it.z);
      if (show) {
        if (!it.w) {
          it.d.hidden = false;
          it.w = it.d.offsetWidth || it.name.length * 13;
          it.h = it.d.offsetHeight || 18;
        }
        const r = { l: p.x - it.w / 2, t: p.y - it.h, r: p.x + it.w / 2, b: p.y };
        if (placed.some((q) => r.l < q.r && r.r > q.l && r.t < q.b && r.b > q.t)) show = false;
        else {
          placed.push(r);
          it.d.style.transform = `translate(${Math.round(r.l)}px, ${Math.round(r.t)}px)`;
          // 遠いほど薄く
          it.d.style.opacity = String(Math.min(1, 1.4 - p.dist / REACH[it.kind]));
        }
      }
      it.d.hidden = !show;
    }
  }
}
