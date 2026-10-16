import * as THREE from 'three';
import { createVegetationRules, treeAt, treeCellSize } from '../core/vegetation.js';
import { coniferGeometry, broadleafGeometry, fillInstances } from '../three/vegetationMeshes.js';

// リアルタイム表示の木。一枚絵と同じ規則・同じハッシュで、同じ所に同じ木が立つ（core/vegetation.js の treeAt）。
// カメラの周りを 256 m の区画に分けて、足りない区画を毎フレーム少しずつ生やす（数千 km の大地でも止まらない）。
// 近く（NEAR m 以内）は詳しい形、遠くは軽い形（円錐・多面体 1 つ）で描く。
// 座標は区画の原点からの相対で持つ（遠くても木が揺れないように）。

const BLOCK = 256;
const NEAR = 150;
const MAX_FAR = 60000;
const MAX_NEAR = 6000;
const BLOCKS_PER_FRAME = 6;

// 遠景用の軽い形（1 本あたり十数〜数十三角形）
function lowConifer() {
  return new THREE.ConeGeometry(0.2, 0.85, 6, 1).translate(0, 0.575, 0);
}
function lowBroadleaf() {
  return new THREE.IcosahedronGeometry(0.3, 0).scale(1, 0.85, 1).translate(0, 0.62, 0);
}

