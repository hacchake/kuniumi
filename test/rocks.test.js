import { describe, it, expect } from 'vitest';
import { createDefaultScene } from '../src/core/schema.js';
import { buildLodTerrain } from '../src/core/terrainLod.js';
import { createTerrainSurface } from '../src/core/terrainSurface.js';

// 一枚絵の岩と石：転がり落ちる急な斜面や段の縁には置かず、足元のいちばん低い所に沈める
describe('一枚絵の岩の置き場所', () => {
  it('岩は足元の傾きが緩い所にだけあり、地面から浮いていない', () => {
    const s = createDefaultScene();
    const surf = createTerrainSurface(s.terrain, null, s.water.enabled ? s.water.level : null);
    const H = (x, z) => surf.heightAt(x, z, 0.5);
    // 斜面の多い所の地面近くに立つ（岩は 300 m 以内に置かれる）
    const C = [-2300, 0, 2700];
    C[1] = Math.max(H(C[0], C[2]), s.water.level) + 2;
    const view = { position: C, target: [C[0] + 200, C[1] - 20, C[2] - 150], fov: 60, aspect: 16 / 9, height: 360 };
    const r = buildLodTerrain(s.terrain, s.water, view, { maxTriangles: 300_000, vegetation: s.vegetation });
    const R = r.plants.rocks;
    expect(R.length / 5).toBeGreaterThan(20);
    let worstSlope = 0, worstFloat = 0;
    for (let k = 0; k < R.length; k += 5) {
      const [x, y, z, size] = [R[k], R[k + 1], R[k + 2], R[k + 3]];
      const rr = size * 0.5;
      const hs = [H(x, z), H(x + rr, z), H(x - rr, z), H(x, z + rr), H(x, z - rr)];
      const lo = Math.min(...hs), hi = Math.max(...hs);
      worstSlope = Math.max(worstSlope, (hi - lo) / (2 * rr));
      worstFloat = Math.max(worstFloat, y - lo); // 岩の底が足元のいちばん低い所より上にあるか
    }
    expect(worstSlope).toBeLessThanOrEqual(0.46);
    expect(worstFloat).toBeLessThanOrEqual(0);
  });
});
