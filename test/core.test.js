import { describe, it, expect } from 'vitest';
import { createDefaultScene, normalizeScene, setIn, getIn } from '../src/core/schema.js';
import { createStore } from '../src/core/store.js';
import { createHistory } from '../src/core/history.js';
import { encodeGray16, decodePng } from '../src/core/png16.js';
import { generateNoiseField } from '../src/core/heightfield.js';
import { applyErosion } from '../src/core/erosion.js';
import { skyParams, renderSkyEquirect, sunIrradiance, discScaleFor } from '../src/core/skyModel.js';
import { sunDirection, anglesFromDirection, moonAge, moonDirection, moonIllumination } from '../src/core/sun.js';
import { buildLodTerrain } from '../src/core/terrainLod.js';
import { toneMapToRGBA8 } from '../src/core/tonemap.js';
import { createObject, normalizeObject } from '../src/core/objects.js';

describe('シーン JSON', () => {
  it('既定値で欠けた項目を補う', () => {
    const s = normalizeScene({ format: 'kuniumi.scene', version: 1, sun: { elevation: 5 } });
    expect(s.sun.elevation).toBe(5);
    expect(s.sun.azimuth).toBe(createDefaultScene().sun.azimuth);
    expect(s.objects).toEqual([]);
    expect(s.vegetation.trees).toBeGreaterThan(0);
  });
  it('別形式の JSON は拒む', () => {
    expect(() => normalizeScene({ format: 'other' })).toThrow();
  });
  it('雲の項目が無い古いシーンは露出を換算する', () => {
    const s = normalizeScene({ format: 'kuniumi.scene', atmosphere: { exposure: 0.5 } });
    expect(s.atmosphere.exposure).toBeCloseTo(0.125, 3);
  });
  it('解像度は用意した値に丸める', () => {
    expect(normalizeScene({ terrain: { resolution: 300 } }).terrain.resolution).toBe(257);
  });
  it('setIn は元を書き換えない', () => {
    const a = createDefaultScene();
    const b = setIn(a, 'sun.elevation', 77);
    expect(getIn(a, 'sun.elevation')).not.toBe(77);
    expect(getIn(b, 'sun.elevation')).toBe(77);
    expect(b.terrain).toBe(a.terrain); // 変えていない枝は共有
  });
  it('物体は既定値で補われる', () => {
    const o = normalizeObject({ type: 'box', position: [1, 2] });
    expect(o.position).toEqual([0, 0, 0]);
    expect(createObject('torus').type).toBe('torus');
  });
});

describe('元に戻す／やり直す', () => {
  it('連続した同じ項目の変更は 1 回分、視点は含めない', async () => {
    const store = createStore(createDefaultScene());
    const h = createHistory(store);
    for (let v = 1000; v <= 1500; v += 100) store.set('terrain.heightScale', v, { source: 'ui' });
    store.set('camera.fov', 30, { source: 'view' });
    store.set('sun.elevation', 40, { source: 'ui' });
    expect(h.undo()).toBe(true);
    expect(store.get().sun.elevation).toBe(createDefaultScene().sun.elevation);
    expect(store.get().camera.fov).toBe(30); // 視点はそのまま
    h.undo();
    expect(store.get().terrain.heightScale).toBe(createDefaultScene().terrain.heightScale);
    h.redo();
    expect(store.get().terrain.heightScale).toBe(1500);
  });
});

describe('16bit PNG', () => {
  it('書いて読むと 16bit の精度で一致し、文字情報も戻る', async () => {
    const w = 37, h = 23;
    const v = new Float32Array(w * h).map((_, i) => (i * 7919) % 65536 / 65535);
    const blob = await encodeGray16(v, w, h, { kuniumi: '{"size":8000,"名":"星"}' });
    const img = await decodePng(await blob.arrayBuffer());
    expect(img.width).toBe(w);
    expect(img.bitDepth).toBe(16);
    let err = 0;
    for (let i = 0; i < v.length; i++) err = Math.max(err, Math.abs(img.data[i] - v[i]));
    expect(err).toBeLessThan(1 / 65535 + 1e-9);
    // 日本語は \uXXXX に逃がして書いてあり、JSON.parse がそのまま元に戻す
    const info = JSON.parse(img.text.kuniumi);
    expect(info.size).toBe(8000);
    expect(info['名']).toBe('星');
  });
});

