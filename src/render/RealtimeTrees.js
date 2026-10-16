import * as THREE from 'three';
import { createVegetationRules, treeAt, treeCellSize } from '../core/vegetation.js';
import { coniferGeometry, fillInstances } from '../three/vegetationMeshes.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// リアルタイム表示の木。一枚絵と同じ規則・同じハッシュで、同じ所に同じ木が立つ（core/vegetation.js の treeAt）。
// カメラの周りを 256 m の区画に分けて、足りない区画を毎フレーム少しずつ生やす（数千 km の大地でも止まらない）。
// 近く（NEAR m 以内）は詳しい形、遠くは軽い形（円錐・多面体 1 つ）で描く。
// 座標は区画の原点からの相対で持つ（遠くても木が揺れないように）。

const BLOCK = 256;
const NEAR = 150;
const THIN = 1000; // これより遠い木は間引く
const MAX_FAR = 60000;
const MAX_NEAR = 6000;
const BLOCKS_PER_FRAME = 6;

// 遠景用の軽い形（1 本あたり十数〜数十三角形）
function lowConifer() {
  return new THREE.ConeGeometry(0.2, 0.85, 6, 1).translate(0, 0.575, 0);
}
// 少ない三角形の多面体を、面の向きを中心から放射状にして丸く見せる
function roundBlob(r, x, y, z, detail = 0, sy = 1) {
  const g = new THREE.IcosahedronGeometry(r, detail);
  const p = g.attributes.position, n = g.attributes.normal;
  for (let i = 0; i < p.count; i++) {
    const v = new THREE.Vector3(p.getX(i), p.getY(i), p.getZ(i)).normalize();
    n.setXYZ(i, v.x, v.y, v.z);
  }
  return g.scale(1, sy, 1).translate(x, y, z);
}

// 近景用の広葉樹（一枚絵の形は 1 本 2000 三角形近いので、リアルタイム用に 100 三角形ほどの形）
function midBroadleaf() {
  const trunk = new THREE.CylinderGeometry(0.022, 0.04, 0.5, 5, 1).translate(0, 0.25, 0);
  const blobs = [
    [0, 0.62, 0, 0.26],
    [0.13, 0.55, 0.06, 0.18],
    [-0.12, 0.57, -0.07, 0.19],
    [0.02, 0.76, -0.05, 0.17],
    [-0.04, 0.5, 0.14, 0.16],
  ].map(([x, y, z, r]) => roundBlob(r, x, y, z, 1));
  return { trunk, crown: mergeGeometries(blobs) };
}
function lowBroadleaf() {
  return roundBlob(0.3, 0, 0.62, 0, 0, 0.85);
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
    const con = coniferGeometry(), brd = midBroadleaf();
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
    this.crowns = { conCrown, brdCrown };
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

  // 季節の葉の色（広葉樹は春の若葉・秋の紅葉・冬の枯れ枝、針葉樹は冬に少し白く）
  setSeason(season) {
    const { conCrown, brdCrown } = this.crowns;
    brdCrown.color.set({ spring: '#4c7a26', autumn: '#9a4614', winter: '#4d4136' }[season] ?? '#2e4d1f');
    conCrown.color.set(season === 'winter' ? '#3b4a42' : '#1b3317');
  }

  dispose() {
    this.group.removeFromParent();
  }

  // s: シーン、cam: カメラ（世界座標）、terrain: { sample(x,z), groundAt(x,z) }
  // fwd: 見ている向き（視野の外の遠い木は描かない）
  // 衛星写真の画素（森の広がりに使う）。変わったら作り直す
  setPhoto(photo) {
    if (photo === this.photo) return;
    this.photo = photo;
    this.lastT = null;
  }

  update(s, cam, terrain, fwd = null) {
    this.fwd = fwd ? new THREE.Vector3(fwd.x, 0, fwd.z) : null;
    const lookDown = !fwd || Math.abs(fwd.y) / Math.max(1e-6, fwd.length()) > 0.75;
    if (lookDown || this.fwd.lengthSq() < 1e-9) this.fwd = null;
    else this.fwd.normalize();
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
      const key = JSON.stringify([t.mode, t.heightmap?.id, !!this.photo, t.noise, t.size, t.heightScale, t.baseHeight, t.palette, t.detail, veg, s.water.level, s.water.enabled, t.resolution]);
      if (key !== this.key) {
        this.key = key;
        this.blocks.clear();
        this.rules = createVegetationRules({ heightScale: t.heightScale, baseHeight: t.baseHeight, waterLevel: s.water.level, waterEnabled: s.water.enabled, palette: t.palette, vegetation: veg, realWorld: t.mode === 'heightmap' && !!t.heightmap?.geo, photo: this.photo, size: t.size });
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
    const turned = this.#turned();
    if (!this.dirty && !this.pending && !turned && this.lastScan && Math.hypot(cam.x - this.lastScan.x, cam.z - this.lastScan.z) < 24 && Math.abs(reach - this.lastScan.reach) < 50) return;
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
    if (this.dirty || moved || turned) this.#build(cam, reach);
  }

  // 歩く人（半径 body）が木の幹にめり込んでいたら外へ押し出す。押し出したら true
  pushOut(p, body = 0.3) {
    if (!this.group.visible) return false;
    const bi = Math.floor(p.x / BLOCK), bj = Math.floor(p.z / BLOCK);
    let hit = false;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const b = this.blocks.get(`${bi + di},${bj + dj}`);
        if (!b) continue;
        for (const L of [b.conifer, b.broadleaf]) {
          for (let k = 0; k < L.length; k += 5) {
            const dx = p.x - L[k], dz = p.z - L[k + 2];
            if (Math.abs(dx) > 3 || Math.abs(dz) > 3) continue;
            const r = L[k + 3] * 0.035 + body; // 幹の太さ（木の高さのおよそ 3.5%）＋体の半径
            const d = Math.hypot(dx, dz);
            if (d < r && p.y < L[k + 1] + L[k + 3]) {
              const s = d > 1e-6 ? r / d : 0;
              p.x = L[k] + (d > 1e-6 ? dx * s : r);
              p.z = L[k + 2] + dz * s;
              hit = true;
            }
          }
        }
      }
    }
    return hit;
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
    this.builtFwd = this.fwd ? this.fwd.clone() : null;
    const F = this.fwd;
    const COS = 0.26; // 視野（左右およそ 75° まで）の外の遠い木は省く
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
          if (d < NEAR) {
            lists.near[kind].push(L[k] - ox, L[k + 1], L[k + 2] - oz, L[k + 3], L[k + 4]);
            continue;
          }
          if (F && ((L[k] - cam.x) * F.x + (L[k + 2] - cam.z) * F.z) / d < COS) continue;
          // 1 km より先は 2 本に 1 本へ間引き、少し大きくして森の見た目の密度を保つ
          if (d > THIN && (k / 5) % 2 === 1) continue;
          lists.far[kind].push(L[k] - ox, L[k + 1], L[k + 2] - oz, L[k + 3] * (d > THIN ? 1.25 : 1), L[k + 4]);
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

  // 向きが 20° 以上変わったか（描く木を選び直す）
  #turned() {
    const a = this.builtFwd, b = this.fwd;
    if (!a && !b) return false;
    if (!a || !b) return true;
    return a.dot(b) < Math.cos((20 * Math.PI) / 180);
  }

  #setCounts(n) {
    for (const g of [this.near, this.far]) for (const k of ['conifer', 'broadleaf']) for (const m of g[k]) m.count = n;
    this.lastBuild = null;
  }
}

const clampList = (L, max) => (L.length / 5 > max ? L.slice(0, max * 5) : L);
