import { getIn, RESOLUTIONS } from '../core/schema.js';

// 設定パネル。項目は「シーン JSON のパス」と結びついた宣言的な一覧で作る。
// パネルは描画のことを知らない（ストアに書くだけ）。

const SECTIONS = [
  {
    id: 'land',
    title: '大地',
    sub: 'Land',
    open: true,
    fields: [
      { path: 'terrain.mode', label: '生成方法', type: 'select', options: [['noise', 'ノイズで生成'], ['heightmap', 'ハイトマップ']] },
      { path: 'terrain.noise.seed', label: '種', type: 'seed' },
      { path: 'terrain.size', label: '大きさ', min: 500, max: 40000, step: 100, unit: 'm' },
      { path: 'terrain.heightScale', label: '起伏の高さ', min: 0, max: 8000, step: 10, unit: 'm' },
      { path: 'terrain.baseHeight', label: '基準の標高', min: -4000, max: 2000, step: 10, unit: 'm' },
      { path: 'terrain.resolution', label: '解像度', type: 'select', options: RESOLUTIONS.map((r) => [r, `${r} × ${r}`]), number: true },
    ],
  },
  {
    id: 'shape',
    title: '地形の性格',
    sub: 'Character',
    open: true,
    noiseOnly: true,
    fields: [
      { path: 'terrain.noise.frequency', label: '山の数', min: 0.4, max: 10, step: 0.05 },
      { path: 'terrain.noise.octaves', label: '細部の段数', min: 1, max: 11, step: 1 },
      { path: 'terrain.noise.persistence', label: '粗さ', min: 0.2, max: 0.75, step: 0.01 },
      { path: 'terrain.noise.lacunarity', label: '細部の細かさ', min: 1.5, max: 3, step: 0.01 },
      { path: 'terrain.noise.ridged', label: '尾根の鋭さ', min: 0, max: 1, step: 0.01 },
      { path: 'terrain.noise.warp', label: 'うねり', min: 0, max: 2, step: 0.01 },
      { path: 'terrain.noise.valley', label: '谷の平らさ', min: 0.5, max: 4, step: 0.01 },
      { path: 'terrain.noise.falloff', label: '外周の沈み', min: 0, max: 1, step: 0.01 },
    ],
  },
  {
    id: 'surface',
    title: '地表',
    sub: 'Surface',
    fields: [
      { path: 'terrain.palette.low', label: '低地', type: 'color' },
      { path: 'terrain.palette.high', label: '高地', type: 'color' },
      { path: 'terrain.palette.rock', label: '岩肌', type: 'color' },
      { path: 'terrain.palette.snow', label: '雪', type: 'color' },
      { path: 'terrain.palette.shore', label: '水辺', type: 'color' },
      { path: 'terrain.palette.snowLine', label: '雪線', min: 0, max: 1.1, step: 0.01 },
      { path: 'terrain.palette.rockSlope', label: '岩が出る傾斜', min: 0.15, max: 2.5, step: 0.01 },
    ],
  },
  {
    id: 'sun',
    title: '太陽',
    sub: 'Sun',
    open: true,
    fields: [
      { path: 'sun.elevation', label: '高度', min: -12, max: 90, step: 0.1, unit: '°' },
      { path: 'sun.azimuth', label: '方位', min: 0, max: 360, step: 0.5, unit: '°' },
      { path: 'sun.intensity', label: '強さ', min: 0, max: 3, step: 0.01 },
    ],
  },
  {
    id: 'sky',
    title: '大気',
    sub: 'Atmosphere',
    fields: [
      { path: 'atmosphere.rayleigh', label: '空の青さ', min: 0, max: 8, step: 0.01 },
      { path: 'atmosphere.turbidity', label: '大気の濁り', min: 0.5, max: 20, step: 0.1 },
      { path: 'atmosphere.mieCoefficient', label: '光の散乱', min: 0, max: 0.05, step: 0.0005 },
      { path: 'atmosphere.mieDirectionalG', label: '太陽のにじみ', min: 0, max: 0.999, step: 0.001 },
      { path: 'atmosphere.haze', label: '遠景のかすみ', min: 0, max: 1.5, step: 0.01 },
      { path: 'atmosphere.ambient', label: '空の照り返し', min: 0, max: 2, step: 0.01 },
      { path: 'atmosphere.exposure', label: '露出', min: 0.05, max: 1.5, step: 0.01 },
    ],
  },
  {
    id: 'water',
    title: '水',
    sub: 'Water',
    open: true,
    fields: [
      { path: 'water.enabled', label: '水をはる', type: 'toggle' },
      { path: 'water.level', label: '水位', min: -3000, max: 5000, step: 1, unit: 'm', dynamic: 'waterRange' },
      { path: 'water.color', label: '水の色', type: 'color' },
      { path: 'water.distortion', label: '揺らぎ', min: 0, max: 8, step: 0.1 },
      { path: 'water.waveScale', label: '波の大きさ', min: 0.1, max: 4, step: 0.01 },
    ],
  },
  {
    id: 'still',
    title: '一枚絵',
    sub: 'Still',
    fields: [
      { path: 'camera.fov', label: '画角', min: 10, max: 100, step: 0.5, unit: '°' },
      { path: 'render.still.width', label: '幅', min: 320, max: 7680, step: 16, unit: 'px' },
      { path: 'render.still.height', label: '高さ', min: 240, max: 4320, step: 16, unit: 'px' },
      { path: 'render.still.samples', label: 'サンプル数', min: 16, max: 4096, step: 16 },
    ],
  },
];

