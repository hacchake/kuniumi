import { createDefaultScene, normalizeScene, deepMerge } from './core/schema.js';
import { createStore } from './core/store.js';
import { PRESETS } from './core/presets.js';
import { RealtimeRenderer } from './render/RealtimeRenderer.js';
import { Panel } from './ui/Panel.js';
import { sceneToJSON, sceneFromFile } from './io/sceneJson.js';
import { exportGlb, importGlb } from './io/gltf.js';
import { exportHeightmap, importHeightmap } from './io/heightmap.js';
import { blenderScript } from './io/blenderScript.js';
import { downloadBlob, pickFile, safeName, extOf } from './io/files.js';

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
      // 大きなハイトマップで容量を超えたときは、それを除いて残す
      try {
        const lite = structuredClone(s);
        lite.terrain.heightmap = null;
        lite.terrain.mode = 'noise';
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

const view = new RealtimeRenderer(document.getElementById('view'), store, {
  onStatus: (msg, kind) => msg && toast(msg, kind),
});
new Panel(document.getElementById('panel'), store);

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
  store.replace(normalizeScene(deepMerge(createDefaultScene(), p.scene)), { source: 'preset' });
  toast(`「${p.name}」を呼び出しました`);
};

// ---- ファイル操作 ----
const baseName = () => safeName(store.get().meta.name);

async function openJson(file) {
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
  const parts = [summary.fromKuniumi ? 'KUNIUMI の設定を復元' : '外部モデルの形を地形として取り込み'];
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

for (const btn of document.querySelectorAll('[data-act]')) {
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      await actions[btn.dataset.act]();
    } catch (err) {
      console.error(err);
      toast(`失敗しました: ${err.message ?? err}`, 'error');
    } finally {
      btn.disabled = false;
    }
  });
}

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
  try {
    await openAny(file);
  } catch (err) {
    console.error(err);
    toast(`読み込めませんでした: ${err.message ?? err}`, 'error');
  }
});

// デバッグ・自動検証用
window.KUNIUMI = { store, view, actions, openAny };
