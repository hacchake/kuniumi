import * as THREE from 'three';
import { textureKey } from '../core/objects.js';

// 素材のテクスチャ（色・法線・発光）をワーカーで作って使い回す窓口。
// 同じ絵（textureKey が同じ）なら物体どうしで共有する。
// 計算は1件ずつ。色をドラッグ中のように要求が続いたら、もう要らない古い要求は飛ばす。

const IMAGE_MAX = 512; // 画像模様は縮めてから使う

export class TextureService {
  constructor(onReady) {
    this.worker = new Worker(new URL('../workers/textureWorker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => this.#receive(e.data);
    this.onReady = onReady;
    this.cache = new Map(); // key → { map, normalMap, emissiveMap }
    this.queue = new Map(); // key → { material, aspect }
    this.wanted = new Set();
    this.busyKey = null;
    this.waiters = [];
    this.images = new Map(); // dataURL → Promise<{data,width,height}>
  }

  static sizeFor(aspect) {
    return aspect >= 2 ? [1024, 512] : [512, 512];
  }

  // いま必要な鍵の一覧を知らせる（不要になった要求を飛ばし、使われないテクスチャを捨てる）
  setWanted(keys) {
    this.wanted = new Set(keys);
    for (const [key, set] of this.cache) {
      if (!this.wanted.has(key)) {
        set.map.dispose();
        set.normalMap.dispose();
        set.emissiveMap.dispose();
        this.cache.delete(key);
      }
    }
  }

  // 出来ていればテクスチャ一式、無ければ null を返して作成を予約する
  get(material, aspect) {
    const key = textureKey(material, aspect);
    const hit = this.cache.get(key);
    if (hit) return hit;
    if (this.busyKey !== key) this.queue.set(key, { material, aspect });
    this.#pump();
    return null;
  }

  idle() {
    if (!this.busyKey && ![...this.queue.keys()].some((k) => this.wanted.has(k))) return Promise.resolve();
    return new Promise((r) => this.waiters.push(r));
  }

  async #pump() {
    if (this.busyKey) return;
    let next = null;
    for (const [key, job] of this.queue) {
      this.queue.delete(key);
      if (this.wanted.has(key) && !this.cache.has(key)) {
        next = [key, job];
        break;
      }
    }
    if (!next) {
      this.waiters.splice(0).forEach((r) => r());
      return;
    }
    const [key, { material, aspect }] = next;
    this.busyKey = key;
    const [width, height] = TextureService.sizeFor(aspect);
    let image = null;
    if (material.pattern === 'image' && material.image) {
      try {
        image = await this.#loadImage(material.image);
      } catch {
        image = null;
      }
    }
    this.worker.postMessage({ key, material, width, height, image });
  }

  #receive(msg) {
    const key = msg.key;
    this.busyKey = null;
    if (msg.error) {
      console.error('テクスチャ生成に失敗:', msg.error);
    } else if (this.wanted.has(key)) {
      this.cache.set(key, {
        map: toTexture(msg.color, msg.width, msg.height, THREE.SRGBColorSpace, 'Color'),
        normalMap: toTexture(msg.normal, msg.width, msg.height, THREE.NoColorSpace, 'Normal'),
        emissiveMap: toTexture(msg.emissive, msg.width, msg.height, THREE.SRGBColorSpace, 'Emissive'),
      });
      this.onReady?.(key);
    }
    this.#pump();
  }

  #loadImage(url) {
    if (!this.images.has(url)) {
      this.images.set(
        url,
        (async () => {
          const bmp = await createImageBitmap(await (await fetch(url)).blob());
          const k = Math.min(1, IMAGE_MAX / Math.max(bmp.width, bmp.height));
          const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
          const c = new OffscreenCanvas(w, h);
          const ctx = c.getContext('2d');
          ctx.drawImage(bmp, 0, 0, w, h);
          return { data: ctx.getImageData(0, 0, w, h).data, width: w, height: h };
        })(),
      );
    }
    return this.images.get(url);
  }
}

// canvas テクスチャにする（glTF 書き出しで PNG として埋め込まれる）
function toTexture(rgba, w, h, colorSpace, name) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').putImageData(new ImageData(rgba, w, h), 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = colorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  tex.name = name;
  return tex;
}
