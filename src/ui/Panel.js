import { getIn, RESOLUTIONS, SIZE_MIN, SIZE_MAX, createDefaultScene } from '../core/schema.js';
import { solarPosition } from '../core/sun.js';
import { t } from '../i18n/index.js';

// 項目の説明（マウスを乗せると出る）
const HINTS = {
  'terrain.noise.seed': '地形の元になる乱数。数字を変えると別の大地になる（⟳ で無作為に）',
  'terrain.size': '大地の一辺の長さ。箱庭の 200 m から、大陸がまるごと入る 1 万 km まで',
  'terrain.detail': '高さ場の格子より細かい所に足す小さな起伏。近づいたときの平らな面を和らげる',
  'terrain.labels': '地球から取り込んだ地形に、山（標高つき）・市・町・村の名前を出す（OpenStreetMap）',
  'sun.when': '日時を選んで「合わせる」と、その場所（地球から取り込んだ地形ならその中心、ほかは東京）の実際の太陽の高さと方位にする',
  'terrain.photo': '地球から取り込んだ地形の色を、衛星写真（Sentinel-2 cloudless・NASA Blue Marble）にする。切ると標高と傾きから塗る',
  'planet.curvature': '星の丸みを描く。遠くの地面や海が地平線の向こうへ沈み、高く昇ると丸い星が見える',
  'planet.radius': '星の半径。地球は 6371 km。小さいほど地平線が近く、丸みが強い',
  'terrain.heightScale': '一番低い所から一番高い所までの差',
  'terrain.baseHeight': '一番低い所の標高。水位 0 m より下なら海の底になる',
  'terrain.resolution': '大地全体の高さ場の細かさ。近くは自動で細かく描く（格子より細かい所は小さな起伏で補う）。大陸なら 2049 以上',
  'terrain.noise.frequency': '大きな山のかたまりの数の目安',
  'terrain.noise.octaves': '大きな形に重ねる細かい起伏の段数',
  'terrain.noise.persistence': '細かい起伏をどれだけ強く重ねるか（大きいほどごつごつ）',
  'terrain.noise.lacunarity': '段ごとに起伏がどれだけ細かくなるか',
  'terrain.noise.ridged': '0 = なだらかな丘、1 = 鋭い稜線の山脈',
  'terrain.noise.warp': '地形をねじって、川筋や入り江のような流れる形にする',
  'terrain.noise.valley': '大きいほど低い所が平らになり、山がそびえる',
  'terrain.noise.falloff': '外周を沈めて島や大陸にする',
  'terrain.noise.erosion': '雨が削る谷筋と、土砂がたまる扇状地をつくる',
  'terrain.palette.snowLine': '水面〜最高点のうち、雪が乗り始める高さの割合',
  'terrain.palette.rockSlope': 'この傾きより急な斜面に岩肌が出る',
  'vegetation.trees': '森の広さと密度。リアルタイムでは森の色、一枚絵では木そのものが描かれる',
  'vegetation.grass': '一枚絵で、カメラが地面に近いときに足元へ草を置く',
  'sun.elevation': '地平線からの太陽の高さ。マイナスは日没後',
  'sun.azimuth': '北を 0° として東回りの方角（90° = 東、180° = 南）',
  'atmosphere.rayleigh': '空の青さ。大きいほど深い青、夕焼けは赤く',
  'atmosphere.turbidity': '空気の濁り（ちり・水蒸気）。大きいほど白っぽい空',
  'atmosphere.mieCoefficient': '太陽のまわりの明るいにじみの強さ',
  'atmosphere.mieDirectionalG': '太陽のにじみの広がり（大きいほど太陽の近くに集まる）',
  'atmosphere.haze': '地表付近の霧・かすみの濃さ',
  'atmosphere.ambient': '空から降りそそぐ光の強さ（1 = 物理的に正しい）',
  'atmosphere.exposure': '写真の露出。明るすぎ・暗すぎを調整する',
  'atmosphere.clouds': '雲の量（0 = 快晴）',
  'atmosphere.cloudDensity': '雲の詰まり具合。大きいほど白く厚く、影も濃い',
  'atmosphere.cloudScale': '雲のかたまりの細かさ',
  'atmosphere.cloudAltitude': '雲の底の標高。山より低くすると山頂が雲の上に出る',
  'atmosphere.cloudThickness': '雲の厚み。大きいほどもくもくと高く盛り上がる',
  'atmosphere.fogHeight': '霧が薄まっていく高さの目安',
  'atmosphere.rays': '霧が日光を前へ散らす度合い。逆光で光の筋がはっきりする',
  'water.level': '水面の標高',
  'water.distortion': '水面の揺らぎ・映り込みの崩れ',
  'render.still.size': '一枚絵の大きさのひな形。選ぶと幅と高さが変わる',
  'render.still.samples': '1 画素あたりの光の計算回数。多いほどなめらかで時間がかかる（ノイズ除去があれば 32〜128 で十分）',
  'render.still.terrainDetail': '一枚絵の地形の細かさの上限',
  'render.still.denoise': 'AI（Intel Open Image Denoise）でざらつきを取る',
  'render.still.exposure': 'リアルタイムの露出に対する補正',
  'render.still.bloom': '明るい所の光のにじみ',
};

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
      { path: 'terrain.size', label: '大きさ', min: SIZE_MIN, max: SIZE_MAX, log: true, scale: 0.001, step: 0.01, unit: 'km' },
      { path: 'terrain.heightScale', label: '起伏の高さ', min: 0, max: 20000, step: 10, unit: 'm' },
      { path: 'terrain.baseHeight', label: '基準の標高', min: -12000, max: 5000, step: 10, unit: 'm' },
      { path: 'terrain.resolution', label: '解像度', type: 'select', options: RESOLUTIONS.map((r) => [r, `${r} × ${r}`]), number: true },
      { path: 'terrain.detail', label: '細部の起伏', min: 0, max: 3, step: 0.05 },
      { path: 'terrain.photo', label: '衛星写真の色', type: 'toggle' },
      { path: 'terrain.labels', label: '地名を表示', type: 'toggle' },
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
      { path: 'terrain.noise.erosion', label: '侵食', min: 0, max: 1, step: 0.01 },
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
    id: 'vegetation',
    title: '植生',
    sub: 'Vegetation',
    fields: [
      { path: 'vegetation.trees', label: '森の量', min: 0, max: 1, step: 0.01 },
      { path: 'vegetation.treeHeight', label: '木の高さ', min: 3, max: 60, step: 0.5, unit: 'm' },
      { path: 'vegetation.conifer', label: '針葉樹の割合', min: 0, max: 1, step: 0.01 },
      { path: 'vegetation.grass', label: '草（一枚絵）', min: 0, max: 1, step: 0.01 },
      { path: 'terrain.palette.forest', label: '森の地面の色', type: 'color' },
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
      { path: 'sun.when', label: '日時から', type: 'sunTime' },
    ],
  },
  {
    id: 'planet',
    title: '星',
    sub: 'Planet',
    fields: [
      { path: 'planet.curvature', label: '丸みを描く', type: 'toggle' },
      { path: 'planet.radius', label: '半径', min: 100000, max: 100000000, log: true, scale: 0.001, step: 1, unit: 'km' },
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
      { path: 'atmosphere.exposure', label: '露出', min: 0.01, max: 1, step: 0.005 },
      { path: 'atmosphere.clouds', label: '雲の量', min: 0, max: 1, step: 0.01 },
      { path: 'atmosphere.cloudDensity', label: '雲の厚さ', min: 0, max: 1, step: 0.01 },
      { path: 'atmosphere.cloudScale', label: '雲の細かさ', min: 0.00005, max: 0.001, step: 0.00001 },
      { path: 'atmosphere.cloudAltitude', label: '雲の底の標高', min: 300, max: 8000, step: 10, unit: 'm' },
      { path: 'atmosphere.cloudThickness', label: '雲の厚み', min: 50, max: 3000, step: 10, unit: 'm' },
      { path: 'atmosphere.fogHeight', label: '霧の厚み', min: 100, max: 4000, step: 10, unit: 'm' },
      { path: 'atmosphere.rays', label: '光の筋', min: 0, max: 0.9, step: 0.01 },
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
      {
        path: 'render.still.size',
        label: '大きさ',
        type: 'sizePreset',
        options: [
          [1280, 720, 'HD（1280×720）'],
          [1920, 1080, 'フル HD（1920×1080）'],
          [2560, 1440, 'WQHD（2560×1440）'],
          [3840, 2160, '4K（3840×2160）'],
          [2048, 2048, '正方形（2048×2048）'],
          [1080, 1920, '縦長（1080×1920）'],
          [3508, 2480, 'A4 横・300dpi（3508×2480）'],
        ],
      },
      { path: 'render.still.width', label: '幅', min: 320, max: 7680, step: 16, unit: 'px' },
      { path: 'render.still.height', label: '高さ', min: 240, max: 4320, step: 16, unit: 'px' },
      { path: 'render.still.samples', label: 'サンプル数', min: 8, max: 1024, step: 8 },
      { path: 'render.still.terrainDetail', label: '地形の精細さ', type: 'select', options: [[1025, '高（約400万三角形）'], [2049, '最高（約700万三角形・重い）']], number: true },
      { path: 'render.still.denoise', label: 'ノイズ除去', type: 'toggle' },
      { path: 'render.still.tone', label: '色調', type: 'select', options: [['agx', 'AgX（映画調）'], ['aces', 'ACES']] },
      { path: 'render.still.exposure', label: '露出補正', min: 0.25, max: 4, step: 0.05 },
      { path: 'render.still.bloom', label: '光のにじみ', min: 0, max: 0.2, step: 0.005 },
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
    el.innerHTML = `<summary><span class="sec-title">${sec.title}</span><span class="sec-sub">${sec.sub}</span><button type="button" class="sec-reset" title="この項目を既定値に戻す（元に戻すで戻せる）" aria-label="${t('{title}を既定値に戻す', { title: t(sec.title) })}">↺</button></summary>`;
    el.querySelector('.sec-reset').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.#resetSection(sec);
    });
    const body = document.createElement('div');
    body.className = 'sec-body';
    el.appendChild(body);
    for (const f of sec.fields) body.appendChild(this.#buildField(f));
    this.root.appendChild(el);
    this.sections.push({ sec, el });
  }

  // 1 つのセクションの項目を既定値へ（1 回の操作として元に戻せる）
  #resetSection(sec) {
    const def = createDefaultScene();
    const changes = {};
    for (const f of sec.fields) {
      // 種と生成方法は作品の中身そのものなので戻さない
      if (f.type === 'seed' || f.type === 'sizePreset' || f.type === 'sunTime' || f.path === 'terrain.mode') continue;
      changes[f.path] = getIn(def, f.path);
    }
    this.store.patch(changes, { source: 'ui-reset' });
  }

  #buildField(f) {
    const row = document.createElement('label');
    row.className = `row row-${f.type ?? 'range'}`;
    const hint = f.hint ?? HINTS[f.path];
    if (hint) row.title = hint;
    const name = document.createElement('span');
    name.className = 'row-label';
    name.textContent = f.label;
    row.appendChild(name);
    const set = (v) => this.store.set(f.path, v, { source: 'ui' });

    if (f.type === 'sunTime') {
      // その場所（地球から取り込んだ地形ならその中心、ほかは東京）の、選んだ日時の実際の太陽にする
      const when = document.createElement('input');
      when.type = 'datetime-local';
      const now = new Date();
      when.value = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'sun-go';
      go.textContent = t('合わせる');
      go.onclick = (e) => {
        e.preventDefault();
        const g = this.store.get().terrain.heightmap?.geo;
        const lat = g?.lat ?? 35.68, lon = g?.lon ?? 139.77;
        const d = when.value ? new Date(when.value) : new Date();
        const p = solarPosition(lat, lon, d);
        this.store.patch({ 'sun.elevation': Math.round(Math.max(-12, p.elevation) * 10) / 10, 'sun.azimuth': Math.round(p.azimuth * 2) / 2 }, { source: 'ui' });
      };
      // ▶：時刻を進め続ける（0.1 秒ごとに 5 分。一日の光の移り変わりを眺める）
      const play = document.createElement('button');
      play.type = 'button';
      play.className = 'sun-go sun-play';
      play.textContent = '▶';
      play.title = t('時刻を進める（もう一度押すと止まる）');
      let timer = 0;
      play.onclick = (e) => {
        e.preventDefault();
        if (timer) {
          clearInterval(timer);
          timer = 0;
          play.textContent = '▶';
          return;
        }
        play.textContent = '■';
        timer = setInterval(() => {
          const d = when.value ? new Date(when.value) : new Date();
          d.setMinutes(d.getMinutes() + 5);
          when.value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
          go.onclick(new Event('click'));
        }, 100);
      };
      row.append(when, go, play);
      return row;
    }
    if (f.type === 'sizePreset') {
      // 幅と高さをまとめて選ぶ（どれにも当てはまらなければ「指定の大きさ」）
      const sel = document.createElement('select');
      sel.add(new Option('指定の大きさ', ''));
      for (const [w, h, t] of f.options) sel.add(new Option(t, `${w}x${h}`));
      sel.onchange = () => {
        if (!sel.value) return;
        const [w, h] = sel.value.split('x').map(Number);
        this.store.patch({ 'render.still.width': w, 'render.still.height': h }, { source: 'ui' });
      };
      row.appendChild(sel);
      this.bindings.push({
        f: { ...f, path: 'render.still' },
        el: sel,
        read: (st) => (sel.value = f.options.some(([w, h]) => w === st.width && h === st.height) ? `${st.width}x${st.height}` : ''),
      });
    } else if (f.type === 'select') {
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
      // log: 目盛りを対数に（桁の違う値を 1 本で扱う）、scale: 表示の単位への換算（m → km など）
      const k = f.scale ?? 1;
      const toR = (v) => (f.log ? Math.log10(Math.max(f.min, v)) : v);
      const fromR = (r) => (f.log ? roundSig(10 ** r, 3) : r);
      const range = document.createElement('input');
      range.type = 'range';
      range.min = toR(f.min);
      range.max = toR(f.max);
      range.step = f.log ? 0.001 : f.step;
      const num = document.createElement('input');
      num.type = 'number';
      num.step = f.step;
      const unit = document.createElement('span');
      unit.className = 'unit';
      unit.textContent = f.unit ?? '';
      range.oninput = () => {
        const v = fromR(Number(range.value));
        num.value = round(v * k, f.step);
        set(v);
      };
      num.onchange = () => {
        const v = Number(num.value) / k;
        if (Number.isFinite(v)) set(f.log ? Math.min(f.max, Math.max(f.min, v)) : v);
      };
      row.append(range, num, unit);
      this.bindings.push({
        f,
        el: range,
        read: (v) => {
          range.value = toR(v);
          if (document.activeElement !== num) num.value = round(v * k, f.step);
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
    modeSel.options[1].text = s.terrain.heightmap ? t('ハイトマップ（{name}）', { name: s.terrain.heightmap.name }) : t('ハイトマップ（未読込）');
    const seed = this.bindings.find((b) => b.f.path === 'terrain.noise.seed');
    seed.el.closest('.row').classList.toggle('dim', !noise);
    for (const b of this.bindings) {
      if (b.f.path.startsWith('water.') && b.f.path !== 'water.enabled') b.el.closest('.row').classList.toggle('dim', !s.water.enabled);
    }
  }
}

// 有効数字 n 桁に丸める（対数の目盛りで中途半端な値にしない）
function roundSig(v, n) {
  if (!(v > 0)) return v;
  const p = 10 ** (Math.floor(Math.log10(v)) - n + 1);
  return Math.round(v / p) * p;
}

function round(v, step) {
  const d = String(step).includes('.') ? String(step).split('.')[1].length : 0;
  return Number(v).toFixed(d);
}
