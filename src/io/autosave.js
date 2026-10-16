// 作業中のシーンをこのブラウザに自動で残す。
//
// シーンの骨組み（小さい）は localStorage に、大きな部分（ハイトマップ・衛星写真・物体の画像）は IndexedDB に分けて置く。
// localStorage は 5 MB ほどしか入らないので、地球から取り込んだ地形（数十 MB）は以前は入りきらず、
// 開くたびに取り寄せ直していた（1〜2 分）。IndexedDB なら数百 MB 入るので、開いてすぐ前の地形に戻れる。
// どちらも使えない環境（プライベートモードなど）でも、ほかの動作には影響しない。

const KEY = 'kuniumi.autosave.v1';
const DB = 'kuniumi-autosave'; // 自動保存専用（ほかの用途の DB と混ざらないように）
const STORE = 'blobs';

let dbPromise = null;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch((err) => {
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

function tx(mode, fn) {
  return db().then(
    (d) =>
      new Promise((resolve, reject) => {
        const t = d.transaction(STORE, mode);
        const r = fn(t.objectStore(STORE));
        t.oncomplete = () => resolve(r?.result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}
const idbGet = (k) => tx('readonly', (s) => s.get(k));
const idbPut = (k, v) => tx('readwrite', (s) => s.put(v, k));
const idbKeys = () => tx('readonly', (s) => s.getAllKeys());
const idbDelete = (k) => tx('readwrite', (s) => s.delete(k));

// 画像の文字列から短い鍵を作る（同じ画像は同じ鍵）
function keyOfString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += Math.max(1, Math.floor(s.length / 4096))) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return `${s.length.toString(36)}-${(h >>> 0).toString(36)}`;
}

// ---- 読む（起動時。骨組みだけ。同期） ----
export function loadSkeleton() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// 骨組みが指している大きな部分を IndexedDB から読み、シーンへ戻すための変更（store.patch 用）を返す。
// 見つからなければ null（そのときは呼び出し側が地球から取り寄せ直すなど）
export async function loadBigParts(skel) {
  if (!skel) return null;
  const patch = {};
  try {
    const t = skel.terrain ?? {};
    if (t.heightmapRef) {
      const hm = await idbGet(`hm:${t.heightmapRef}`);
      if (!hm) return null;
      patch['terrain.mode'] = 'heightmap';
      patch['terrain.heightmap'] = hm;
      patch['terrain.heightmapRef'] = null;
      patch['terrain.geoRestore'] = null;
    }
    const objs = skel.objects ?? [];
    if (objs.some((o) => o.material?.imageRef)) {
      const list = [];
      for (const o of objs) {
        const ref = o.material?.imageRef;
        const image = ref ? await idbGet(`img:${ref}`) : null;
        list.push(ref ? { ...o, material: { ...o.material, image: image ?? null, imageRef: undefined } } : o);
      }
      patch.objects = list;
    }
  } catch {
    return null;
  }
  return Object.keys(patch).length ? patch : null;
}

// ---- 残す ----
const saved = new Set(); // このページで IndexedDB に書いた鍵（同じものを何度も書かない）
export async function saveScene(s) {
  // 大きな部分を抜いた骨組み（元のシーンは変えない）
  const skel = { ...s, terrain: { ...s.terrain } };
  const keep = new Set();
  let idbOk = true;
  const put = async (key, value) => {
    keep.add(key);
    if (saved.has(key)) return;
    await idbPut(key, value);
    saved.add(key);
  };
  try {
    const hm = s.terrain.mode === 'heightmap' ? s.terrain.heightmap : null;
    if (hm) {
      await put(`hm:${hm.id}`, hm);
      skel.terrain.heightmapRef = hm.id;
      skel.terrain.heightmap = null;
      skel.terrain.mode = 'noise'; // IndexedDB から戻すまでの仮の地形
      // IndexedDB が消えていたときのために、地球から取り込んだ範囲も覚えておく
      if (hm.geo) skel.terrain.geoRestore = hm.geo;
    }
    const objs = [];
    for (const o of s.objects) {
      const img = o.material?.image;
      if (!img) {
        objs.push(o);
        continue;
      }
      const ref = keyOfString(img);
      await put(`img:${ref}`, img);
      objs.push({ ...o, material: { ...o.material, image: null, imageRef: ref } });
    }
    skel.objects = objs;
  } catch {
    // IndexedDB が使えない：以前と同じく、大きな部分を除いた骨組みだけ残す
    idbOk = false;
    const hm = s.terrain.mode === 'heightmap' ? s.terrain.heightmap : null;
    skel.terrain = { ...s.terrain, heightmap: null, heightmapRef: null, mode: 'noise', geoRestore: hm?.geo ?? null };
    skel.objects = s.objects.map((o) => (o.material?.image ? { ...o, material: { ...o.material, image: null } } : o));
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(skel));
  } catch {}
  // もう指されていない古い部分を消す
  if (idbOk) {
    try {
      for (const k of await idbKeys()) {
        if (!keep.has(k)) {
          await idbDelete(k);
          saved.delete(k);
        }
      }
    } catch {}
  }
}
