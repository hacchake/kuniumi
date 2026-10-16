import * as THREE from 'three';
import { aeqdInverse } from '../core/geo.js';

// 地球から取り込んだ景観の建物（OpenFreeMap のベクトルタイル。© OpenMapTiles © OpenStreetMap contributors）。
// カメラが地面から 2 km より低いとき、カメラの近く（約 1.4 km）のタイル（z14）だけ取り寄せて立体にする。
// 地面の高さは建物ごとに中心で測って足す（少し埋めて、斜面でも浮かないように）。
const Z = 14;
const NEAR = 1000; // この距離のタイルまで
const MAX_TILES = 4;
export const BUILDINGS_ATTRIBUTION = '© OpenMapTiles © OpenStreetMap contributors（OpenFreeMap）';

export class Buildings {
  constructor(parent, patchMaterial) {
    this.group = new THREE.Group();
    this.group.name = 'Buildings';
    parent.add(this.group);
    this.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0, side: THREE.DoubleSide });
    patchMaterial?.(this.material);
    this.tiles = new Map(); // "x/y" → { mesh, used, state }
    this.worker = null;
    this.urlTemplate = null;
    this.geoKey = null;
  }

  async #template() {
    if (this.urlTemplate !== null) return this.urlTemplate;
    this.urlTemplate = '';
    try {
      const tj = await (await fetch('https://tiles.openfreemap.org/planet')).json();
      this.urlTemplate = tj.tiles?.[0] ?? '';
    } catch {
      this.urlTemplate = null; // あとでもう一度
    }
    return this.urlTemplate;
  }

  #clear() {
    for (const t of this.tiles.values()) if (t.mesh) (this.group.remove(t.mesh), t.mesh.geometry.dispose());
    this.tiles.clear();
  }

  // s: シーン、cam: カメラ（世界座標・平らな地図の上）、groundAt(x, z)
  update(s, cam, groundAt) {
    const t = s.terrain;
    const geo = t.mode === 'heightmap' && t.buildings !== false ? t.heightmap?.geo : null;
    const key = geo ? `${t.heightmap.id}` : null;
    if (key !== this.geoKey) {
      this.#clear();
      this.geoKey = key;
    }
    this.group.visible = !!geo;
    if (!geo) return;
    const above = cam.y - groundAt(cam.x, cam.z);
    if (above > 2000) {
      this.group.visible = false;
      return;
    }
    if (Math.abs(cam.x) > t.size / 2 || Math.abs(cam.z) > t.size / 2) return;
    this.frame = (this.frame ?? 0) + 1;
    if (this.frame % 15) return; // 取り寄せる所の見直しは時々でよい
    // カメラの経緯度 → z14 のタイル
    const ll = aeqdInverse(cam.x, -cam.z, geo.lat, geo.lon);
    const n = 2 ** Z;
    const fx = ((ll.lon + 180) / 360) * n;
    const la = (ll.lat * Math.PI) / 180;
    const fy = ((1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2) * n;
    const tileM = (2 * Math.PI * 6371000 * Math.cos(la)) / n;
    const r = Math.ceil(NEAR / tileM);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const tx = Math.floor(fx) + dx, ty = Math.floor(fy) + dy;
        // タイルの中心までの距離で選ぶ
        const ddx = (tx + 0.5 - fx) * tileM, ddy = (ty + 0.5 - fy) * tileM;
        if (Math.hypot(ddx, ddy) > NEAR + tileM * 0.7) continue;
        const k = `${tx}/${ty}`;
        const tile = this.tiles.get(k);
        if (tile) {
          tile.used = this.frame;
          continue;
        }
        this.#request(tx, ty, k, geo, groundAt);
      }
    }
    // 遠くなったタイルを片付ける
    if (this.tiles.size > MAX_TILES) {
      const list = [...this.tiles.entries()].filter(([, v]) => v.state === 'ready').sort((a, b) => a[1].used - b[1].used);
      for (const [k, v] of list.slice(0, this.tiles.size - MAX_TILES)) {
        this.group.remove(v.mesh);
        v.mesh.geometry.dispose();
        this.tiles.delete(k);
      }
    }
  }

  async #request(tx, ty, k, geo, groundAt) {
    const tile = { state: 'loading', used: this.frame, mesh: null };
    this.tiles.set(k, tile);
    const tpl = await this.#template();
    if (!tpl) return this.tiles.delete(k);
    if (!this.worker) {
      this.worker = new Worker(new URL('../workers/buildingWorker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e) => this.#receive(e.data);
    }
    tile.groundAt = groundAt;
    this.worker.postMessage({ key: `${this.geoKey}|${k}`, url: tpl.replace('{z}', Z).replace('{x}', tx).replace('{y}', ty), z: Z, x: tx, y: ty, geo: { lat: geo.lat, lon: geo.lon } });
  }

  #receive(m) {
    const [gk, k] = m.key.split('|');
    const tile = this.tiles.get(k);
    if (gk !== this.geoKey || !tile) return;
    if (m.error || !m.count) {
      tile.state = 'ready';
      tile.mesh = new THREE.Object3D();
      return;
    }
    // 建物ごとの地面の高さ（中心で測り、2 m 埋める）を足す
    const base = new Float32Array(m.count);
    for (let b = 0; b < m.count; b++) base[b] = tile.groundAt(m.centers[b * 2], m.centers[b * 2 + 1]) - 2;
    const p = m.positions;
    for (let v = 0; v < m.ids.length; v++) p[v * 3 + 1] += base[m.ids[v]] + (p[v * 3 + 1] === 0 ? 0 : 2);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    g.setAttribute('color', new THREE.BufferAttribute(m.colors, 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, this.material);
    mesh.castShadow = false; // 影の地図に描くと重い（地面への影は省く）
    mesh.receiveShadow = true;
    mesh.frustumCulled = false; // 丸みで曲げるので、元の位置での判定は使えない
    this.group.add(mesh);
    tile.mesh = mesh;
    tile.state = 'ready';
  }
}
