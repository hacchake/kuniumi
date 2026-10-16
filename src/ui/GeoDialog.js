import { t } from '../i18n/index.js';
import { GEO_PRESETS, ELEVATION_ATTRIBUTION, EARTH_R, aeqdInverse, sizeFromBBox, chooseZoom, tilesFor, fillSeaFloor, featherToSurround } from '../core/geo.js';
import { fieldToHeightmap } from '../io/heightmap.js';
import { SIZE_MAX } from '../core/schema.js';

// 「地球の地形を取り込む」ダイアログ。
// 地名検索（OpenStreetMap の Nominatim）か、ひな形・緯度経度で範囲を決め、
// 公開されている標高タイルから高さ場を作って、ハイトマップ地形としてシーンに入れる。
// 地図の下見：範囲の周り（2.2 倍）を粗く取り寄せて陰影付きで描く。ドラッグで移動、ホイールで範囲の大きさ。

const VIEW = 2.2; // 下見の地図に映す広さ（範囲の何倍）
const MAP = 360; // 下見の地図の画素数
const SIZE_MIN_KM = 5;
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const SURROUND_RES = 2049; // 周りの地形の格子（近づいても粗さが目立ちにくいよう 2049）

export class GeoDialog {
  // apply(result): 取り込んだ結果をシーンへ（main.js が渡す）
  constructor({ apply, toast }) {
    this.apply = apply;
    this.toast = toast;
    this.region = { lat: 36.0, lon: 137.0, size: 3000e3 };
    this.res = 4097;
    this.name = t('日本列島');
    this.worker = null;
    this.seq = 0;
    this.pending = new Map();
    this.busy = false;
    this.#build();
  }

  get isOpen() {
    return !this.el.hidden;
  }

  open() {
    this.el.hidden = false;
    this.#syncInputs();
    this.#preview();
    this.q.focus();
  }

  // 範囲を決めた状態で開く（地球モードの「ここを取り込む」から）
  openAt(region, name) {
    this.region = { lat: clamp(region.lat, -85, 85), lon: region.lon, size: Math.min(SIZE_MAX, region.size) };
    this.res = this.region.size > 800e3 ? 4097 : 2049;
    this.name = name;
    this.open();
  }

  close() {
    if (this.busy) return;
    this.el.hidden = true;
  }

