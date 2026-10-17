import { shapeOf, MATERIAL_PRESETS, applyMaterialPreset } from '../core/objects.js';
import { PATTERNS } from '../core/texgen.js';
import { drawMaterialBall } from './materialBall.js';
import { t } from '../i18n/index.js';
import { pickFile, blobToDataURL } from '../io/files.js';

// 物体の一覧と、選んだ物体の「変形」「素材」を編集するパネル。
// 書き込みはすべて scene.objects への置き換え（store.set('objects', …)）。
const SRC = 'objpanel';
const LOG_MIN = 0, LOG_MAX = 5; // 大きさスライダー：10^0 〜 10^5 m

export class ObjectPanel {
  constructor(root, store, selection, { onDelete, onDuplicate } = {}) {
    this.store = store;
    this.selection = selection;
    this.onDelete = onDelete;
    this.onDuplicate = onDuplicate;

    this.el = document.createElement('details');
    this.el.className = 'sec sec-objects';
    this.el.open = true;
    this.el.innerHTML = `<summary><span class="sec-title">物体</span><span class="sec-sub">Objects</span><span class="obj-count"></span></summary>`;
    this.body = document.createElement('div');
    this.body.className = 'sec-body';
    this.el.appendChild(this.body);
    root.prepend(this.el);

    this.list = document.createElement('div');
    this.list.className = 'obj-list';
    this.inspector = document.createElement('div');
    this.inspector.className = 'obj-inspector';
    this.body.append(this.list, this.inspector);

    store.subscribe((s, changed, meta) => {
      if (!changed.some((p) => p === '*' || p.startsWith('objects'))) return;
      this.#renderList(s);
      if (meta.source !== SRC) this.#renderInspector(s);
      else this.#refreshPreview();
    });
    selection.subscribe(() => {
      const s = store.get();
      this.#renderList(s);
      this.#renderInspector(s);
      if (selection.get().selected) this.el.open = true;
    });
    this.#renderList(store.get());
    this.#renderInspector(store.get());
  }