describe('地形', () => {
  const noise = createDefaultScene().terrain.noise;
  it('同じ設定なら同じ地形（再現性）', () => {
    const a = generateNoiseField(noise, 65), b = generateNoiseField(noise, 65);
    expect(a).toEqual(b);
    expect(Math.min(...a)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...a)).toBeLessThanOrEqual(1);
  });
  it('外周の沈みがあれば四辺は底まで下がる', () => {
    const res = 129, f = generateNoiseField(noise, res);
    for (let i = 0; i < res; i++) {
      expect(f[i]).toBeLessThan(1e-6);
      expect(f[(res - 1) * res + i]).toBeLessThan(1e-6);
    }
  });
  it('侵食は解像度によらず同じ量になり、値は範囲内', () => {
    const f1 = generateNoiseField(noise, 129), f2 = generateNoiseField(noise, 257);
    const m = (f, r) => {
      const { wear } = applyErosion(f, r, 0.5, noise.seed);
      return wear.reduce((s, x) => s + Math.abs(x), 0) / wear.length;
    };
    expect(m(f1, 129)).toBeCloseTo(m(f2, 257), 2);
  });
  it('近いほど細かい地形は、区画の継ぎ目に隙間がない', () => {
    const s = createDefaultScene();
    const r = buildLodTerrain(s.terrain, s.water, { position: [-3300, 200, 3900], target: [-2300, 60, 2700], fov: 50, aspect: 16 / 9, height: 360 }, { maxTriangles: 600_000 });
    const seen = new Map();
    let worst = 0;
    for (let i = 0; i < r.positions.length; i += 3) {
      const key = `${r.positions[i].toFixed(2)},${r.positions[i + 2].toFixed(2)}`;
      const y = r.positions[i + 1];
      if (seen.has(key)) worst = Math.max(worst, Math.abs(seen.get(key) - y));
      else seen.set(key, y);
    }
    expect(worst).toBeLessThan(1e-3);
    expect(r.triangles).toBeLessThanOrEqual(600_000);
  });
});

describe('太陽と空', () => {
  it('方位と高度の変換は往復で一致', () => {
    const { elevation, azimuth } = anglesFromDirection(sunDirection(23, 211));
    expect(elevation).toBeCloseTo(23, 6);
    expect(azimuth).toBeCloseTo(211, 6);
  });
  it('全天画像の太陽円盤の明るさの総量は、円盤を広げても解析値と一致', () => {
    const a = createDefaultScene().atmosphere;
    const sd = sunDirection(35, 140);
    const p = skyParams(a, sd);
    const k = discScaleFor(Math.max(...sunIrradiance(p)));
    const W = 1024, H = 512;
    const env = renderSkyEquirect(p, W, H, { clouds: false, discScale: k });
    let E = 0, max = 0;
    for (let r = 0; r < H; r++) {
      const lat = ((r + 0.5) / H - 0.5) * Math.PI;
      for (let c = 0; c < W; c++) {
        const phi = ((c + 0.5) / W - 0.5) * 2 * Math.PI;
        const d = [Math.cos(phi) * Math.cos(lat), Math.sin(lat), Math.sin(phi) * Math.cos(lat)];
        const cs = d[0] * sd[0] + d[1] * sd[1] + d[2] * sd[2];
        const o = (r * W + c) * 4;
        max = Math.max(max, env[o], env[o + 1], env[o + 2]);
        if (cs > 0.998) E += env[o + 1] * cs * Math.cos(lat) * (Math.PI / H) * ((2 * Math.PI) / W);
      }
    }
    expect(E / sunIrradiance(p)[1]).toBeGreaterThan(0.97);
    expect(E / sunIrradiance(p)[1]).toBeLessThan(1.08);
    expect(max).toBeLessThan(65504); // パストレーサの半精度に収まる
  });
});

