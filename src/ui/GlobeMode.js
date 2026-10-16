import { t } from '../i18n/index.js';
import { ELEVATION_ATTRIBUTION } from '../core/geo.js';
import { importSizeFor, IMAGERY_ATTRIBUTION } from '../core/globe.js';

// 地球モードの画面：地球全体を眺め、地名で飛び、気に入った所を景観として取り込む。
// 描く本体（GlobeRenderer）は初めて開いたときに読み込む。視点は自動保存（シーンには入れない：実在の地球を眺める道具なので）
const NOMINATIM = 'https://nominatim.openstreetmap.org';
const SAVE_KEY = 'kuniumi.globe.view';

export class GlobeMode {
  // onImport({ lat, lon, size, name }): 「ここを取り込む」。onClose(): 戻る
  constructor(stage, { onImport, onClose, getSun, toast }) {
    this.stage = stage;
    this.onImport = onImport;
    this.onClose = onClose;
    this.getSun = getSun;
    this.toast = toast;
    this.renderer = null;
    this.#build();
  }

  get isOpen() {
    return !this.el.hidden;
  }

  async open() {
    this.el.hidden = false;
    if (!this.renderer) {
      this.info.textContent = t('地球を用意しています…');
      const { GlobeRenderer } = await import('../render/GlobeRenderer.js');
      this.renderer = new GlobeRenderer(this.el, { onInfo: (i) => this.#showInfo(i) });
      if (import.meta.env?.DEV) window.__globe = this.renderer; // 開発中の確かめ用
      try {
        const v = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null');
        if (v && Number.isFinite(v.lat)) Object.assign(this.renderer.view, v);
      } catch {}
      this.renderer.sunMode = this.sunSel.value;
      this.renderer.setExaggeration(Number(this.exagSel.value));
      this.renderer.setImagery(this.colorSel.value === 'photo');
    }
    this.renderer.sceneSun = this.getSun();
    this.renderer.start();
    this.q.blur();
  }

  close() {
    if (!this.renderer) return (this.el.hidden = true);
    this.renderer.stop();
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(this.renderer.view));
    } catch {}
    this.el.hidden = true;
    this.onClose?.();
  }

  // キー操作（main.js から）。地球モードで使ったら true
  key(e, down) {
    if (!this.isOpen || !this.renderer) return false;
    if (down && e.key === 'Escape') {
      if (!this.results.hidden) this.results.hidden = true;
      else this.close();
      return true;
    }
    return this.renderer.onKey(e, down);
  }

