import { t } from '../i18n/index.js';
import { ELEVATION_ATTRIBUTION } from '../core/geo.js';
import { importSizeFor, IMAGERY_ATTRIBUTION, LIGHTS_ATTRIBUTION } from '../core/globe.js';

// 地球モードの画面：地球全体を眺め、地名で飛び、気に入った所を景観として取り込む。
// 描く本体（GlobeRenderer）は初めて開いたときに読み込む。視点は自動保存（シーンには入れない：実在の地球を眺める道具なので）
const NOMINATIM = 'https://nominatim.openstreetmap.org';
const SAVE_KEY = 'kuniumi.globe.view';

export class GlobeMode {
  // onImport({ lat, lon, size, name }): 「ここを取り込む」。onClose(): 戻る
  // onWalkHere({ lat, lon, size, heading, name }): 「ここに降りて歩く」
  constructor(stage, { onImport, onWalkHere, onClose, getSun, toast }) {
    this.stage = stage;
    this.onImport = onImport;
    this.onWalkHere = onWalkHere;
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
        const v = this.linkView ?? JSON.parse(localStorage.getItem(SAVE_KEY) || 'null');
        if (v && Number.isFinite(v.lat)) Object.assign(this.renderer.view, v);
      } catch {}
      this.linkView = null;
      this.renderer.setSunMode(this.sunSel.value);
      this.renderer.setExaggeration(Number(this.exagSel.value));
      this.renderer.setImagery(this.colorSel.value === 'photo');
      this.#applyClouds();
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
              <option value="lapse">${t('早送り（1 日を 40 秒で）')}</option>
            </select>
          </label>
          <label>${t('地表の色')}
            <select data-color>
              <option value="photo">${t('衛星写真')}</option>
              <option value="height">${t('標高と緯度から')}</option>
            </select>
          </label>
          <label>${t('雲')}
            <select data-clouds>
              <option value="today">${t('きのうの実際の雲（衛星）')}</option>
              <option value="procedural">${t('手続きの雲')}</option>
              <option value="none">${t('なし')}</option>
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
          <button type="button" data-share title="${t('いま見ている所を開くリンクをコピー')}">🔗</button>
          <button type="button" data-fav title="${t('いま見ている所をお気に入りに（検索の欄をたたくと一覧）')}">☆</button>
          <button type="button" data-home title="${t('地球全体を見渡す')}">🌏 ${t('全体')}</button>
          <button type="button" data-walk title="${t('いま見ている所を取り込んで、地上に降りて歩く')}">🚶 ${t('ここに降りて歩く')}</button>
          <button type="button" class="primary" data-import title="${t('いま見ている辺りを、細かい景観として取り込む（歩く・一枚絵ができる）')}">⤓ ${t('ここを景観に取り込む')}</button>
          <button type="button" data-close title="${t('景観の画面へ戻る（Esc）')}">✕ ${t('戻る')}</button>
        </div>
      </div>
      <div class="globe-side">
        <button type="button" class="globe-compass" data-north title="${t('北を上に')}" aria-label="${t('北を上に')}"><span>N</span></button>
        <button type="button" data-zoomin title="${t('寄る')}" aria-label="${t('寄る')}">＋</button>
        <button type="button" data-zoomout title="${t('離れる')}" aria-label="${t('離れる')}">－</button>
        <button type="button" data-here title="${t('いまいる場所へ')}" aria-label="${t('いまいる場所へ')}">◎</button>
      </div>
      <div class="globe-info"></div>
      <div class="globe-hint">${matchMedia('(pointer: coarse)').matches ? t('1 本指で移動・2 本指でつまんで寄る／ひねって向き／上下で傾き・2 回たたいてそこへ寄る') : t('ドラッグで移動・ホイールで寄る（カーソルの先へ）・右ドラッグで向きと傾き・ダブルクリックでそこへ寄る・W/A/S/D・Q/E・R/F')}</div>
      <div class="globe-credit">${t('標高')}: ${ELEVATION_ATTRIBUTION} ・ ${t('地表の色')}: ${IMAGERY_ATTRIBUTION} ・ ${t('夜の明かり')}: ${LIGHTS_ATTRIBUTION} ・ ${t('地名')}: © OpenStreetMap</div>`;
    this.stage.appendChild(el);
    this.el = el;
    this.info = el.querySelector('.globe-info');
    this.q = el.querySelector('input');
    this.results = el.querySelector('.globe-results');
    this.sunSel = el.querySelector('[data-sun]');
    this.exagSel = el.querySelector('[data-exag]');
    this.colorSel = el.querySelector('[data-color]');
    this.cloudsCb = el.querySelector('[data-clouds]');
    this.cloudsCb.onchange = () => this.#applyClouds();
    this.colorSel.onchange = () => this.renderer?.setImagery(this.colorSel.value === 'photo');
    el.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      this.#search();
    });
    this.sunSel.onchange = () => this.renderer?.setSunMode(this.sunSel.value);
    this.exagSel.onchange = () => this.renderer?.setExaggeration(Number(this.exagSel.value));
    el.querySelector('[data-fav]').onclick = () => this.#addFavorite();
    el.querySelector('[data-share]').onclick = () => this.#share();
    // 検索の欄をたたいたら（空のとき）お気に入りの一覧
    for (const ev of ['focus', 'click']) this.q.addEventListener(ev, () => !this.q.value.trim() && this.#showFavorites());
    el.querySelector('[data-home]').onclick = () => this.renderer?.flyTo({ lat: this.renderer.view.lat, lon: this.renderer.view.lon, range: 2.2e7, tilt: 0 });
    el.querySelector('[data-close]').onclick = () => this.close();
    el.querySelector('[data-import]').onclick = () => this.#import();
    el.querySelector('[data-walk]').onclick = () => this.#walkHere();
    el.querySelector('[data-north]').onclick = () => this.renderer?.northUp();
    el.querySelector('[data-zoomin]').onclick = () => this.renderer?.zoomBy(0.5);
    el.querySelector('[data-zoomout]').onclick = () => this.renderer?.zoomBy(2);
    el.querySelector('[data-here]').onclick = () => this.#gotoHere();
    this.compass = el.querySelector('.globe-compass span');
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

  // ---- リンク（#globe=緯度,経度,距離,向き,傾き） ----
  static viewFromHash(hash = location.hash) {
    const m = /globe=([-\d.]+),([-\d.]+),([\d.]+),([-\d.]+),([-\d.]+)/.exec(hash);
    if (!m) return null;
    const [lat, lon, range, heading, tilt] = m.slice(1).map(Number);
    if (![lat, lon, range, heading, tilt].every(Number.isFinite)) return null;
    return { lat: Math.max(-89.5, Math.min(89.5, lat)), lon, range: Math.max(60, Math.min(6e7, range)), heading, tilt: Math.max(0, Math.min(86, tilt)) };
  }

  async #share() {
    const v = this.renderer?.view;
    if (!v) return;
    const f = (x, d) => Number(x.toFixed(d));
    const url = `${location.origin}${location.pathname}#globe=${f(v.lat, 5)},${f(((v.lon + 540) % 360) - 180, 5)},${Math.round(v.range)},${f(v.heading, 1)},${f(v.tilt, 1)}`;
    try {
      await navigator.clipboard.writeText(url);
      this.toast?.(t('リンクをコピーしました'));
    } catch {
      this.toast?.(url);
    }
  }

  // ---- お気に入り（このブラウザに残す） ----
  #favorites() {
    try {
      return JSON.parse(localStorage.getItem('kuniumi.globe.favorites') || '[]');
    } catch {
      return [];
    }
  }

  #saveFavorites(list) {
    try {
      localStorage.setItem('kuniumi.globe.favorites', JSON.stringify(list.slice(0, 50)));
    } catch {}
  }

  async #addFavorite() {
    const v = this.renderer?.view;
    if (!v) return;
    const name = this.place && this.placeFor && Math.abs(this.placeFor.lat - v.lat) < 1e-6 ? this.place.split('、')[0] : await this.#placeName(v.lat, v.lon, v.range);
    const list = this.#favorites().filter((f) => f.name !== name);
    list.unshift({ name, lat: v.lat, lon: v.lon, range: v.range, heading: v.heading, tilt: v.tilt });
    this.#saveFavorites(list);
    this.toast?.(t('お気に入りに入れました：{name}', { name }));
  }

  #showFavorites() {
    const list = this.#favorites();
    if (!list.length) return;
    this.results.hidden = false;
    this.results.textContent = '';
    const head = document.createElement('div');
    head.className = 'globe-fav-head';
    head.textContent = t('お気に入り');
    this.results.appendChild(head);
    for (const f of list) {
      const row = document.createElement('div');
      row.className = 'globe-fav';
      const go = document.createElement('button');
      go.type = 'button';
      go.textContent = `☆ ${f.name}`;
      go.onclick = () => {
        this.results.hidden = true;
        this.renderer?.flyTo({ lat: f.lat, lon: f.lon, range: f.range, heading: f.heading, tilt: f.tilt });
      };
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'globe-fav-del';
      del.textContent = '×';
      del.title = t('お気に入りから外す');
      del.onclick = () => {
        this.#saveFavorites(this.#favorites().filter((x) => !(x.name === f.name && x.lat === f.lat)));
        row.remove();
      };
      row.append(go, del);
      this.results.appendChild(row);
    }
  }

  // 端末の位置情報で、いまいる場所へ飛ぶ（許可を求められる）
  #gotoHere() {
    if (!navigator.geolocation) return this.toast?.(t('この端末では位置情報を使えません'), 'error');
    navigator.geolocation.getCurrentPosition(
      (p) => this.renderer?.flyTo({ lat: p.coords.latitude, lon: p.coords.longitude, range: 20000, tilt: 45 }),
      (err) => this.toast?.(t('位置情報を取得できませんでした: {msg}', { msg: err.message }), 'error'),
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 600000 },
    );
  }

  // 見ている所を 12 km 四方ほど取り込んで、その場所の地上で歩き始める（向きは地球モードの向き）
  async #walkHere() {
    const v = this.renderer?.view;
    if (!v) return;
    const name = await this.#placeName(v.lat, v.lon, 12000);
    this.close();
    this.onWalkHere?.({ lat: v.lat, lon: v.lon, size: 12000, heading: v.heading, name });
  }

  async #placeName(lat, lon, size) {
    let name = null;
    try {
      const zoom = size > 1000e3 ? 3 : size > 200e3 ? 5 : size > 40e3 ? 8 : 10;
      const r = await fetch(`${NOMINATIM}/reverse?format=jsonv2&zoom=${zoom}&accept-language=${encodeURIComponent(navigator.language || 'ja')}&lat=${lat}&lon=${lon}`, {
        headers: { Accept: 'application/json' },
      });
      if (r.ok) {
        const j = await r.json();
        name = j.name || j.display_name?.split(',')[0] || null;
      }
    } catch {}
    return name || `${lat.toFixed(2)}°, ${lon.toFixed(2)}°`;
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

  async #applyClouds() {
    const mode = this.cloudsCb.value;
    const ok = await this.renderer?.setClouds(mode);
    if (mode === 'today' && ok === false) {
      this.toast?.(t('実際の雲を取り寄せられませんでした。手続きの雲にします'));
      this.cloudsCb.value = 'procedural';
      this.renderer?.setClouds('procedural');
    }
  }

  #showInfo(i) {
    if (this.compass) this.compass.parentElement.style.transform = `rotate(${-i.heading}deg)`;
    const fmt = (x, p, n) => `${Math.abs(x).toFixed(3)}°${x >= 0 ? p : n}`;
    const alt = i.alt >= 10000 ? `${(i.alt / 1000).toFixed(i.alt >= 1e5 ? 0 : 1)} km` : `${Math.round(i.alt)} m`;
    const ground = i.ground < 0 ? t('水深 {d} m', { d: Math.round(-i.ground) }) : t('標高 {h} m', { h: Math.round(i.ground) });
    const place = this.place && this.placeFor && Math.abs(this.placeFor.lat - i.lat) < 1e-6 && Math.abs(this.placeFor.lon - i.lon) < 1e-6 ? `${this.place} ・ ` : '';
    // 太陽が実際の日時のとき：見ている所の太陽の時刻（経度から。日の出・日の入りの目安）
    let clock = '';
    if (i.sunDate) {
      const h = (((i.sunDate.getUTCHours() + i.sunDate.getUTCMinutes() / 60 + i.lon / 15) % 24) + 24) % 24;
      clock = ` ・ ${t('現地の太陽時')} ${String(Math.floor(h)).padStart(2, '0')}:${String(Math.floor((h % 1) * 60)).padStart(2, '0')}`;
    }
    this.info.textContent = `${place}${fmt(i.lat, 'N', 'S')}  ${fmt(i.lon, 'E', 'W')}  ・ ${ground} ・ ${t('高度')} ${alt}${clock}` + (i.loading ? ` ・ ${t('取り寄せ中')}…` : '');
    this.#watchPlace(i);
  }

  // 見ている所の地名：動かすのを止めて 1.2 秒たったら逆引きする（OpenStreetMap の Nominatim。1 秒に 1 回までの約束を守る）
  #watchPlace(i) {
    const key = `${i.lat.toFixed(6)},${i.lon.toFixed(6)},${Math.round(Math.log2(i.range))}`;
    if (key === this.placeKey) return;
    this.placeKey = key;
    clearTimeout(this.placeTimer);
    if (i.range > 3e6) return (this.place = null); // 宇宙から地球全体を見ているときは出さない
    this.placeTimer = setTimeout(async () => {
      const zoom = i.range > 1e6 ? 3 : i.range > 2e5 ? 5 : i.range > 4e4 ? 8 : i.range > 8e3 ? 10 : 14;
      try {
        const r = await fetch(`${NOMINATIM}/reverse?format=jsonv2&zoom=${zoom}&accept-language=${encodeURIComponent(navigator.language || 'ja')}&lat=${i.lat}&lon=${i.lon}`, {
          headers: { Accept: 'application/json' },
        });
        if (!r.ok || this.placeKey !== key) return;
        const j = await r.json();
        const a = j.address ?? {};
        // 細かすぎず粗すぎない名前（市区町村と都道府県・国）
        const parts = [j.name, a.city || a.town || a.village || a.county, a.state || a.province, a.country].filter(Boolean);
        this.place = [...new Set(parts)].slice(0, 3).join('、') || null;
        this.placeFor = { lat: i.lat, lon: i.lon };
      } catch {}
    }, 1200);
  }
}