  // ---- 計算はワーカーで ----
  #run(region, res, maxTiles, onProgress) {
    if (!this.worker) {
      this.worker = new Worker(new URL('../workers/geoWorker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e) => {
        const m = e.data;
        const p = this.pending.get(m.id);
        if (!p) return;
        if (m.progress) return p.onProgress?.(m.progress);
        this.pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error));
        else p.resolve(m);
      };
    }
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      this.worker.postMessage({ id, region, res, maxTiles });
    });
  }

  // 範囲を取り込んでシーンへ。ダイアログを開かずに（自動保存からの復元など）呼んでもよい
  async importRegion(region, res, name, { quiet = false, restore = false } = {}) {
    this.busy = true;
    this.#setBusy(true);
    try {
      const r = await this.#run(region, res, res >= 4097 ? 600 : 400, (p) => this.#progress(p));
      // 周りの地形：範囲の外も実際の地形が続いて見えるよう、6 倍の広さを粗く取り寄せる（地球の半周まで）
      const outerSize = Math.min(Math.PI * EARTH_R * 0.9, Math.max(region.size * 6, region.size + 400e3));
      let o = null;
      if (outerSize > region.size * 1.3) o = await this.#run({ ...region, size: outerSize }, SURROUND_RES, 320, (p) => this.#progress(p, true));
      // 沿岸の海底の深さを周りの地形で補う
      // 縁は周りの地形の高さへ寄せる（境目に段差を作らない）
      const heights = o
        ? featherToSurround(fillSeaFloor(r.heights, res, region.size, o.heights, SURROUND_RES, outerSize), res, region.size, o.heights, SURROUND_RES, outerSize)
        : r.heights;
      let min = Infinity, max = -Infinity;
      for (const h of heights) {
        if (h < min) min = h;
        if (h > max) max = h;
      }
      const span = Math.max(1, max - min);
      const field = new Float32Array(heights.length);
      for (let k = 0; k < field.length; k++) field[k] = (heights[k] - min) / span;
      this.#progressText(t('地形をまとめています…'));
      const hm = await fieldToHeightmap(field, res, `${name}.png`);
      hm.geo = { lat: region.lat, lon: region.lon, size: region.size, res, zoom: r.zoom, name, source: ELEVATION_ATTRIBUTION };
      if (o) {
        const ospan = Math.max(1, o.max - o.min);
        const of = new Float32Array(o.heights.length);
        for (let k = 0; k < of.length; k++) of[k] = (o.heights[k] - o.min) / ospan;
        const shm = await fieldToHeightmap(of, SURROUND_RES, `${name}_surround.png`);
        hm.surround = { png: shm.png, res: SURROUND_RES, size: outerSize, min: o.min, max: o.max };
      }
      this.apply({ heightmap: hm, region, res, min, max, name }, { restore });
      if (!quiet) this.toast(t('{name} の地形を取り込みました（{km} km 四方・{res}×{res}・タイル {n} 枚）', { name, km: Math.round(region.size / 1000), res, n: r.tiles }));
      this.busy = false;
      this.close();
    } catch (err) {
      this.toast(t('標高データを取り込めませんでした: {msg}', { msg: err.message ?? err }), 'error');
    } finally {
      this.busy = false;
      this.#setBusy(false);
    }
  }

  // ---- 画面 ----
  #build() {
    const el = document.createElement('div');
    el.className = 'modal geo-modal';
    el.hidden = true;
    el.innerHTML = `
      <div class="modal-box geo-box" role="dialog" aria-label="地球の地形を取り込む">
        <div class="still-head">
          <span class="still-title">地球の地形を取り込む</span>
          <span class="geo-sub">地名や緯度経度で範囲を選ぶと、公開されている標高データ（海底も）から大地を作ります</span>
          <button type="button" data-close>閉じる</button>
        </div>
        <div class="geo-body">
          <div class="geo-mapwrap">
            <canvas class="geo-map" width="${MAP}" height="${MAP}"></canvas>
            <div class="geo-maphint">ドラッグで移動・ホイールで範囲の大きさ</div>
          </div>
          <div class="geo-form">
            <label class="geo-row geo-search"><span>地名で探す</span><input type="search" class="geo-q" placeholder="例：富士山、屋久島、Alps" /><button type="button" class="geo-go">検索</button></label>
            <div class="geo-results" hidden></div>
            <label class="geo-row"><span>ひな形</span><select class="geo-preset"></select></label>
            <label class="geo-row"><span>中心の緯度</span><input type="number" class="geo-lat" step="0.01" min="-85" max="85" /><em>°</em></label>
            <label class="geo-row"><span>中心の経度</span><input type="number" class="geo-lon" step="0.01" min="-180" max="180" /><em>°</em></label>
            <label class="geo-row"><span>範囲（一辺）</span><input type="number" class="geo-size" step="1" min="${SIZE_MIN_KM}" max="${SIZE_MAX / 1000}" /><em>km</em></label>
            <label class="geo-row"><span>細かさ</span><select class="geo-res">
              <option value="1025">1025 × 1025（軽い）</option>
              <option value="2049">2049 × 2049</option>
              <option value="4097">4097 × 4097（大陸向け・重い）</option>
            </select></label>
            <div class="geo-info"></div>
            <div class="geo-actions"><button type="button" class="geo-import primary">取り込む</button></div>
            <div class="geo-progress" hidden><div class="geo-bar"><i></i></div><span class="geo-ptext"></span></div>
            <p class="geo-credit">標高データ：${ELEVATION_ATTRIBUTION}<br />地名検索：© OpenStreetMap contributors（Nominatim）</p>
          </div>
        </div>
      </div>`;
    document.body.appendChild(el);
    this.el = el;
    const $ = (s) => el.querySelector(s);
    this.canvas = $('.geo-map');
    this.q = $('.geo-q');
    this.results = $('.geo-results');
    this.lat = $('.geo-lat');
    this.lon = $('.geo-lon');
    this.size = $('.geo-size');
    this.resSel = $('.geo-res');
    this.info = $('.geo-info');
    this.importBtn = $('.geo-import');
    this.prog = $('.geo-progress');
    this.bar = $('.geo-bar i');
    this.ptext = $('.geo-ptext');

    el.addEventListener('click', (e) => {
      if (e.target === el || (e.target instanceof Element && e.target.closest('[data-close]'))) this.close();
    });
    const presetSel = $('.geo-preset');
    presetSel.add(new Option(t('— 選ぶ —'), ''));
    GEO_PRESETS.forEach((p, i) => presetSel.add(new Option(t(p.name), String(i))));
    presetSel.onchange = () => {
      const p = GEO_PRESETS[Number(presetSel.value)];
      if (!p) return;
      this.region = { lat: p.lat, lon: p.lon, size: p.size * 1000 };
      this.res = p.res;
      this.name = t(p.name);
      this.#syncInputs();
      this.#preview();
    };
    const onEdit = () => {
      const lat = Number(this.lat.value), lon = Number(this.lon.value), km = Number(this.size.value);
      if (![lat, lon, km].every(Number.isFinite)) return;
      this.region = { lat: clamp(lat, -85, 85), lon: wrapLon(lon), size: clamp(km, SIZE_MIN_KM, SIZE_MAX / 1000) * 1000 };
      this.name = t('{lat}°, {lon}°', { lat: this.region.lat.toFixed(2), lon: this.region.lon.toFixed(2) });
      presetSel.value = '';
      this.#syncInfo();
      this.#preview();
    };
    for (const i of [this.lat, this.lon, this.size]) i.addEventListener('change', onEdit);
    this.resSel.onchange = () => {
      this.res = Number(this.resSel.value);
      this.#syncInfo();
    };
    $('.geo-go').onclick = () => this.#search();
    this.q.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.#search();
      }
    });
    this.importBtn.onclick = () => this.importRegion({ ...this.region }, this.res, this.name);
    this.#mapControls();
  }

  #syncInputs() {
    this.lat.value = this.region.lat.toFixed(3);
    this.lon.value = this.region.lon.toFixed(3);
    this.size.value = Math.round(this.region.size / 1000);
    this.resSel.value = String(this.res);
    this.#syncInfo();
  }

  #syncInfo() {
    const z = chooseZoom(this.region, this.res, this.res >= 4097 ? 600 : 400);
    const n = tilesFor(this.region, z).length;
    const cell = this.region.size / (this.res - 1);
    const native = (2 * Math.PI * EARTH_R * Math.cos((this.region.lat * Math.PI) / 180)) / (256 * 2 ** z);
    this.info.textContent = t('格子の間隔 約 {cell}・元データの細かさ 約 {src}・タイル {n} 枚', {
      cell: fmtLen(cell),
      src: fmtLen(native),
      n,
    });
  }

  #setBusy(b) {
    this.importBtn.disabled = b;
    this.prog.hidden = !b;
    if (b) this.#progressText(t('準備しています…'));
  }

  #progress(p, surround = false) {
    if (surround) {
      this.bar.style.width = '100%';
      this.#progressText(t('周りの地形を取り寄せています… {done} / {total}', { done: p.phase === 'fetch' ? p.done : p.total, total: p.total }));
      return;
    }
    if (p.phase === 'fetch') {
      this.bar.style.width = `${(p.done / Math.max(1, p.total)) * 70}%`;
      this.#progressText(t('標高タイルを取り寄せています… {done} / {total}（ズーム {z}）', { done: p.done, total: p.total, z: p.zoom }));
    } else {
      this.bar.style.width = `${70 + (p.done / Math.max(1, p.total)) * 30}%`;
      this.#progressText(t('地形を組み立てています… {pct}%', { pct: Math.round((p.done / Math.max(1, p.total)) * 100) }));
    }
  }

  #progressText(s) {
    this.ptext.textContent = s;
  }

  // ---- 地名検索 ----
  async #search() {
    const q = this.q.value.trim();
    if (!q) return;
    this.results.hidden = false;
    this.results.textContent = t('探しています…');
    try {
      const url = `${NOMINATIM}?format=jsonv2&limit=6&accept-language=${encodeURIComponent(navigator.language || 'ja')}&q=${encodeURIComponent(q)}`;
      const r = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const list = await r.json();
      this.results.textContent = '';
      if (!list.length) {
        this.results.textContent = t('見つかりませんでした');
        return;
      }
      for (const it of list) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = it.display_name;
        b.onclick = () => {
          const [s, n, w, e] = it.boundingbox.map(Number);
          // 外枠の 1.3 倍（点しかない山などは 40 km 四方）
          const size = Math.max(40e3, sizeFromBBox(s, n, w, e) * 1.3);
          this.region = { lat: clamp(Number(it.lat), -85, 85), lon: Number(it.lon), size: Math.min(SIZE_MAX, size) };
          this.res = this.region.size > 800e3 ? 4097 : 2049;
          this.name = it.name || it.display_name.split(',')[0];
          this.results.hidden = true;
          this.#syncInputs();
          this.#preview();
        };
        this.results.appendChild(b);
      }
    } catch (err) {
      this.results.textContent = t('地名を検索できませんでした: {msg}', { msg: err.message ?? err });
    }
  }

  // ---- 下見の地図 ----
  #mapControls() {
    const c = this.canvas;
    let drag = null;
    c.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY, dx: 0, dy: 0 };
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', (e) => {
      if (!drag) return;
      drag.dx = e.clientX - drag.x;
      drag.dy = e.clientY - drag.y;
      this.#draw(drag.dx, drag.dy);
    });
    const end = () => {
      if (!drag) return;
      const { dx, dy } = drag;
      drag = null;
      if (Math.hypot(dx, dy) < 2) return;
      const rect = c.getBoundingClientRect();
      const mPerPx = (this.region.size * VIEW) / rect.width;
      const p = aeqdInverse(-dx * mPerPx, dy * mPerPx, this.region.lat, this.region.lon);
      this.region = { ...this.region, lat: clamp(p.lat, -85, 85), lon: p.lon };
      this.name = t('{lat}°, {lon}°', { lat: this.region.lat.toFixed(2), lon: this.region.lon.toFixed(2) });
      this.#syncInputs();
      this.#preview();
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    let wheelTimer = 0;
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const k = Math.exp(Math.sign(e.deltaY) * 0.12);
        this.region = { ...this.region, size: clamp(this.region.size * k, SIZE_MIN_KM * 1000, SIZE_MAX) };
        this.#syncInputs();
        this.#draw(0, 0, k);
        clearTimeout(wheelTimer);
        wheelTimer = setTimeout(() => this.#preview(), 350);
      },
      { passive: false },
    );
  }

  async #preview() {
    const ticket = (this.previewTicket = (this.previewTicket ?? 0) + 1);
    const region = { ...this.region, size: this.region.size * VIEW };
    try {
      const r = await this.#run(region, 181, 36);
      if (ticket !== this.previewTicket) return;
      this.previewImg = shadeMap(r.heights, 181);
      this.previewScale = 1;
      this.#draw(0, 0);
    } catch {
      // 下見は失敗しても取り込みはできる
    }
  }

  // 下見の地図を描く（ドラッグ中は画像をずらし、ホイール中は拡大縮小して見せる）
  #draw(dx, dy, zoom = 1) {
    const ctx = this.canvas.getContext('2d');
    ctx.fillStyle = '#0b0f1a';
    ctx.fillRect(0, 0, MAP, MAP);
    if (this.previewImg) {
      this.previewScale = (this.previewScale ?? 1) / zoom;
      const s = this.previewScale;
      const rect = this.canvas.getBoundingClientRect();
      const k = MAP / Math.max(1, rect.width);
      const w = MAP * s;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.previewImg, (MAP - w) / 2 + dx * k, (MAP - w) / 2 + dy * k, w, w);
    }
    // 取り込む範囲（中央の四角）
    const r = MAP / VIEW;
    ctx.strokeStyle = '#f1d79a';
    ctx.lineWidth = 2;
    ctx.strokeRect((MAP - r) / 2, (MAP - r) / 2, r, r);
    ctx.fillStyle = 'rgba(241, 215, 154, 0.9)';
    ctx.font = '12px sans-serif';
    ctx.fillText(`${Math.round(this.region.size / 1000)} km`, (MAP - r) / 2 + 4, (MAP - r) / 2 - 6);
  }
}

