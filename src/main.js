import { createDefaultScene, normalizeScene, deepMerge } from './core/schema.js';
import { createStore } from './core/store.js';
import { PRESETS } from './core/presets.js';
import { RealtimeRenderer } from './render/RealtimeRenderer.js';
import { Panel } from './ui/Panel.js';
import { ObjectPanel } from './ui/ObjectPanel.js';
import { createObject, newId } from './core/objects.js';
import { sceneToJSON, sceneFromFile } from './io/sceneJson.js';
import { exportGlb, importGlb } from './io/gltf.js';
import { exportHeightmap, importHeightmap } from './io/heightmap.js';
import { blenderScript } from './io/blenderScript.js';
import { downloadBlob, pickFile, safeName, extOf } from './io/files.js';
import { encodeRadianceHDR } from './core/tonemap.js';
import { createHistory } from './core/history.js';

const AUTOSAVE_KEY = 'kuniumi.autosave.v1';

// 前回の作業をこのブラウザに残しておく（なくても動く）
function loadAutosave() {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    return raw ? normalizeScene(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

const store = createStore(loadAutosave() ?? createDefaultScene());

let saveTimer = 0;
store.subscribe((s) => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(s));
    } catch {
      // 大きなハイトマップや画像で容量を超えたときは、それらを除いて残す
      try {
        const lite = structuredClone(s);
        lite.terrain.heightmap = null;
        lite.terrain.mode = 'noise';
        for (const o of lite.objects) if (o.material.image) o.material.image = null;
        localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(lite));
      } catch {}
    }
  }, 600);
});

// ---- 表示 ----
const toastEl = document.getElementById('toast');
let toastTimer = 0;
function toast(msg, kind = 'info') {
  toastEl.textContent = msg;
  toastEl.className = `toast-${kind}`;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), kind === 'error' ? 7000 : 3500);
}

// 画面上の選択はシーンデータとは別に持つ（保存しない UI 状態）
const selection = createStore({ selected: null });

const view = new RealtimeRenderer(document.getElementById('view'), store, {
  onStatus: (msg, kind) => msg && toast(msg, kind),
  selection,
});
new Panel(document.getElementById('panel'), store);
new ObjectPanel(document.getElementById('panel'), store, selection, {
  onDelete: (id) => removeObject(id),
  onDuplicate: (id) => duplicateObject(id),
});

// ---- 物体（創造パレット）----
function addObject(obj) {
  store.set('objects', [...store.get().objects, obj], { source: 'create' });
  selection.set('selected', obj.id);
}

function createShape(type) {
  const size = Math.round(store.get().terrain.size * 0.04);
  // 画面中央の先の地面へ。すでに物体がある所なら、視線と直角の向きへ順にずらして空きを探す
  const others = store.get().objects.filter((o) => !o.celestial);
  const side = view.sideVector();
  let p = view.groundPoint();
  for (let k = 1; k < 12 && others.some((o) => Math.hypot(o.position[0] - p.x, o.position[2] - p.z) < size * 1.2); k++) {
    const step = Math.ceil(k / 2) * size * 1.5 * (k % 2 ? 1 : -1);
    p = view.groundPoint(side.clone().multiplyScalar(step));
  }
  // 地面に置く：中心を半分持ち上げる（平たい環・トーラスは少し浮かせる）
  const lift = type === 'ring' || type === 'torus' ? size * 0.4 : size / 2;
  addObject(createObject(type, { size, position: [p.x, p.y + lift, p.z].map((v) => Math.round(v)) }));
}

function createCelestial() {
  const d = Math.round(store.get().terrain.size * 1.2);
  const p = view.skyPoint(d);
  const obj = createObject('sphere', { size: d, position: p.toArray().map(Math.round), material: 'lava-world', name: '天体' });
  obj.celestial = true;
  obj.castShadow = false;
  addObject(obj);
}

function removeObject(id) {
  if (!id) return;
  store.set('objects', store.get().objects.filter((o) => o.id !== id), { source: 'create' });
  if (selection.get().selected === id) selection.set('selected', null);
}

function duplicateObject(id) {
  const src = store.get().objects.find((o) => o.id === id);
  if (!src) return;
  const off = Math.max(...src.scale) * 0.6;
  addObject({ ...structuredClone(src), id: newId(), name: src.name, position: [src.position[0] + off, src.position[1], src.position[2] + off] });
}

for (const b of document.querySelectorAll('#create [data-shape]')) {
  b.addEventListener('click', () => (b.dataset.shape === 'celestial' ? createCelestial() : createShape(b.dataset.shape)));
}