  get #selected() {
    const id = this.selection.get().selected;
    return this.store.get().objects.find((o) => o.id === id) ?? null;
  }

  #update(fn) {
    const id = this.selection.get().selected;
    const objs = this.store.get().objects.map((o) => (o.id === id ? fn(o) : o));
    this.store.set('objects', objs, { source: SRC });
  }

  #renderList(s) {
    const sel = this.selection.get().selected;
    this.el.querySelector('.obj-count').textContent = s.objects.length ? `${s.objects.length}` : '';
    this.list.replaceChildren();
    if (!s.objects.length) {
      const p = document.createElement('p');
      p.className = 'obj-empty';
      p.textContent = '画面左の「創造」から形を置くと、ここに並びます。';
      this.list.appendChild(p);
      return;
    }
    for (const o of s.objects) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'obj-item' + (o.id === sel ? ' on' : '');
      b.innerHTML = `<span class="obj-glyph">${shapeOf(o.type).label.slice(0, 1)}</span><span class="obj-name"></span>${o.celestial ? '<span class="obj-tag">天体</span>' : ''}`;
      b.querySelector('.obj-name').textContent = o.name;
      b.onclick = () => this.selection.set('selected', o.id === sel ? null : o.id);
      this.list.appendChild(b);
    }
  }

  #renderInspector() {
    const o = this.#selected;
    this.inspector.replaceChildren();
    this.preview = null;
    if (!o) return;
    const add = (el) => (this.inspector.appendChild(el), el);

    // 名前と操作
    const head = add(div('obj-head'));
    const name = input('text', o.name);
    name.className = 'obj-name-input';
    name.onchange = () => this.#update((x) => ({ ...x, name: name.value || shapeOf(x.type).label }));
    const dup = button('複製', () => this.onDuplicate?.(o.id));
    const del = button('削除', () => this.onDelete?.(o.id));
    del.classList.add('danger');
    head.append(name, dup, del);

    // 変形
    add(sub('変形'));
    add(this.#vecRow('位置', o.position, 1, (v) => this.#update((x) => ({ ...x, position: v })), 'm'));
    add(this.#vecRow('回転', o.rotation, 1, (v) => this.#update((x) => ({ ...x, rotation: v })), '°'));
    add(this.#sizeRow(o));
    add(this.#vecRow('縦横奥', o.scale, 1, (v) => this.#update((x) => ({ ...x, scale: v.map((n) => Math.max(0.01, n)) })), 'm'));
    add(this.#toggleRow('天体（かすみを受けない）', o.celestial, (v) => this.#update((x) => ({ ...x, celestial: v }))));
    add(this.#toggleRow('影を落とす', o.castShadow, (v) => this.#update((x) => ({ ...x, castShadow: v }))));
    add(this.#toggleRow('水面に映す', o.reflect !== false, (v) => this.#update((x) => ({ ...x, reflect: v }))));

    // 素材
    add(sub('素材'));
    const grid = add(div('mat-grid'));
    for (const p of MATERIAL_PRESETS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'mat-swatch' + (o.material.preset === p.id ? ' on' : '');
      b.title = p.name;
      const c = document.createElement('canvas');
      c.width = c.height = 44;
      drawMaterialBall(c, { ...applyMaterialPreset(o.material, p.id) });
      const label = document.createElement('span');
      label.textContent = p.name;
      b.append(c, label);
      b.onclick = () => {
        this.#update((x) => ({ ...x, material: applyMaterialPreset(x.material, p.id) }));
        this.#renderInspector();
      };
      grid.appendChild(b);
    }

    const m = o.material;
    const prevWrap = add(div('mat-preview'));
    this.preview = document.createElement('canvas');
    this.preview.width = this.preview.height = 72;
    prevWrap.appendChild(this.preview);
    const prevNote = document.createElement('div');
    prevNote.className = 'mat-preview-note';
    prevWrap.appendChild(prevNote);
    this.previewNote = prevNote;
    this.#refreshPreview();

    const setM = (key, rerender = false) => (v) => {
      this.#update((x) => ({ ...x, material: { ...x.material, [key]: v, preset: null } }));
      if (rerender) this.#renderInspector();
    };
    add(this.#selectRow('模様', PATTERNS, m.pattern, setM('pattern', true)));
    if (m.pattern === 'image') {
      const row = add(div('row row-select'));
      row.append(label('画像'));
      const pick = button(m.image ? '別の画像…' : '画像を選ぶ…', async () => {
        const f = await pickFile('image/*');
        if (!f) return;
        setM('image', true)(await shrinkImage(f));
      });
      row.append(pick);
    } else {
      add(this.#colorRow('色 1', m.color, setM('color')));
      if (m.pattern !== 'solid') add(this.#colorRow('色 2', m.color2, setM('color2')));
      if (m.pattern === 'lava') add(this.#colorRow('発光色', m.glowColor, setM('glowColor')));
    }
    if (m.pattern !== 'solid') {
      add(this.#rangeRow('細かさ', m.scale, 1, 16, 1, setM('scale')));
      const seedRow = add(div('row row-seed'));
      seedRow.append(label('模様の種'));
      const sn = input('number', m.seed);
      sn.onchange = () => setM('seed')(Math.trunc(+sn.value) || 0);
      seedRow.append(sn, button('⟳', () => (setM('seed')(Math.floor(Math.random() * 1e5)), (sn.value = this.#selected.material.seed)), 'dice'));
    }
    add(this.#rangeRow('凹凸', m.bump, 0, 1, 0.01, setM('bump')));
    add(this.#rangeRow('粗さ', m.roughness, 0, 1, 0.01, setM('roughness')));
    add(this.#rangeRow('金属', m.metalness, 0, 1, 0.01, setM('metalness')));
    add(this.#rangeRow('発光', m.glow, 0, 10, 0.05, setM('glow')));
    add(this.#rangeRow('透け', m.transmission, 0, 1, 0.01, setM('transmission')));
  }

  #refreshPreview() {
    const o = this.#selected;
    if (!o || !this.preview) return;
    drawMaterialBall(this.preview, o.material);
    const p = MATERIAL_PRESETS.find((x) => x.id === o.material.preset);
    this.previewNote.innerHTML = `<b>${t(p ? p.name : '調整した素材')}</b><span>${t('{shape}・{size} m', { shape: t(shapeOf(o.type).label), size: Math.round(Math.max(...o.scale)).toLocaleString() })}</span>`;
    for (const b of this.list.querySelectorAll('.obj-item.on .obj-name')) b.textContent = o.name;
  }

  // ---- 行の部品 ----

  #vecRow(text, v, step, onSet, unit) {
    const row = div('row row-vec');
    row.append(label(text));
    const inputs = v.map((n, i) => {
      const el = input('number', round(n));
      el.step = step;
      el.title = 'XYZ'[i];
      el.onchange = () => onSet(inputs.map((x) => +x.value || 0));
      return el;
    });
    const u = document.createElement('span');
    u.className = 'unit';
    u.textContent = unit;
    row.append(...inputs, u);
    return row;
  }

  #sizeRow(o) {
    const row = div('row');
    row.append(label('大きさ'));
    const maxS = Math.max(...o.scale);
    const range = input('range', toLog(maxS));
    range.min = 0;
    range.max = 1000;
    range.step = 1;
    const num = input('number', round(maxS));
    const unit = document.createElement('span');
    unit.className = 'unit';
    unit.textContent = 'm';
    const apply = (size) => this.#update((x) => {
      const cur = Math.max(...x.scale);
      return { ...x, scale: x.scale.map((s) => round((s / cur) * size)) };
    });
    range.oninput = () => {
      const size = fromLog(+range.value);
      num.value = round(size);
      apply(size);
    };
    num.onchange = () => +num.value > 0 && apply(+num.value);
    row.append(range, num, unit);
    return row;
  }

  #toggleRow(text, value, onSet) {
    const row = document.createElement('label');
    row.className = 'row row-toggle';
    row.append(label(text));
    const cb = input('checkbox');
    cb.checked = value;
    cb.onchange = () => onSet(cb.checked);
    const sw = document.createElement('span');
    sw.className = 'switch';
    row.append(cb, sw);
    return row;
  }

  #selectRow(text, options, value, onSet) {
    const row = div('row row-select');
    row.append(label(text));
    const sel = document.createElement('select');
    for (const [v, t] of options) sel.add(new Option(t, v));
    sel.value = value;
    sel.onchange = () => onSet(sel.value);
    row.append(sel);
    return row;
  }

  #colorRow(text, value, onSet) {
    const row = div('row row-color');
    row.append(label(text));
    const c = input('color', value);
    const hex = document.createElement('span');
    hex.className = 'hex';
    hex.textContent = value;
    c.oninput = () => {
      hex.textContent = c.value;
      onSet(c.value);
    };
    row.append(c, hex);
    return row;
  }

  #rangeRow(text, value, min, max, step, onSet) {
    const row = div('row');
    row.append(label(text));
    const r = input('range', value);
    Object.assign(r, { min, max, step });
    r.value = value;
    const n = input('number', value);
    n.step = step;
    r.oninput = () => {
      n.value = r.value;
      onSet(+r.value);
    };
    n.onchange = () => Number.isFinite(+n.value) && ((r.value = n.value), onSet(+n.value));
    const u = document.createElement('span');
    u.className = 'unit';
    row.append(r, n, u);
    return row;
  }
}

// 画像は長辺 1024px の JPEG/PNG に縮めてシーンに埋め込む（JSON が膨らみすぎないように）
async function shrinkImage(file) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 1024 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
  return blobToDataURL(await new Promise((r) => c.toBlob(r, type, 0.88)));
}

const toLog = (v) => ((Math.log10(Math.max(1, v)) - LOG_MIN) / (LOG_MAX - LOG_MIN)) * 1000;
const fromLog = (t) => Math.pow(10, LOG_MIN + (t / 1000) * (LOG_MAX - LOG_MIN));
const round = (v) => Math.round(v * 10) / 10;

function div(cls) {
  const d = document.createElement('div');
  d.className = cls;
  return d;
}
function sub(text) {
  const d = div('obj-sub');
  d.textContent = text;
  return d;
}
function label(text) {
  const s = document.createElement('span');
  s.className = 'row-label';
  s.textContent = text;
  return s;
}
function input(type, value) {
  const el = document.createElement('input');
  el.type = type;
  if (value !== undefined) el.value = value;
  return el;
}
function button(text, onClick, cls) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = text;
  if (cls) b.className = cls;
  b.onclick = (e) => {
    e.preventDefault();
    onClick();
  };
  return b;
}