describe('トーンマップ', () => {
  it('黒は黒、明るいほど明るく、範囲内', () => {
    const hdr = new Float32Array([0, 0, 0, 1, 0.1, 0.1, 0.1, 1, 10, 10, 10, 1]);
    const out = toneMapToRGBA8(hdr, 3, 1);
    expect(out[0]).toBeLessThan(3);
    expect(out[4]).toBeGreaterThan(out[0]);
    expect(out[8]).toBeGreaterThan(out[4]);
    expect(out[8]).toBeLessThanOrEqual(255);
  });
});

describe('実際の太陽の位置', () => {
  it('東京・夏至の正午ごろは南の高い空、春分の日の出は東', async () => {
    const { solarPosition } = await import('../src/core/sun.js');
    const noon = solarPosition(35.68, 139.77, new Date(Date.UTC(2026, 5, 21, 2, 40)));
    expect(noon.elevation).toBeGreaterThan(75);
    expect(Math.abs(noon.azimuth - 180)).toBeLessThan(15);
    const rise = solarPosition(35.68, 139.77, new Date(Date.UTC(2026, 2, 20, 20, 45)));
    expect(Math.abs(rise.elevation)).toBeLessThan(3);
    expect(Math.abs(rise.azimuth - 90)).toBeLessThan(5);
    expect(solarPosition(35.68, 139.77, new Date(Date.UTC(2026, 5, 21, 15, 0))).elevation).toBeLessThan(-20); // 真夜中
  });
});

describe('月', () => {
  it('月齢：既知の満月・新月の日に合う', () => {
    // 2024-04-08 18:21 UTC は新月（皆既日食）、2024-04-24 00:49 UTC は満月
    const n = moonAge(new Date(Date.UTC(2024, 3, 8, 18, 21)));
    expect(Math.min(n, 29.53 - n)).toBeLessThan(0.7);
    expect(Math.abs(moonAge(new Date(Date.UTC(2024, 3, 24, 0, 49))) - 14.77)).toBeLessThan(0.8);
    expect(moonIllumination(0)).toBeCloseTo(0, 5);
    expect(moonIllumination(14.765)).toBeCloseTo(1, 3);
  });
  it('日没直後：満月は東の地平線、上弦は南の高い空', () => {
    const sun = sunDirection(-3, 270);
    const full = anglesFromDirection(moonDirection(sun, 14.77));
    expect(Math.abs(full.elevation)).toBeLessThan(6);
    expect(Math.abs(full.azimuth - 90)).toBeLessThan(10);
    const q = anglesFromDirection(moonDirection(sun, 7.38));
    expect(q.elevation).toBeGreaterThan(35);
    expect(Math.abs(q.azimuth - 180)).toBeLessThan(30);
  });
});

describe('空の飾り（一枚絵用）', () => {
  it('オーロラは北の空に出て、南の空・地平線の下には出ない', async () => {
    const { addAurora } = await import('../src/core/skyExtras.js');
    const sum = (d, north = 1) => {
      const o = [0, 0, 0];
      for (let t = 0; t < 20; t++) addAurora(d, north, t * 7, o);
      return o[0] + o[1] + o[2];
    };
    const el = (25 * Math.PI) / 180;
    const N = [0, Math.sin(el), -Math.cos(el)], S = [0, Math.sin(el), Math.cos(el)];
    expect(sum(N)).toBeGreaterThan(0.5);
    expect(sum(S)).toBeLessThan(sum(N) * 0.05);
    expect(sum(S, -1)).toBeGreaterThan(0.5); // 南半球では南の空
    expect(sum([0, -0.3, -0.95])).toBe(0);
  });
  it('虹は太陽と反対の点から約 41° の輪で、外側が赤・内側が青', async () => {
    const { addRainbow } = await import('../src/core/skyExtras.js');
    const at = (deg) => {
      const r = (deg * Math.PI) / 180;
      const o = [0, 0, 0];
      addRainbow([Math.sin(r), Math.cos(r), 0], [0, 1, 0], o);
      return o;
    };
    expect(at(42.2)[0]).toBeGreaterThan(at(42.2)[2]);
    expect(at(40.7)[2]).toBeGreaterThan(at(40.7)[0]);
    expect(at(46)[0] + at(46)[1] + at(46)[2]).toBeLessThan(0.05); // 暗い帯
  });
});