// 標高 → 色（海は青、陸は緑〜茶〜白）＋ 陰影
function shadeMap(h, res) {
  const c = document.createElement('canvas');
  c.width = c.height = res;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(res, res);
  let max = 1;
  for (const v of h) if (v > max) max = v;
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const k = j * res + i;
      const v = h[k];
      const gx = h[j * res + Math.min(res - 1, i + 1)] - h[j * res + Math.max(0, i - 1)];
      const gy = h[Math.min(res - 1, j + 1) * res + i] - h[Math.max(0, j - 1) * res + i];
      const shade = Math.max(0.35, Math.min(1.25, 1 - (gx - gy) / (max * 0.08 + 200)));
      let col;
      if (v <= 0) {
        const d = Math.min(1, -v / 6000);
        col = [20 + 30 * (1 - d), 50 + 60 * (1 - d), 90 + 70 * (1 - d)];
      } else {
        const a = Math.min(1, v / Math.max(1500, max));
        col = a < 0.5 ? mix3([70, 120, 60], [150, 135, 90], a * 2) : mix3([150, 135, 90], [235, 235, 240], (a - 0.5) * 2);
        col = col.map((x) => x * shade);
      }
      img.data.set([col[0], col[1], col[2], 255], k * 4);
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

const mix3 = (a, b, t) => a.map((x, i) => x + (b[i] - x) * t);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const wrapLon = (l) => ((((l + 180) % 360) + 360) % 360) - 180;
const fmtLen = (m) => (m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km` : `${Math.round(m)} m`);
