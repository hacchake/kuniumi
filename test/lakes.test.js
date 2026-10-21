import { describe, it, expect } from 'vitest';
import { fillDepressions, findLakes, lakeMeshData, lakeLevelAt } from '../src/core/lakes.js';

// 窪地の湖：流れ出られない窪地にだけ水がたまる
describe('窪地の湖', () => {
  // 外周へ下る斜面の中に、縁の高さ 0.6・底 0.2 のすり鉢がひとつ
  const res = 65;
  const field = new Float32Array(res * res);
  for (let j = 0; j < res; j++)
    for (let i = 0; i < res; i++) {
      const r = Math.hypot(i - 32, j - 32);
      field[j * res + i] = r < 12 ? 0.2 + 0.4 * (r / 12) ** 2 : Math.max(0, 0.6 - (r - 12) * 0.02);
    }
  const filled = fillDepressions(field, res);
  const opts = { baseHeight: 0, heightScale: 1000 };

  it('すり鉢はあふれる縁の高さまで埋まり、外の斜面は埋まらない', () => {
    // 縁は格子の上で少し低く取れる（0.6 の円を格子点で拾うため）
    const spill = filled[32 * res + 32];
    expect(spill).toBeGreaterThan(0.55);
    expect(spill).toBeLessThanOrEqual(0.6);
    expect(filled[32 * res + 60]).toBeCloseTo(field[32 * res + 60], 6);
  });
  it('満たす割合で水面の高さが変わる', () => {
    const full = findLakes(field, filled, res, { ...opts, amount: 1 });
    const half = findLakes(field, filled, res, { ...opts, amount: 0.5 });
    expect(full.lakes.length).toBe(1);
    const spill = filled[32 * res + 32] * 1000;
    expect(full.lakes[0].level).toBeCloseTo(spill, 1);
    expect(half.lakes[0].level).toBeCloseTo((200 + spill) / 2, 1);
    expect(lakeLevelAt(full, 64, 0, 0)).toBeCloseTo(spill, 1);
  });
  it('海の方が高ければ湖にしない', () => {
    expect(findLakes(field, filled, res, { ...opts, amount: 1, sea: 700 }).lakes.length).toBe(0);
  });
  it('水面は岸の内側だけ（地面より下には張らない所がない）', () => {
    const g = findLakes(field, filled, res, { ...opts, amount: 0.5 });
    const m = lakeMeshData(g, 64);
    expect(m.length).toBeGreaterThan(0);
    for (let k = 0; k < m.length; k += 3) {
      // 頂点の地面の高さ（双一次補間）は水面以上にならない（岸の点はちょうど水面）
      const u = (m[k] / 64 + 0.5) * (res - 1), v = (m[k + 2] / 64 + 0.5) * (res - 1);
      const i = Math.min(res - 2, Math.floor(u)), j = Math.min(res - 2, Math.floor(v)), fx = u - i, fy = v - j;
      const f = (a, b) => field[b * res + a];
      const h = ((f(i, j) * (1 - fx) + f(i + 1, j) * fx) * (1 - fy) + (f(i, j + 1) * (1 - fx) + f(i + 1, j + 1) * fx) * fy) * 1000;
      expect(h).toBeLessThanOrEqual(m[k + 1] + 25);
    }
  });
});