export class RealtimeTrees {
  // patchMaterial: 雲の影・丸みの差し込み
  constructor(parent, patchMaterial) {
    this.group = new THREE.Group();
    this.group.name = 'Trees';
    parent.add(this.group);
    const mat = (color, opts = {}) => {
      const m = new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0, ...opts });
      m.defines = { KUNIUMI_VERTEX_CLOUD: '' }; // 雲の影は頂点ごと（葉が重なっても軽く）
      patchMaterial?.(m);
      return m;
    };
    const trunk = new THREE.Color('#3a2b20');
    const con = coniferGeometry(), brd = broadleafGeometry();
    const mk = (geo, material, max, near) => {
      const m = new THREE.InstancedMesh(geo, material, max);
      m.count = 0;
      m.frustumCulled = false;
      m.castShadow = near;
      m.receiveShadow = true;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(m);
      return m;
    };
    const conCrown = mat(new THREE.Color('#1b3317'));
    const brdCrown = mat(new THREE.Color('#2e4d1f'));
    const wood = mat(trunk);
    this.near = {
      conifer: [mk(con.trunk, wood, MAX_NEAR, true), mk(con.crown, conCrown, MAX_NEAR, true)],
      broadleaf: [mk(brd.trunk, wood, MAX_NEAR, true), mk(brd.crown, brdCrown, MAX_NEAR, true)],
    };
    this.far = {
      conifer: [mk(lowConifer(), conCrown, MAX_FAR, false)],
      broadleaf: [mk(lowBroadleaf(), brdCrown, MAX_FAR, false)],
    };
    this.blocks = new Map(); // "bi,bj" → { conifer: [...], broadleaf: [...] }（世界座標）
    this.key = null;
    this.origin = new THREE.Vector2(NaN, NaN);
    this.lastBuild = null;
    this.dirty = false;
  }

  dispose() {
    this.group.removeFromParent();
  }

  // s: シーン、cam: カメラ（世界座標）、terrain: { sample(x,z), groundAt(x,z) }
  update(s, cam, terrain) {
    const veg = s.vegetation;
    const t = s.terrain;
    const enabled = veg && veg.trees > 0 && terrain;
    this.group.visible = !!enabled;
    if (!enabled) return;
    // シーン（地形・植生・水）が変わったら作り直す
    // シーンは不変更新なので、地形・植生・水の入れ物が同じなら中身も同じ
    if (t !== this.lastT || veg !== this.lastV || s.water !== this.lastW) {
      this.lastT = t;
      this.lastV = veg;
      this.lastW = s.water;
      const key = JSON.stringify([t.mode, t.heightmap?.id, t.noise, t.size, t.heightScale, t.baseHeight, t.palette, t.detail, veg, s.water.level, s.water.enabled, t.resolution]);
      if (key !== this.key) {
        this.key = key;
        this.blocks.clear();
        this.rules = createVegetationRules({ heightScale: t.heightScale, baseHeight: t.baseHeight, waterLevel: s.water.level, waterEnabled: s.water.enabled, palette: t.palette, vegetation: veg, realWorld: t.mode === 'heightmap' && !!t.heightmap?.geo });
        this.dirty = true;
      }
    }
    // 地面から高く離れたら木は見分けられないので置かない（森の色だけ）
    const ground = terrain.groundAt(cam.x, cam.z);
    const above = cam.y - ground;
    const reach = Math.min(Math.max(600, veg.treeHeight * 120), Math.max(0, 4000 - above * 2));
    if (reach <= 0) {
      this.#setCounts(0);
      return;
    }
    // カメラがほとんど動かず、生やし終えていれば何もしない
    if (!this.dirty && !this.pending && this.lastScan && Math.hypot(cam.x - this.lastScan.x, cam.z - this.lastScan.z) < 24 && Math.abs(reach - this.lastScan.reach) < 50) return;
    this.lastScan = { x: cam.x, z: cam.z, reach };
    // 要る区画を近い順に生やす（1 フレームにいくつかずつ）
    const bi0 = Math.floor(cam.x / BLOCK), bj0 = Math.floor(cam.z / BLOCK);
    const nb = Math.ceil(reach / BLOCK);
    const need = new Set();
    const missing = [];
    for (let bj = bj0 - nb; bj <= bj0 + nb; bj++) {
      for (let bi = bi0 - nb; bi <= bi0 + nb; bi++) {
        const cx = (bi + 0.5) * BLOCK, cz = (bj + 0.5) * BLOCK;
        const d = Math.hypot(cx - cam.x, cz - cam.z) - BLOCK * 0.71;
        if (d > reach) continue;
        const k = `${bi},${bj}`;
        need.add(k);
        if (!this.blocks.has(k)) missing.push([d, bi, bj, k]);
      }
    }
    missing.sort((a, b) => a[0] - b[0]);
    this.pending = missing.length > BLOCKS_PER_FRAME;
    for (const [, bi, bj, k] of missing.slice(0, BLOCKS_PER_FRAME)) {
      this.blocks.set(k, this.#grow(bi, bj, t.size, terrain));
      this.dirty = true;
    }
    for (const k of this.blocks.keys()) {
      if (!need.has(k)) {
        this.blocks.delete(k);
        this.dirty = true;
      }
    }
    // 近い・遠いの振り分けは、カメラが少し動いたら
    const moved = !this.lastBuild || Math.hypot(cam.x - this.lastBuild.x, cam.z - this.lastBuild.z) > NEAR * 0.25;
    if (this.dirty || moved) this.#build(cam, reach);
  }

  #grow(bi, bj, size, terrain) {
    const cell = treeCellSize(this.rules.veg);
    const out = { conifer: [], broadleaf: [] };
    const i0 = Math.floor((bi * BLOCK) / cell), i1 = Math.floor(((bi + 1) * BLOCK) / cell);
    const j0 = Math.floor((bj * BLOCK) / cell), j1 = Math.floor(((bj + 1) * BLOCK) / cell);
    const sample = (x, z) => terrain.sample(x, z);
    const height = (x, z) => terrain.groundAt(x, z);
    for (let j = j0; j < j1; j++) {
      for (let i = i0; i < i1; i++) {
        const tr = treeAt(i, j, this.rules, size, sample, height);
        if (tr) out[tr.kind].push(tr.x, tr.y, tr.z, tr.h, tr.rot);
      }
    }
    return out;
  }

  #build(cam, reach) {
    this.dirty = false;
    this.lastBuild = { x: cam.x, z: cam.z };
    // 原点は 4096 m ごと（木の座標を小さな数で持つ）
    const ox = Math.round(cam.x / 4096) * 4096, oz = Math.round(cam.z / 4096) * 4096;
    this.group.position.set(ox, 0, oz);
    const lists = { near: { conifer: [], broadleaf: [] }, far: { conifer: [], broadleaf: [] } };
    for (const b of this.blocks.values()) {
      for (const kind of ['conifer', 'broadleaf']) {
        const L = b[kind];
        for (let k = 0; k < L.length; k += 5) {
          const d = Math.hypot(L[k] - cam.x, L[k + 2] - cam.z);
          if (d > reach) continue;
          const dst = d < NEAR ? lists.near[kind] : lists.far[kind];
          dst.push(L[k] - ox, L[k + 1], L[k + 2] - oz, L[k + 3], L[k + 4]);
        }
      }
    }
    for (const kind of ['conifer', 'broadleaf']) {
      const near = clampList(lists.near[kind], MAX_NEAR), far = clampList(lists.far[kind], MAX_FAR);
      const [trunk, crown] = this.near[kind];
      fillInstances(trunk, near, 0, 1);
      fillInstances(crown, near, 0.35, kind === 'conifer' ? 3 : 5);
      fillInstances(this.far[kind][0], far, 0.35, kind === 'conifer' ? 3 : 5);
    }
  }

  #setCounts(n) {
    for (const g of [this.near, this.far]) for (const k of ['conifer', 'broadleaf']) for (const m of g[k]) m.count = n;
    this.lastBuild = null;
  }
}

const clampList = (L, max) => (L.length / 5 > max ? L.slice(0, max * 5) : L);