const gizmoButtons = document.querySelectorAll('#create [data-gizmo]');
function setGizmo(mode) {
  view.setGizmoMode(mode);
  gizmoButtons.forEach((x) => x.classList.toggle('on', x.dataset.gizmo === mode));
}
gizmoButtons.forEach((b) => b.addEventListener('click', () => setGizmo(b.dataset.gizmo)));

const busyEl = document.getElementById('busy');
setInterval(() => (busyEl.hidden = !view.terrainService.busy), 120);

// ---- 星の名前 ----
const nameEl = document.getElementById('world-name');
nameEl.value = store.get().meta.name;
nameEl.oninput = () => store.set('meta.name', nameEl.value, { source: 'ui' });
store.subscribe((s, _c, meta) => meta.source !== 'ui' && (nameEl.value = s.meta.name));

// ---- 星のひな形 ----
const presetEl = document.getElementById('preset');
presetEl.add(new Option('— 選ぶと差し替え —', ''));
for (const p of PRESETS) presetEl.add(new Option(p.name, p.id));
presetEl.onchange = () => {
  const p = PRESETS.find((x) => x.id === presetEl.value);
  presetEl.value = '';
  if (!p) return;
  selection.set('selected', null);
  store.replace(normalizeScene(deepMerge(createDefaultScene(), p.scene)), { source: 'preset' });
  toast(`「${p.name}」を呼び出しました（元に戻すで戻せます）`);
};

// ---- ファイル操作 ----
const baseName = () => safeName(store.get().meta.name);

async function openJson(file) {
  selection.set('selected', null);
  store.replace(await sceneFromFile(file), { source: 'io' });
  toast(`シーン「${store.get().meta.name}」を読み込みました`);
}

async function openGlb(file) {
  const { scene, summary } = await importGlb(await file.arrayBuffer(), {
    renderer: view.renderer,
    current: store.get(),
    resolution: store.get().terrain.resolution,
  });
  store.replace(scene, { source: 'io' });
  selection.set('selected', null);
  const parts = [summary.fromKuniumi ? 'KUNIUMI の設定を復元' : '外部モデルの形を地形として取り込み'];
  if (summary.objects) parts.push(`物体 ${summary.objects} 個`);
  if (summary.hasLight) parts.push('太陽');
  if (summary.hasCamera) parts.push('カメラ');
  toast(`${file.name}: ${parts.join('・')}`);
}

async function openHeightmap(file) {
  const r = await importHeightmap(file);
  const changes = {
    'terrain.mode': 'heightmap',
    'terrain.heightmap': r.heightmap,
    'terrain.resolution': r.resolution,
  };
  if (r.info) {
    if (r.info.size) changes['terrain.size'] = r.info.size;
    if (r.info.heightScale != null) changes['terrain.heightScale'] = r.info.heightScale;
    if (r.info.baseHeight != null) changes['terrain.baseHeight'] = r.info.baseHeight;
  }
  store.patch(changes, { source: 'io' });
  toast(`${file.name}（${r.heightmap.width}×${r.heightmap.height}, ${r.heightmap.bitDepth}bit）を地形にしました${r.info ? '・実寸も復元' : ''}`);
}

async function openAny(file) {
  const ext = extOf(file);
  if (ext === 'json') return openJson(file);
  if (ext === 'glb' || ext === 'gltf') return openGlb(file);
  if (['png', 'jpg', 'jpeg', 'webp'].includes(ext)) return openHeightmap(file);
  throw new Error(`.${ext} は読み込めません`);
}

const actions = {
  'new-scene': async () => {
    selection.set('selected', null);
    store.replace(createDefaultScene(), { source: 'io' });
    toast('新しい星にしました（元に戻すで戻せます）');
  },
  'open-json': async () => {
    const f = await pickFile('.json,application/json');
    if (f) await openJson(f);
  },
  'save-json': async () => {
    downloadBlob(new Blob([sceneToJSON(store.get())], { type: 'application/json' }), `${baseName()}.kuniumi.json`);
    toast('シーンを保存しました');
  },
  'export-glb': async () => {
    toast('glb を書き出しています…');
    const blob = await exportGlb(store.get(), await view.ready());
    downloadBlob(blob, `${baseName()}.glb`);
    toast(`glb を書き出しました（${(blob.size / 1048576).toFixed(1)} MB）`);
  },
  'import-glb': async () => {
    const f = await pickFile('.glb,.gltf,model/gltf-binary');
    if (f) await openGlb(f);
  },
  'export-hm': async () => {
    const { field, res } = await view.ready();
    const s = store.get();
    const blob = await exportHeightmap(field, res, s.terrain, s.water.level);
    downloadBlob(blob, `${baseName()}_height16.png`);
    toast(`ハイトマップを書き出しました（${res}×${res}, 16bit）`);
  },
  'import-hm': async () => {
    const f = await pickFile('.png,.jpg,.jpeg,.webp,image/*');
    if (f) await openHeightmap(f);
  },
  'export-py': async () => {
    const s = store.get();
    const py = blenderScript(s, `${baseName()}.glb`);
    downloadBlob(new Blob([py], { type: 'text/x-python' }), `${baseName()}_blender.py`);
    toast('Blender 用スクリプトを書き出しました（同名の .glb と同じフォルダへ）');
  },
};

