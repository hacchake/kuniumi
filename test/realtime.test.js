import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createDefaultScene } from '../src/core/schema.js';
import { createVegetationRules, placeVegetation, treeAt, treeCellSize } from '../src/core/vegetation.js';
import { WalkControls } from '../src/render/WalkControls.js';
import { GpuTerrain } from '../src/render/GpuTerrain.js';
import { createCurveUniforms } from '../src/render/curvatureGLSL.js';

// 平らな坂の地形（標本・足元）
const slopeTerrain = { sample: (x, z) => ({ h: 100 + x * 0.05, slope: 0.05, wv: 0 }), height: (x) => 100 + x * 0.05 };

describe('木の配置：一枚絵とリアルタイムで同じ木', () => {
  it('一枚絵の配置に含まれる木は、格子ハッシュで同じ位置に立つ', () => {
    const s = createDefaultScene();
    const t = s.terrain;
    const rules = createVegetationRules({ heightScale: t.heightScale, baseHeight: t.baseHeight, waterLevel: 0, waterEnabled: true, palette: t.palette, vegetation: { ...s.vegetation, trees: 1 } });
    const view = { position: [0, 140, 300], target: [0, 100, 0], fov: 50, aspect: 1.6, height: 720 };
    const still = placeVegetation(rules, t.size, slopeTerrain.sample, slopeTerrain.height, view, { maxGrass: 0 });
    const all = [...still.conifer, ...still.broadleaf];
    expect(all.length).toBeGreaterThan(50);
    // 一枚絵の木の 1 本目を、リアルタイム側（treeAt）で同じ格子から引き直す
    const cell = treeCellSize(rules.veg);
    let matched = 0;
    for (let k = 0; k < Math.min(all.length, 200); k += 5) {
      const i = Math.floor(all[k] / cell), j = Math.floor(all[k + 2] / cell);
      const tr = treeAt(i, j, rules, t.size, slopeTerrain.sample, slopeTerrain.height);
      // 一枚絵の配列は Float32 なので、その精度で比べる
      if (tr && Math.fround(tr.x) === all[k] && Math.fround(tr.z) === all[k + 2] && Math.fround(tr.h) === all[k + 3]) matched++;
    }
    expect(matched).toBe(Math.min(all.length, 200) / 5);
  });
});

describe('歩くモード', () => {
  const cam = () => {
    const c = new THREE.PerspectiveCamera();
    c.position.set(0, 300, 0);
    c.lookAt(1, 300, 0);
    return c;
  };
  const canvas = { addEventListener() {}, requestPointerLock() {} };
  it('地面に降り、坂を歩いても目の高さを保つ', () => {
    globalThis.document ??= { addEventListener() {}, pointerLockElement: null };
    globalThis.window ??= { addEventListener() {} };
    const c = cam();
    const w = new WalkControls(c, canvas, { groundAt: slopeTerrain.height });
    w.enter('walk');
    expect(c.position.y).toBeCloseTo(100 + 1.65, 5);
    w.keys.add('KeyW');
    for (let i = 0; i < 100; i++) w.update(0.05); // 5 秒
    expect(c.position.x).toBeGreaterThan(6); // 1.5 m/s 前後
    expect(c.position.y - slopeTerrain.height(c.position.x)).toBeCloseTo(1.65, 2);
  });
  it('ジャンプして着地する・飛ぶと上昇する', () => {
    const c = cam();
    const w = new WalkControls(c, canvas, { groundAt: () => 0 });
    w.enter('walk');
    w.keys.add('Space');
    w.update(0.05);
    w.keys.clear();
    let top = 0;
    for (let i = 0; i < 40; i++) {
      w.update(0.05);
      top = Math.max(top, c.position.y);
    }
    expect(top).toBeGreaterThan(2.2);
    expect(c.position.y).toBeCloseTo(1.65, 5);
    w.toggleMode();
    w.keys.add('Space');
    for (let i = 0; i < 20; i++) w.update(0.05);
    expect(c.position.y).toBeGreaterThan(5);
  });
  it('当たり判定で押し戻される', () => {
    const c = cam();
    const w = new WalkControls(c, canvas, { groundAt: () => 0, collide: (p) => { if (p.x > 3) p.x = 3; } });
    w.enter('walk');
    w.keys.add('KeyW');
    for (let i = 0; i < 100; i++) w.update(0.05);
    expect(c.position.x).toBeLessThanOrEqual(3);
  });
});

describe('GPU 地形（CPU 側の計算）', () => {
  const make = (size) => {
    const res = 65;
    const field = new Float32Array(res * res);
    for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) field[j * res + i] = i / (res - 1); // 東へ上る坂
    const g = new GpuTerrain({ curveUniforms: createCurveUniforms() });
    g.setField(field, res, null);
    const s = createDefaultScene();
    s.terrain.size = size;
    s.terrain.heightScale = 1000;
    s.terrain.baseHeight = 0;
    g.setScene(s);
    return g;
  };
  it('高さと光線の交点', () => {
    const g = make(8000);
    expect(g.heightAt(0, 0)).toBeCloseTo(500, 3);
    expect(g.heightAt(4000, 0)).toBeCloseTo(1000, 3);
    const hit = g.raycast(new THREE.Vector3(0, 2000, 0), new THREE.Vector3(0, -1, 0), 1e5);
    expect(hit.y).toBeCloseTo(500, 0);
  });
  it('数千 km の大地でも区画の数は上限内、カメラの近くほど細かい', () => {
    const g = make(4000e3);
    const cam = new THREE.PerspectiveCamera(50, 1.6, 1, 1e8);
    g.curveUniforms.kCamPos.value.set(0, 2000, 0);
    g.curveUniforms.kPlanetR.value = 6371000;
    cam.position.set(0, 2000, 0);
    cam.lookAt(1000, 1500, 0);
    cam.updateMatrixWorld();
    g.update(cam, new THREE.Vector2(0, 0));
    const n = g.geometry.instanceCount;
    expect(n).toBeGreaterThan(20);
    expect(n).toBeLessThan(4000);
    const a = g.geometry.attributes.aNode.array;
    let minSize = Infinity, maxSize = 0;
    for (let k = 0; k < n; k++) {
      minSize = Math.min(minSize, a[k * 4 + 2]);
      maxSize = Math.max(maxSize, a[k * 4 + 2]);
    }
    expect(minSize).toBeLessThan(100); // 足元は 100 m 未満の区画（格子 3 m 未満）
    expect(maxSize).toBeGreaterThan(100e3); // 遠くは 100 km 以上の区画
  });
});
