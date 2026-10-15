import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32 } from '../core/noise.js';

// 一枚絵に並べる木と草の形。高さ 1 の単位形状で、置くときに大きさを掛ける。
// 幹と葉は別のメッシュ（素材が違う）にして、同じ置き場所の一覧を共有する。

// 葉の塊の表面を少しでこぼこにして、作り物の球に見えないようにする
function lumpy(geo, amount, seed) {
  const rand = mulberry32(seed);
  const p = geo.attributes.position;
  const offs = new Map();
  for (let i = 0; i < p.count; i++) {
    const key = `${p.getX(i).toFixed(4)},${p.getY(i).toFixed(4)},${p.getZ(i).toFixed(4)}`;
    if (!offs.has(key)) offs.set(key, 1 + (rand() - 0.5) * amount);
    const k = offs.get(key);
    p.setXYZ(i, p.getX(i) * k, p.getY(i) * (1 + (k - 1) * 0.5), p.getZ(i) * k);
  }
  geo.computeVertexNormals();
  return geo;
}

// 針葉樹：細い幹と、下ほど広い段々の円錐
export function coniferGeometry() {
  const trunk = new THREE.CylinderGeometry(0.018, 0.03, 0.3, 6, 1).translate(0, 0.15, 0);
  const layers = [];
  const tiers = 5;
  for (let i = 0; i < tiers; i++) {
    const t = i / (tiers - 1);
    const r = 0.26 * (1 - t * 0.75);
    const h = 0.34 * (1 - t * 0.35);
    const y = 0.16 + t * 0.62;
    layers.push(lumpy(new THREE.ConeGeometry(r, h, 9, 2).translate(0, y + h / 2, 0), 0.22, 11 + i));
  }
  return { trunk, crown: mergeGeometries(layers.map((g) => g.toNonIndexed())) };
}

// 広葉樹：幹と枝分かれ、その先の小さな葉の塊を不規則に集めた樹冠（輪郭がでこぼこになる）
export function broadleafGeometry() {
  const rand = mulberry32(31);
  const wood = [new THREE.CylinderGeometry(0.022, 0.04, 0.48, 7, 1).translate(0, 0.24, 0)];
  const blobs = [];
  // 主な枝 4 本と、その先の葉の塊
  for (let b = 0; b < 4; b++) {
    const a = (b / 4) * Math.PI * 2 + rand() * 0.6;
    const tilt = 0.5 + rand() * 0.35;
    const len = 0.2 + rand() * 0.08;
    const dir = new THREE.Vector3(Math.cos(a) * Math.sin(tilt), Math.cos(tilt), Math.sin(a) * Math.sin(tilt));
    const branch = new THREE.CylinderGeometry(0.008, 0.016, len, 5, 1).translate(0, len / 2, 0);
    branch.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir));
    branch.translate(0, 0.4, 0);
    wood.push(branch);
  }
  // 樹冠：楕円体の中にばらまいた小さな塊（中心は詰め、外側はまばら）
  for (let i = 0; i < 22; i++) {
    const u = rand() * 2 - 1, th = rand() * Math.PI * 2, rr = Math.cbrt(rand());
    const x = Math.sqrt(1 - u * u) * Math.cos(th) * rr * 0.3;
    const z = Math.sqrt(1 - u * u) * Math.sin(th) * rr * 0.3;
    const y = 0.66 + u * rr * 0.2;
    const r = 0.07 + rand() * 0.07;
    blobs.push(lumpy(new THREE.IcosahedronGeometry(r, 1).translate(x, y, z), 0.45, 50 + i));
  }
  return { trunk: mergeGeometries(wood.map((g) => g.toNonIndexed())), crown: mergeGeometries(blobs.map((g) => g.toNonIndexed())) };
}

// 草の株：根元から外へしなる細い葉を十数本
export function grassGeometry() {
  const rand = mulberry32(7);
  const blades = [];
  for (let i = 0; i < 18; i++) {
    const a = rand() * Math.PI * 2;
    const lean = 0.15 + rand() * 0.35;
    const h = 0.55 + rand() * 0.45;
    const w = 0.025 + rand() * 0.015;
    const segs = 3;
    const pos = [];
    const idx = [];
    for (let s = 0; s <= segs; s++) {
      const t = s / segs;
      const off = lean * t * t * h; // 先ほど外へしなる
      const cx = Math.cos(a) * (0.05 * rand() + off), cz = Math.sin(a) * (0.05 * rand() + off);
      const ww = w * (1 - t * 0.9);
      const px = -Math.sin(a) * ww, pz = Math.cos(a) * ww;
      pos.push(cx - px, t * h, cz - pz, cx + px, t * h, cz + pz);
      if (s < segs) {
        const b = s * 2;
        idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    blades.push(g.toNonIndexed());
  }
  return mergeGeometries(blades);
}

// 置き場所の一覧（[x, y, z, 大きさ, 向き] × n）から、インスタンスの行列と色のゆらぎを作る
export function fillInstances(mesh, list, colorVar, seed) {
  const n = list.length / 5;
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const rand = mulberry32(seed);
  const c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const k = i * 5;
    p.set(list[k], list[k + 1], list[k + 2]);
    q.setFromAxisAngle(up, list[k + 4]);
    const sz = list[k + 3];
    s.set(sz * (0.85 + rand() * 0.3), sz, sz * (0.85 + rand() * 0.3));
    m.compose(p, q, s);
    mesh.setMatrixAt(i, m);
    if (colorVar) {
      const v = 1 + (rand() - 0.5) * colorVar;
      c.setRGB(v * (1 + (rand() - 0.5) * 0.25), v, v * (1 - (rand() - 0.5) * 0.2));
      mesh.setColorAt(i, c);
    }
  }
  mesh.count = n;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingBox?.();
  mesh.computeBoundingSphere?.();
}