describe('EXR', () => {
  it('半精度への変換', async () => {
    const { toHalf } = await import('../src/core/exr.js');
    expect(toHalf(1)).toBe(0x3c00);
    expect(toHalf(-2)).toBe(0xc000);
    expect(toHalf(0.5)).toBe(0x3800);
    expect(toHalf(65504)).toBe(0x7bff);
    expect(toHalf(1e6)).toBe(0x7c00);
    expect(toHalf(0)).toBe(0);
  });
  it('three.js の EXRLoader で読み戻せる（色と上下の向き）', async () => {
    const { encodeEXR } = await import('../src/core/exr.js');
    const { EXRLoader } = await import('three/examples/jsm/loaders/EXRLoader.js');
    const THREE = await import('three');
    const W = 3, H = 2;
    const hdr = new Float32Array(W * H * 4);
    for (let i = 0; i < W * H; i++) hdr.set([i * 0.5, 2, 10 + i, 1], i * 4);
    const buf = await encodeEXR(hdr, W, H).arrayBuffer();
    const r = new EXRLoader().setDataType(THREE.FloatType).parse(buf);
    expect(r.width).toBe(W);
    expect(r.height).toBe(H);
    // EXRLoader は下の行から並べ直す：画像の上の行（i = 0..2）は data の最後の行
    const px = (x, yFromTop) => {
      const row = H - 1 - yFromTop;
      const k = (row * W + x) * 4;
      return [r.data[k], r.data[k + 1], r.data[k + 2]];
    };
    expect(px(0, 0)).toEqual([0, 2, 10]);
    expect(px(2, 1)).toEqual([2.5, 2, 15]);
  });
});

describe('手彫り', () => {
  it('盛る・削る・ならすが、世界座標の所に効く', async () => {
    const { applySculpt, sculptKey } = await import('../src/core/sculpt.js');
    const res = 101, size = 1000;
    const terrain = { size, heightScale: 100, baseHeight: 0, sculpt: [{ x: 0, z: 0, r: 100, h: 50 }] };
    const f = applySculpt(new Float32Array(res * res), res, terrain);
    expect(f[50 * res + 50]).toBeCloseTo(0.5, 5); // 中心で +50 m
    expect(f[50 * res + 62]).toBe(0); // 半径の外（120 m 東）は変わらない
    expect(f[50 * res + 55]).toBeGreaterThan(0.2); // 50 m 東は途中
    // 東へ 200 m・北へ 100 m（z = -100）を削る
    const g = applySculpt(new Float32Array(res * res).fill(0.5), res, { ...terrain, sculpt: [{ x: 200, z: -100, r: 60, h: -20 }] });
    expect(g[40 * res + 70]).toBeCloseTo(0.3, 5);
    // ならす：高さ 30 m へ全部寄せる
    const n = applySculpt(new Float32Array(res * res).fill(0.9), res, { ...terrain, sculpt: [{ x: 0, z: 0, r: 80, flat: 30, k: 1 }] });
    expect(n[50 * res + 50]).toBeCloseTo(0.3, 5);
    expect(sculptKey([])).toBe('');
    expect(sculptKey(terrain.sculpt)).not.toBe(sculptKey([{ x: 0, z: 0, r: 100, h: 51 }]));
  });
});

describe('手彫り：なめらかに', () => {
  it('尖った所が低くなり、範囲の外は変わらない', async () => {
    const { applySculpt } = await import('../src/core/sculpt.js');
    const res = 101;
    const f = new Float32Array(res * res);
    f[50 * res + 50] = 1; // 1 格子だけの尖り
    f[50 * res + 90] = 1; // 範囲の外
    applySculpt(f, res, { size: 1000, heightScale: 100, baseHeight: 0, sculpt: [{ x: 0, z: 0, r: 200, smooth: 1 }] });
    expect(f[50 * res + 50]).toBeLessThan(0.5);
    expect(f[50 * res + 51]).toBeGreaterThan(0);
    expect(f[50 * res + 90]).toBe(1);
  });
});