  #build() {
    const el = document.createElement('div');
    el.className = 'globe';
    el.hidden = true;
    el.innerHTML = `
      <div class="globe-top">
        <form class="globe-search">
          <input type="search" placeholder="${t('地名で飛ぶ（例：富士山、グランドキャニオン）')}" aria-label="${t('地名で飛ぶ')}" />
          <button type="submit">${t('飛ぶ')}</button>
        </form>
        <div class="globe-results" hidden></div>
        <div class="globe-tools">
          <label>${t('太陽')}
            <select data-sun>
              <option value="follow">${t('シーンの太陽（見ている所の時刻）')}</option>
              <option value="real">${t('いまの実際の太陽')}</option>
            </select>
          </label>
          <label>${t('地表の色')}
            <select data-color>
              <option value="photo">${t('衛星写真')}</option>
              <option value="height">${t('標高と緯度から')}</option>
            </select>
          </label>
          <label>${t('高さ')}
            <select data-exag>
              <option value="1">×1</option>
              <option value="2">×2</option>
              <option value="4">×4</option>
              <option value="10">×10</option>
            </select>
          </label>
          <button type="button" data-home title="${t('地球全体を見渡す')}">🌏 ${t('全体')}</button>
          <button type="button" class="primary" data-import title="${t('いま見ている辺りを、細かい景観として取り込む（歩く・一枚絵ができる）')}">⤓ ${t('ここを景観に取り込む')}</button>
          <button type="button" data-close title="${t('景観の画面へ戻る（Esc）')}">✕ ${t('戻る')}</button>
        </div>
      </div>
      <div class="globe-info"></div>
      <div class="globe-hint">${t('ドラッグで移動・ホイールで寄る（カーソルの先へ）・右ドラッグで向きと傾き・ダブルクリックでそこへ寄る・W/A/S/D・Q/E・R/F')}</div>
      <div class="globe-credit">${t('標高')}: ${ELEVATION_ATTRIBUTION} ・ ${t('地表の色')}: ${IMAGERY_ATTRIBUTION} ・ ${t('地名')}: © OpenStreetMap</div>`;
    this.stage.appendChild(el);
    this.el = el;
    this.info = el.querySelector('.globe-info');
    this.q = el.querySelector('input');
    this.results = el.querySelector('.globe-results');
    this.sunSel = el.querySelector('[data-sun]');
    this.exagSel = el.querySelector('[data-exag]');
    this.colorSel = el.querySelector('[data-color]');
    this.colorSel.onchange = () => this.renderer?.setImagery(this.colorSel.value === 'photo');
    el.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      this.#search();
    });
    this.sunSel.onchange = () => this.renderer && (this.renderer.sunMode = this.sunSel.value);
    this.exagSel.onchange = () => this.renderer?.setExaggeration(Number(this.exagSel.value));
    el.querySelector('[data-home]').onclick = () => this.renderer?.flyTo({ lat: this.renderer.view.lat, lon: this.renderer.view.lon, range: 2.2e7, tilt: 0 });
    el.querySelector('[data-close]').onclick = () => this.close();
    el.querySelector('[data-import]').onclick = () => this.#import();
  }

  async #search() {
    const q = this.q.value.trim();
    if (!q) return;
    this.results.hidden = false;
    this.results.textContent = t('探しています…');
    try {
      const url = `${NOMINATIM}/search?format=jsonv2&limit=6&accept-language=${encodeURIComponent(navigator.language || 'ja')}&q=${encodeURIComponent(q)}`;
      const r = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const list = await r.json();
      this.results.textContent = '';
      if (!list.length) return (this.results.textContent = t('見つかりませんでした'));
      for (const it of list) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = it.display_name;
        b.onclick = () => {
          this.results.hidden = true;
          const [s, n, w, e] = it.boundingbox.map(Number);
          // 外枠が収まる距離から（点しかない山などは 30 km）
          const span = Math.max(Math.abs(n - s), Math.abs(e - w) * Math.cos((Number(it.lat) * Math.PI) / 180)) * 111e3;
          const range = Math.min(2.2e7, Math.max(30e3, span * 1.8));
          this.renderer?.flyTo({ lat: Number(it.lat), lon: Number(it.lon), range, tilt: range < 300e3 ? 50 : 0 });
          this.place = it.name || it.display_name.split(',')[0];
        };
        this.results.appendChild(b);
      }
    } catch (err) {
      this.results.textContent = t('地名を検索できませんでした: {msg}', { msg: err.message ?? err });
    }
  }

  async #import() {
    const v = this.renderer?.view;
    if (!v) return;
    const size = importSizeFor(v.range);
    let name = null;
    try {
      // その辺りの地名（逆引き。広さに合わせて細かさを変える）
      const zoom = size > 1000e3 ? 3 : size > 200e3 ? 5 : size > 40e3 ? 8 : 10;
      const r = await fetch(`${NOMINATIM}/reverse?format=jsonv2&zoom=${zoom}&accept-language=${encodeURIComponent(navigator.language || 'ja')}&lat=${v.lat}&lon=${v.lon}`, {
        headers: { Accept: 'application/json' },
      });
      if (r.ok) {
        const j = await r.json();
        name = j.name || j.display_name?.split(',')[0] || null;
      }
    } catch {}
    name ||= `${v.lat.toFixed(2)}°, ${v.lon.toFixed(2)}°`;
    this.close();
    this.onImport({ lat: v.lat, lon: v.lon, size, name });
  }

  #showInfo(i) {
    const fmt = (x, p, n) => `${Math.abs(x).toFixed(3)}°${x >= 0 ? p : n}`;
    const alt = i.alt >= 10000 ? `${(i.alt / 1000).toFixed(i.alt >= 1e5 ? 0 : 1)} km` : `${Math.round(i.alt)} m`;
    const ground = i.ground < 0 ? t('水深 {d} m', { d: Math.round(-i.ground) }) : t('標高 {h} m', { h: Math.round(i.ground) });
    this.info.textContent = `${fmt(i.lat, 'N', 'S')}  ${fmt(i.lon, 'E', 'W')}  ・ ${ground} ・ ${t('高度')} ${alt}` + (i.loading ? ` ・ ${t('取り寄せ中')}…` : '');
  }
}