async function runAction(name, btn) {
  if (stillJob) return toast('一枚絵を描いている間はできません', 'error');
  if (btn) btn.disabled = true;
  try {
    await actions[name]();
  } catch (err) {
    console.error(err);
    toast(`失敗しました: ${err.message ?? err}`, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}
for (const btn of document.querySelectorAll('[data-act]')) {
  btn.addEventListener('click', () => {
    closeMenu();
    runAction(btn.dataset.act, btn);
  });
}

// ---- ファイルメニュー ----
const menuBtn = document.getElementById('file-menu-btn');
const menuEl = document.getElementById('file-menu');
function closeMenu() {
  menuEl.hidden = true;
  menuBtn.setAttribute('aria-expanded', 'false');
}
menuBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  menuEl.hidden = !menuEl.hidden;
  menuBtn.setAttribute('aria-expanded', String(!menuEl.hidden));
  if (!menuEl.hidden) menuEl.querySelector('button')?.focus();
});
document.addEventListener('pointerdown', (e) => {
  if (!menuEl.hidden && !(e.target instanceof Element && e.target.closest('.menu-wrap'))) closeMenu();
});

// ---- 元に戻す／やり直す ----
const undoBtn = document.getElementById('undo');
const redoBtn = document.getElementById('redo');
const history = createHistory(store, {
  onChange: () => {
    undoBtn.disabled = !history.canUndo();
    redoBtn.disabled = !history.canRedo();
  },
});
function undo() {
  if (stillJob) return;
  if (history.undo()) toast('元に戻しました');
}
function redo() {
  if (stillJob) return;
  if (history.redo()) toast('やり直しました');
}
undoBtn.addEventListener('click', undo);
redoBtn.addEventListener('click', redo);

// ---- 使い方 ----
const helpEl = document.getElementById('help');
const openHelp = () => (helpEl.hidden = false);
const closeHelp = () => (helpEl.hidden = true);
document.getElementById('help-btn').addEventListener('click', openHelp);
helpEl.addEventListener('click', (e) => {
  if (e.target === helpEl || e.target.closest('[data-close]')) closeHelp();
});

// ---- ドラッグ＆ドロップ ----
const dropEl = document.getElementById('drop');
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  dragDepth++;
  dropEl.hidden = false;
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    dropEl.hidden = true;
  }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropEl.hidden = true;
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  if (stillJob) return toast('一枚絵を描いている間は読み込めません', 'error');
  try {
    await openAny(file);
  } catch (err) {
    console.error(err);
    toast(`読み込めませんでした: ${err.message ?? err}`, 'error');
  }
});

// ---- 一枚絵（パストレース）----
// 重い描画器は使うときだけ読み込む（WebGPU・パストレーサ・ノイズ除去の読み込みを起動時に待たせない）
const stillEl = document.getElementById('still');
const stillStatus = document.getElementById('still-status');
const stillInfo = document.getElementById('still-info');
const stillBar = document.getElementById('still-progress');
const stillView = document.getElementById('still-view');
const stillActions = document.getElementById('still-actions');
const stillClose = document.getElementById('still-close');
let stillJob = null;
let stillResult = null;

const fmtSec = (t) => (t >= 60 ? `${Math.floor(t / 60)}分${Math.round(t % 60)}秒` : `${Math.round(t)}秒`);

async function renderStill() {
  if (stillJob) return;
  selection.set('selected', null);
  stillEl.hidden = false;
  stillActions.hidden = true;
  stillClose.textContent = '中止';
  stillBar.style.width = '0%';
  stillInfo.textContent = '';
  stillStatus.textContent = '描画器を読み込んでいます…';
  const canvas = document.createElement('canvas');
  stillView.replaceChildren(canvas);
  stillResult = null;
  try {
    const { StillJob } = await import('./render/StillRenderer.js');
    const s = structuredClone(store.get());
    stillJob = new StillJob(s, { view }, {
      canvas,
      onStatus: (t) => (stillStatus.textContent = t),
      onProgress: (done, total, info) => {
        stillBar.style.width = `${(done / total) * 100}%`;
        stillStatus.textContent = info.denoising ? 'AI でノイズを取り除いています…' : '光を追いかけています…';
        stillInfo.textContent = `${Math.floor(done)} / ${total} サンプル　経過 ${fmtSec(info.sec)}${info.denoising ? '' : `　残り約 ${fmtSec(info.left)}`}`;
      },
    });
    const r = await stillJob.run();
    stillResult = { ...r, name: baseName(), stats: stillJob.stats };
    const out = document.createElement('canvas');
    out.width = r.width;
    out.height = r.height;
    out.getContext('2d').putImageData(new ImageData(r.rgba, r.width, r.height), 0, 0);
    stillView.replaceChildren(out);
    stillResult.canvas = out;
    stillBar.style.width = '100%';
    stillStatus.textContent = '描けました';
    stillInfo.textContent = `${r.width}×${r.height}　${r.samples} サンプル${r.denoised ? '・ノイズ除去' : ''}　${fmtSec(r.traceSec)}`;
    stillActions.hidden = false;
  } catch (err) {
    if (stillJob?.cancelled) {
      stillStatus.textContent = '中止しました';
    } else {
      console.error(err);
      stillStatus.textContent = `描けませんでした: ${err.message ?? err}`;
    }
  } finally {
    stillJob = null;
    stillClose.textContent = '閉じる';
  }
}

