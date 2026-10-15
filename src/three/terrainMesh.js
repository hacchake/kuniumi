import * as THREE from 'three';
import { generateMaterialMaps } from '../core/texgen.js';

// 高さ場 → 地形メッシュ。リアルタイム表示と書き出し用シーンの両方で使う。

export function createTerrainGeometry(res) {
  const geo = new THREE.BufferGeometry();
  const count = res * res;
  const pos = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const k = j * res + i;
      uv[k * 2] = i / (res - 1);
      uv[k * 2 + 1] = 1 - j / (res - 1); // 画像の上（行0）= 北 = v=1
    }
  }
  const IndexArray = count > 65535 ? Uint32Array : Uint16Array;
  const index = new IndexArray((res - 1) * (res - 1) * 6);
  let n = 0;
  for (let j = 0; j < res - 1; j++) {
    for (let i = 0; i < res - 1; i++) {
      const a = j * res + i;
      const b = a + 1;
      const c = a + res;
      const d = c + 1;
      index[n++] = a; index[n++] = c; index[n++] = b;
      index[n++] = b; index[n++] = c; index[n++] = d;
    }
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  geo.userData.res = res;
  return geo;
}

// 高さ・大きさを反映（解像度が同じなら頂点配列を使い回す）
export function applyHeights(geo, field, res, terrain) {
  const { size, heightScale, baseHeight } = terrain;
  const pos = geo.attributes.position.array;
  for (let j = 0; j < res; j++) {
    const z = (j / (res - 1) - 0.5) * size;
    for (let i = 0; i < res; i++) {
      const k = j * res + i;
      pos[k * 3] = (i / (res - 1) - 0.5) * size;
      pos[k * 3 + 1] = baseHeight + field[k] * heightScale;
      pos[k * 3 + 2] = z;
    }
  }
  geo.attributes.position.needsUpdate = true;
  computeGridNormals(geo, field, res, terrain);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
}

// 格子の中心差分で法線を出す（computeVertexNormals より速く、継ぎ目も出ない）
function computeGridNormals(geo, field, res, { size, heightScale }) {
  const nrm = geo.attributes.normal.array;
  const cell = size / (res - 1);
  for (let j = 0; j < res; j++) {
    const jm = Math.max(j - 1, 0), jp = Math.min(j + 1, res - 1);
    for (let i = 0; i < res; i++) {
      const im = Math.max(i - 1, 0), ip = Math.min(i + 1, res - 1);
      const dx = (field[j * res + ip] - field[j * res + im]) * heightScale / ((ip - im) * cell);
      const dz = (field[jp * res + i] - field[jm * res + i]) * heightScale / ((jp - jm) * cell);
      const len = Math.hypot(dx, 1, dz);
      const k = (j * res + i) * 3;
      nrm[k] = -dx / len;
      nrm[k + 1] = 1 / len;
      nrm[k + 2] = -dz / len;
    }
  }
  geo.attributes.normal.needsUpdate = true;
}

// ワーカーが焼いた RGBA を canvas テクスチャにする（glTF 書き出しでもそのまま PNG になる）
export function createColorTexture(rgba, size, existing) {
  let tex = existing;
  if (!tex || tex.image.width !== size) {
    tex?.dispose();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    tex.name = 'TerrainColor';
  }
  const ctx = tex.image.getContext('2d');
  ctx.putImageData(new ImageData(rgba, size, size), 0, 0);
  tex.needsUpdate = true;
  return tex;
}

// 近景で効く細かな岩の凹凸。DETAIL_TILE m ごとに繰り返す法線マップ（地形全体で共有）
export const DETAIL_TILE = 48;
let detailNormal = null;
export function terrainDetailNormal() {
  if (!detailNormal) {
    const maps = generateMaterialMaps({ pattern: 'rock', color: '#808080', color2: '#808080', scale: 4, seed: 7, bump: 0.7 }, 512, 512);
    const c = document.createElement('canvas');
    c.width = c.height = 512;
    c.getContext('2d').putImageData(new ImageData(maps.normal, 512, 512), 0, 0);
    detailNormal = new THREE.CanvasTexture(c);
    detailNormal.wrapS = detailNormal.wrapT = THREE.RepeatWrapping;
    detailNormal.anisotropy = 8;
    detailNormal.name = 'TerrainDetailNormal';
  }
  return detailNormal;
}

export function createTerrainMaterial(map, size = 8000) {
  const normalMap = terrainDetailNormal();
  normalMap.repeat.set(size / DETAIL_TILE, size / DETAIL_TILE);
  return new THREE.MeshStandardMaterial({
    name: 'Terrain',
    map,
    normalMap,
    normalScale: new THREE.Vector2(0.55, 0.55),
    roughness: 0.92,
    metalness: 0,
  });
}
