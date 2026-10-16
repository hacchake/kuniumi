// ワーカーに地形計算を頼む窓口。
// 同時に投げるのは1件だけにして、計算中に来た変更は「最新の1件」にまとめて後から送る。

export function fieldKeyOf(t) {
  if (t.mode === 'heightmap' && t.heightmap) return `hm:${t.heightmap.id}:${t.resolution}`;
  return `noise:${JSON.stringify(t.noise)}:${t.resolution}`;
}

export class TerrainService {
  // options.textureSize: 地表テクスチャの一辺（静止画用に大きくするとき）
  constructor(onResult, onError, options = {}) {
    this.textureSize = options.textureSize ?? null;
    this.worker = new Worker(new URL('../workers/terrainWorker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => this.#receive(e.data);
    this.onResult = onResult;
    this.onError = onError;
    this.busy = false;
    this.queued = null;
    this.seq = 0;
    this.sentKey = null;
    this.field = null; // 最新の高さ場（メインスレッド側の写し）
    this.wear = null;
    this.res = 0;
    this.waiters = [];
  }

  // withColors: 地表の色のテクスチャも焼く（書き出し用）
  request(scene, { withColors = true } = {}) {
    // まだ送っていない依頼があれば、色の要否はまとめる
    this.queuedColors = (this.queued ? this.queuedColors : false) || withColors;
    this.queued = scene;
    if (!this.busy) this.#flush();
  }

  // いま積まれている計算がすべて終わるまで待つ（書き出し前などに使う）
  idle() {
    if (!this.busy && !this.queued) return Promise.resolve();
    return new Promise((r) => this.waiters.push(r));
  }

  #flush() {
    const scene = this.queued;
    this.queued = null;
    if (!scene) {
      this.waiters.splice(0).forEach((r) => r());
      return;
    }
    this.busy = true;
    const withColors = this.queuedColors;
    const t = scene.terrain;
    const key = fieldKeyOf(t);
    // 高さ場が変わらないときは、大きなハイトマップ文字列を送らない
    const terrain = key === this.sentKey ? null : t;
    this.sentKey = key;
    this.worker.postMessage({
      id: ++this.seq,
      key,
      terrain,
      color: !withColors ? null : {
        size: t.size,
        heightScale: t.heightScale,
        baseHeight: t.baseHeight,
        waterLevel: scene.water.level,
        waterEnabled: scene.water.enabled,
        palette: t.palette,
        realWorld: t.mode === 'heightmap' && !!t.heightmap?.geo,
        vegetation: scene.vegetation,
        seed: t.mode === 'noise' ? t.noise.seed : 0,
        textureSize: this.textureSize ?? undefined,
      },
    });
  }

  dispose() {
    this.worker.terminate();
  }

  #receive(msg) {
    this.busy = false;
    if (msg.error) {
      this.sentKey = null;
      this.onError?.(msg.error);
    } else {
      if (msg.field) {
        this.field = msg.field;
        this.res = msg.res;
        this.wear = msg.wear ?? null;
      }
      this.onResult({
        field: this.field,
        res: this.res,
        wear: this.wear,
        fieldChanged: !!msg.field,
        colors: msg.colors,
        texSize: msg.texSize,
      });
    }
    this.#flush();
  }
}
