import { describe, it, expect } from 'vitest';
import { createDefaultScene } from '../src/core/schema.js';
import { mixHeightmap } from '../src/core/heightmapMix.js';

// ハイトマップにノイズを重ねる・雨で削る
describe('ハイトマップに重ねる', () => {
  const W = 65, H = 49;
  const data = new Float32Array(W * H);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) data[j * W + i] = 0.2 + 0.6 * Math.exp(-((i - 32) ** 2 + (j - 24) ** 2) / 300);
  const img = { data, width: W, height: H };
  const terrainWith = (mix) => ({ ...createDefaultScene().terrain, mode: 'heightmap', heightmapMix: mix });
  const diff = (a, b) => a.reduce((s, v, k) => s + Math.abs(v - b[k]), 0) / a.length;

  it('重ねないときは元の画像のまま', () => {
    const r = mixHeightmap(img, terrainWith({ mode: 'none', amount: 0.5, erode: false }));
    expect(r.img).toBe(img);
    expect(r.wear).toBeNull();
  });
  it('どの重ね方でも形が変わり、0..1 に収まり、大きさは同じ', () => {
    for (const mode of ['add', 'multiply', 'max', 'min']) {
      const r = mixHeightmap(img, terrainWith({ mode, amount: 0.5, erode: false }));
      expect(r.img.width).toBe(W);
      expect(r.img.data.length).toBe(W * H);
      expect(diff(r.img.data, data)).toBeGreaterThan(0.005);
      expect(Math.min(...r.img.data)).toBeGreaterThanOrEqual(0);
      expect(Math.max(...r.img.data)).toBeLessThanOrEqual(1);
    }
    // 高い方は元より下がらず、低い方は元より上がらない
    const mx = mixHeightmap(img, terrainWith({ mode: 'max', amount: 1, erode: false })).img.data;
    const mn = mixHeightmap(img, terrainWith({ mode: 'min', amount: 1, erode: false })).img.data;
    for (let k = 0; k < data.length; k++) {
      expect(mx[k]).toBeGreaterThanOrEqual(data[k] - 1e-6);
      expect(mn[k]).toBeLessThanOrEqual(data[k] + 1e-6);
    }
  });
  it('雨で削ると侵食の量（wear）が返る', () => {
    const r = mixHeightmap(img, terrainWith({ mode: 'none', amount: 0, erode: true }));
    expect(r.wear).not.toBeNull();
    expect(diff(r.img.data, data)).toBeGreaterThan(0);
  });
});