document.getElementById('render-still').addEventListener('click', renderStill);
stillClose.addEventListener('click', () => {
  if (stillJob) stillJob.cancel();
  else stillEl.hidden = true;
});
stillActions.addEventListener('click', async (e) => {
  const act = e.target.closest('[data-still]')?.dataset.still;
  if (!act) return;
  if (act === 'again') return renderStill();
  if (!stillResult) return;
  if (act === 'png') {
    const blob = await new Promise((r) => stillResult.canvas.toBlob(r, 'image/png'));
    downloadBlob(blob, `${stillResult.name}.png`);
  } else if (act === 'hdr') {
    downloadBlob(encodeRadianceHDR(stillResult.hdr, stillResult.width, stillResult.height), `${stillResult.name}.hdr`);
  }
});

// ---- キーボード ----
const modalOpen = () => !stillEl.hidden || !helpEl.hidden;
window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  const mod = e.ctrlKey || e.metaKey;
  // ダイアログ・メニュー：Esc で閉じる。開いている間はほかの操作を受け付けない（後ろの物体を消したりしない）
  if (k === 'escape') {
    if (!menuEl.hidden) return closeMenu();
    if (!helpEl.hidden) return closeHelp();
    if (!stillEl.hidden) {
      if (stillJob) stillJob.cancel();
      else stillEl.hidden = true;
      return;
    }
  }
  if (modalOpen()) return;
  if (e.target instanceof Element && e.target.closest('input, select, textarea')) return;
  const id = selection.get().selected;

  if (mod && k === 'z') {
    e.preventDefault();
    return e.shiftKey ? redo() : undo();
  }
  if (mod && k === 'y') {
    e.preventDefault();
    return redo();
  }
  if (mod && k === 's') {
    e.preventDefault();
    return runAction('save-json');
  }
  if (mod && k === 'o') {
    e.preventDefault();
    return runAction('open-json');
  }
  if (mod && e.altKey && k === 'n') {
    e.preventDefault();
    return runAction('new-scene');
  }
  if (mod && k === 'enter') {
    e.preventDefault();
    return renderStill();
  }
  if (mod && k === 'd' && id) {
    e.preventDefault();
    return duplicateObject(id);
  }
  if (mod || e.altKey) return;
  if (k === 'w') setGizmo('translate');
  else if (k === 'e') setGizmo('rotate');
  else if (k === 'r') setGizmo('scale');
  else if (k === 'escape') selection.set('selected', null);
  else if ((k === 'delete' || k === 'backspace') && id) removeObject(id);
  else if (k === 'f') {
    if (!id || !view.frameObject(id)) toast('寄る物体を選んでください（クリック）');
  } else if (k === 'home') view.frameAll();
  else if (e.key === '?') openHelp();
});

// ---- 予期しないエラーは知らせる（同じ内容を何度も出さない）----
let lastError = '';
const reportError = (msg) => {
  if (!msg || msg === lastError) return;
  lastError = msg;
  setTimeout(() => (lastError = ''), 5000);
  toast(`問題が起きました: ${msg}`, 'error');
};
window.addEventListener('error', (e) => e.message && reportError(e.message));
window.addEventListener('unhandledrejection', (e) => reportError(e.reason?.message ?? String(e.reason)));

// ---- 起動中の表示を消す（最初の地形が届いたら）----
const bootEl = document.getElementById('boot');
const bootWait = setInterval(() => {
  if (!view.terrain) return;
  clearInterval(bootWait);
  window.__kuniumiReady = true;
  bootEl.classList.add('done');
  setTimeout(() => bootEl.remove(), 600);
}, 100);

// デバッグ・自動検証用
window.KUNIUMI = { store, view, actions, openAny, selection, renderStill, history, get stillResult() { return stillResult; } };