export class Panel {
  constructor(root, store) {
    this.store = store;
    this.root = root;
    this.bindings = [];
    this.sections = [];
    for (const sec of SECTIONS) this.#buildSection(sec);
    store.subscribe((s, changed, meta) => {
      if (meta.source !== 'ui') this.sync(s);
      else this.#syncState(s);
    });
    this.sync(store.get());
  }

  #buildSection(sec) {
    const el = document.createElement('details');
    el.className = 'sec';
    el.open = !!sec.open;
    el.innerHTML = `<summary><span class="sec-title">${sec.title}</span><span class="sec-sub">${sec.sub}</span></summary>`;
    const body = document.createElement('div');
    body.className = 'sec-body';
    el.appendChild(body);
    for (const f of sec.fields) body.appendChild(this.#buildField(f));
    this.root.appendChild(el);
    this.sections.push({ sec, el });
  }

  #buildField(f) {
    const row = document.createElement('label');
    row.className = `row row-${f.type ?? 'range'}`;
    const name = document.createElement('span');
    name.className = 'row-label';
    name.textContent = f.label;
    row.appendChild(name);
    const set = (v) => this.store.set(f.path, v, { source: 'ui' });

    if (f.type === 'select') {
      const sel = document.createElement('select');
      for (const [v, t] of f.options) sel.add(new Option(t, v));
      sel.onchange = () => set(f.number ? Number(sel.value) : sel.value);
      row.appendChild(sel);
      this.bindings.push({ f, read: (v) => (sel.value = String(v)), el: sel });
    } else if (f.type === 'toggle') {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.onchange = () => set(cb.checked);
      const sw = document.createElement('span');
      sw.className = 'switch';
      row.append(cb, sw);
      this.bindings.push({ f, read: (v) => (cb.checked = !!v), el: cb });
    } else if (f.type === 'color') {
      const c = document.createElement('input');
      c.type = 'color';
      c.oninput = () => set(c.value);
      const hex = document.createElement('span');
      hex.className = 'hex';
      row.append(c, hex);
      this.bindings.push({ f, read: (v) => ((c.value = v), (hex.textContent = v)), el: c });
    } else if (f.type === 'seed') {
      const num = document.createElement('input');
      num.type = 'number';
      num.step = 1;
      num.onchange = () => set(Math.trunc(Number(num.value)) || 0);
      const dice = document.createElement('button');
      dice.type = 'button';
      dice.className = 'dice';
      dice.title = '新しい種';
      dice.textContent = '⟳';
      dice.onclick = (e) => {
        e.preventDefault();
        set(Math.floor(Math.random() * 100000));
      };
      row.append(num, dice);
      this.bindings.push({ f, read: (v) => (num.value = v), el: num });
    } else {
      const range = document.createElement('input');
      range.type = 'range';
      range.min = f.min;
      range.max = f.max;
      range.step = f.step;
      const num = document.createElement('input');
      num.type = 'number';
      num.step = f.step;
      const unit = document.createElement('span');
      unit.className = 'unit';
      unit.textContent = f.unit ?? '';
      range.oninput = () => {
        num.value = range.value;
        set(Number(range.value));
      };
      num.onchange = () => {
        const v = Number(num.value);
        if (Number.isFinite(v)) set(v);
      };
      row.append(range, num, unit);
      this.bindings.push({
        f,
        el: range,
        read: (v) => {
          range.value = v;
          if (document.activeElement !== num) num.value = round(v, f.step);
        },
        range,
      });
    }
    return row;
  }

  sync(s) {
    for (const b of this.bindings) {
      if (document.activeElement === b.el && b.f.type !== 'range' && b.f.type) continue;
      b.read(getIn(s, b.f.path));
    }
    this.#syncState(s);
  }

  #syncState(s) {
    // 水位スライダーの範囲を地形の標高に合わせる（操作中は動かさない）
    const wb = this.bindings.find((b) => b.f.dynamic === 'waterRange');
    if (document.activeElement !== wb.range) {
      const lo = Math.floor(s.terrain.baseHeight - 50);
      const hi = Math.ceil(s.terrain.baseHeight + s.terrain.heightScale + 50);
      wb.range.min = Math.min(lo, s.water.level);
      wb.range.max = Math.max(hi, s.water.level);
      wb.range.value = s.water.level;
    }
    const noise = s.terrain.mode === 'noise';
    for (const { sec, el } of this.sections) if (sec.noiseOnly) el.classList.toggle('dim', !noise);
    const modeSel = this.bindings.find((b) => b.f.path === 'terrain.mode').el;
    modeSel.options[1].disabled = !s.terrain.heightmap;
    modeSel.options[1].text = s.terrain.heightmap ? `ハイトマップ（${s.terrain.heightmap.name}）` : 'ハイトマップ（未読込）';
    const seed = this.bindings.find((b) => b.f.path === 'terrain.noise.seed');
    seed.el.closest('.row').classList.toggle('dim', !noise);
    for (const b of this.bindings) {
      if (b.f.path.startsWith('water.') && b.f.path !== 'water.enabled') b.el.closest('.row').classList.toggle('dim', !s.water.enabled);
    }
  }
}

function round(v, step) {
  const d = String(step).includes('.') ? String(step).split('.')[1].length : 0;
  return Number(v).toFixed(d);
}
