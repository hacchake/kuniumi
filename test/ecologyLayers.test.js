import { describe, it, expect } from 'vitest';
import { createDefaultScene } from '../src/core/schema.js';
import { createTerrainSurface } from '../src/core/terrainSurface.js';
import { createVegetationRules, treeAt, treeCellSize } from '../src/core/vegetation.js';

// 植生の層：木の間隔・生える高さの範囲が効く
describe('植生の層', () => {
  const s = createDefaultScene();
  const t = s.terrain;
  const surf = createTerrainSurface(t, null, s.water.level);
  const h = (x, z) => surf.heightAt(x, z, 1);
  const count = (veg) => {
    const rules = createVegetationRules({ heightScale: t.heightScale, baseHeight: t.baseHeight, waterLevel: s.water.level, waterEnabled: true, palette: t.palette, vegetation: { ...s.vegetation, ...veg }, size: t.size });
    const cell = treeCellSize(rules.veg);
    let n = 0, hi = 0;
    const N = Math.floor(1500 / cell);
    for (let j = -N; j < N; j++)
      for (let i = -N; i < N; i++) {
        const tr = treeAt(i, j, rules, t.size, surf.coarse, h);
        if (!tr) continue;
        n++;
        hi = Math.max(hi, (tr.y - s.water.level) / (t.baseHeight + t.heightScale - s.water.level));
      }
    return { n, hi };
  };
  const base = count({});
  it('既定値では今までどおり木が立つ', () => expect(base.n).toBeGreaterThan(100));
  it('間隔を広げると木が減る', () => expect(count({ treeSpacing: 2 }).n).toBeLessThan(base.n * 0.4));
  it('生える高さの上限より上には木が立たない', () => {
    const r = count({ treeAltMax: 0.2 });
    expect(r.n).toBeLessThan(base.n);
    expect(r.hi).toBeLessThan(0.24);
  });
});
