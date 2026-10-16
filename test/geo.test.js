import { describe, it, expect } from 'vitest';
import { aeqdForward, aeqdInverse, lonLatToTile, tileToLonLat, decodeTerrarium, chooseZoom, tilesFor, gridLonLat, sizeFromBBox } from '../src/core/geo.js';
import { curvePoint, curveNormal } from '../src/core/curvature.js';
import { detailHeight, detailBaseWavelength } from '../src/core/terrainDetail.js';
import { shoreBandOf } from '../src/core/vegetation.js';
import { normalizeScene, planetRadius, SIZE_MAX } from '../src/core/schema.js';

describe('地球の上の範囲（geo）', () => {
  it('正距方位図法は往復で元に戻る', () => {
    for (const [lat, lon] of [[35.36, 138.73], [-41, 173], [64.9, -18.7], [0, 179.9]]) {
      const { e, n } = aeqdForward(lat, lon, 36, 137);
      const p = aeqdInverse(e, n, 36, 137);
      expect(p.lat).toBeCloseTo(lat, 6);
      expect(((p.lon - lon + 540) % 360) - 180).toBeCloseTo(0, 6);
    }
  });
  it('中心からの距離がそのまま保たれる（東京〜大阪 約 400 km）', () => {
    const { e, n } = aeqdForward(34.69, 135.5, 35.68, 139.77);
    expect(Math.hypot(e, n) / 1000).toBeGreaterThan(390);
    expect(Math.hypot(e, n) / 1000).toBeLessThan(410);
  });
  it('タイル座標と経緯度は往復する', () => {
    const t = lonLatToTile(138.73, 35.36, 10);
    const p = tileToLonLat(t.x, t.y, 10);
    expect(p.lon).toBeCloseTo(138.73, 8);
    expect(p.lat).toBeCloseTo(35.36, 8);
  });
  it('標高タイルの色から標高を出す', () => {
    expect(decodeTerrarium(128, 0, 0)).toBe(0);
    expect(decodeTerrarium(142, 192, 0)).toBe(3776); // 128*256 + 3776 = 36544 = 142*256 + 192
  });
  it('タイルの枚数を上限に収める', () => {
    const region = { lat: 36, lon: 137, size: 3000e3 };
    const z = chooseZoom(region, 4097, 400);
    expect(tilesFor(region, z).length).toBeLessThanOrEqual(400);
  });
  it('格子の行 0 は北、列 0 は西', () => {
    const r = { lat: 36, lon: 137, size: 100e3 };
    const nw = gridLonLat(0, 0, 5, r), se = gridLonLat(4, 4, 5, r);
    expect(nw.lat).toBeGreaterThan(se.lat);
    expect(nw.lon).toBeLessThan(se.lon);
  });
  it('外枠から範囲の大きさを出す', () => {
    expect(sizeFromBBox(35, 36, 138, 139) / 1000).toBeGreaterThan(100);
  });
});

describe('星の丸み', () => {
  it('近くでは d²/2R だけ下がる', () => {
    const R = 6371000;
    const p = curvePoint(10000, 0, 0, 0, 0, R);
    expect(p[1]).toBeCloseTo(-(10000 ** 2) / (2 * R), 2);
    expect(p[0]).toBeCloseTo(10000, 0);
  });
  it('R = 0 なら平らなまま', () => {
    expect(curvePoint(5, 6, 7, 0, 0, 0)).toEqual([5, 6, 7]);
  });
  it('地球の 1/4 周先は真下へ向く', () => {
    const R = 6371000;
    const p = curvePoint((Math.PI / 2) * R, 0, 0, 0, 0, R);
    expect(p[0]).toBeCloseTo(R, -1);
    expect(p[1]).toBeCloseTo(-R, -1);
    const n = curveNormal((Math.PI / 2) * R, 0, 0, 1, 0, 0, 0, R);
    expect(n[0]).toBeCloseTo(1, 6);
    expect(Math.hypot(...n)).toBeCloseTo(1, 9);
  });
});

describe('細部の起伏と水際', () => {
  it('同じ場所なら同じ高さ（GPU 版と格子を合わせる 2 の累乗の波長）', () => {
    expect(detailHeight(123.4, -56.7, 30, 1, 1)).toBe(detailHeight(123.4, -56.7, 30, 1, 1));
    expect(Math.log2(detailBaseWavelength(732))).toBe(Math.round(Math.log2(detailBaseWavelength(732))));
    expect(detailHeight(1, 2, 30, 1, 0)).toBe(0);
  });
  it('海底を含む地形でも水際の帯は広がりすぎない', () => {
    expect(shoreBandOf(14585, -9782, 0)).toBeLessThanOrEqual(30);
    expect(shoreBandOf(1200, -250, 0)).toBeCloseTo(11.4, 5);
  });
});

describe('シーン（大陸）', () => {
  it('大きさは上限で切り、星の既定は地球', () => {
    const s = normalizeScene({ terrain: { size: 1e9 } });
    expect(s.terrain.size).toBe(SIZE_MAX);
    expect(planetRadius(s)).toBe(6371000);
    expect(planetRadius(normalizeScene({ planet: { curvature: false } }))).toBe(0);
  });
});

describe('沿岸の海底を補う', () => {
  it('0 m の海は粗いデータの深さに、陸はそのまま', async () => {
    const { fillSeaFloor } = await import('../src/core/geo.js');
    const inner = new Float32Array([0, 50, 0, 0]);
    const outer = new Float32Array(9).fill(-800);
    const r = fillSeaFloor(inner, 2, 100, outer, 3, 600);
    expect(r[0]).toBeCloseTo(-800);
    expect(r[1]).toBe(50);
  });
  it('海につながらない 0 m 以下の低地（干拓地・水田）は海にしない', async () => {
    const { fillSeaFloor } = await import('../src/core/geo.js');
    // 5 × 5：左の列は海（粗いデータも海）、真ん中に陸で囲まれた −1 m の窪地、右下は海から陸続きに 0 m の点
    const res = 5, inner = new Float32Array(25).fill(3);
    for (let j = 0; j < 5; j++) inner[j * 5] = -0.2;
    inner[2 * 5 + 2] = -1; // 囲まれた窪地
    inner[4 * 5 + 1] = 0; // 海とつながる浅い所
    const outer = new Float32Array(9 * 9).fill(50);
    for (let j = 0; j < 9; j++) outer[j * 9] = -300; // 粗いデータでは西の端だけ海
    const r = fillSeaFloor(inner, res, 100, outer, 9, 100);
    expect(r[2 * 5 + 2]).toBe(1.5);
    expect(r[0]).toBeLessThan(-1);
    expect(r[4 * 5 + 1]).toBeLessThan(0);
    expect(r[1]).toBe(3);
  });
});

describe('範囲の縁を周りの地形へ寄せる', () => {
  it('縁は周りの高さ、内側はそのまま', async () => {
    const { featherToSurround } = await import('../src/core/geo.js');
    const res = 65, inner = new Float32Array(res * res).fill(1000);
    const outer = new Float32Array(9).fill(200);
    const r = featherToSurround(inner, res, 100, outer, 3, 600, 0.1);
    expect(r[0]).toBeCloseTo(200);
    expect(r[32 * res + 32]).toBe(1000);
    expect(r[32 * res + 3]).toBeGreaterThan(200);
    expect(r[32 * res + 3]).toBeLessThan(1000);
  });
});

describe('衛星写真（地表の色）', () => {
  const photoOf = (w, h, f) => {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) data.set([...f(i, j), 255], (j * w + i) * 4);
    return { data, width: w, height: h };
  };
  it('写真の (u, v) は v = 0 が北の行、色は線形に直す', async () => {
    const { photoAt } = await import('../src/io/photo.js');
    const ph = photoOf(4, 4, (i, j) => (j < 2 ? [255, 255, 255] : [0, 0, 0]));
    expect(photoAt(ph, 0.5, 0.05, [0, 0, 0])[0]).toBeCloseTo(1, 5);
    expect(photoAt(ph, 0.5, 0.95, [0, 0, 0])[0]).toBeCloseTo(0, 5);
    const mid = photoOf(2, 2, () => [128, 128, 128]);
    expect(photoAt(mid, 0.5, 0.5, [0, 0, 0])[1]).toBeCloseTo(0.2158, 3); // sRGB 128 → 線形 0.216
  });
  it('森らしさ：暗い緑は高く、街の灰色・明るい畑・水は低い', async () => {
    const { photoForest } = await import('../src/io/photo.js');
    const one = (rgb) => photoForest(photoOf(2, 2, () => rgb), 0.5, 0.5);
    expect(one([35, 70, 45])).toBeGreaterThan(0.8); // 森
    expect(one([120, 118, 115])).toBeLessThan(0.05); // 街
    expect(one([150, 190, 90])).toBeLessThan(0.1); // 明るい畑
    expect(one([30, 60, 80])).toBeLessThan(0.1); // 水
  });
  it('写真の一辺は細かさ 10 m を目安に 512〜4096', async () => {
    const { photoSizeFor } = await import('../src/ui/GeoDialog.js').catch(() => ({}));
    if (!photoSizeFor) return; // DOM の無い環境では UI を読めない
    expect(photoSizeFor(2000)).toBe(512);
    expect(photoSizeFor(20000)).toBe(2048);
    expect(photoSizeFor(3e6)).toBe(4096);
  });
});

describe('海か陸か（衛星写真も使う）', () => {
  it('写真で水に見えない 0 m 以下の低地は、海とつながっていても陸', async () => {
    const { fillSeaFloor } = await import('../src/core/geo.js');
    // 5 × 5 すべて 0 m 以下。粗いデータではどこも海。写真では左の 2 列だけ水、右の 3 列は水田
    const inner = new Float32Array(25).fill(-0.5);
    const outer = new Float32Array(9).fill(-300);
    const r = fillSeaFloor(inner, 5, 100, outer, 3, 600, (i) => i <= 1);
    expect(r[2 * 5 + 0]).toBeLessThan(-1); // 水の所は海（粗いデータの深さ）
    expect(r[2 * 5 + 3]).toBe(1.5); // 水田は陸
    // 写真を渡さなければ、これまでどおり全部海
    expect(fillSeaFloor(inner, 5, 100, outer, 3, 600)[2 * 5 + 3]).toBeLessThan(-1);
  });
  it('写真の水らしさ：開けた海は高く、水田・街は低い', async () => {
    const { photoWater } = await import('../src/io/photo.js');
    const one = (rgb) => {
      const data = new Uint8ClampedArray(16);
      for (let k = 0; k < 4; k++) data.set([...rgb, 255], k * 4);
      return photoWater({ data, width: 2, height: 2 }, 0.5, 0.5);
    };
    const enc = (v) => Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055));
    expect(one([0.03, 0.067, 0.074].map(enc))).toBeGreaterThan(0.8); // 瀬戸内海
    expect(one([0.067, 0.117, 0.098].map(enc))).toBeLessThan(0.1); // 水田
    expect(one([0.275, 0.275, 0.227].map(enc))).toBeLessThan(0.05); // 街
    expect(one([0.05, 0.25, 0.25].map(enc))).toBeGreaterThan(0.8); // 南の海の浅瀬（青緑）
    expect(one([0.112, 0.138, 0.117].map(enc))).toBeLessThan(0.1); // 干拓地
  });
});

describe('標高タイルのデータ無しを埋める', () => {
  it('−32768 m の画素は周りの値に、正しい値はそのまま', async () => {
    const { repairElevation } = await import('../src/core/geo.js');
    const a = new Float32Array(16).fill(5);
    a[5] = -32768;
    a[6] = -32768;
    repairElevation(a, 4);
    expect(a[5]).toBeGreaterThan(0);
    expect(a[6]).toBeGreaterThan(-3000);
    expect(a[0]).toBe(5);
  });
});

describe('標高タイルの偽の穴を埋める', () => {
  it('平野の小さな深い穴（縁の中途半端な値も）は埋め、山の起伏や深い海はそのまま', async () => {
    const { repairElevation } = await import('../src/core/geo.js');
    const N = 64;
    const a = new Float32Array(N * N).fill(2);
    // 平野の穴（中心 −22000、縁 −3000）
    a[20 * N + 20] = -22000;
    a[20 * N + 21] = -3000;
    a[21 * N + 20] = -1300;
    // 右下の区画は急な山（0〜1500 m の斜面）
    for (let j = 48; j < 64; j++) for (let i = 48; i < 64; i++) a[j * N + i] = (i - 48) * 100;
    // 左下の区画は深い海
    for (let j = 48; j < 64; j++) for (let i = 0; i < 16; i++) a[j * N + i] = -4000;
    repairElevation(a, N);
    expect(a[20 * N + 20]).toBeGreaterThan(-10);
    expect(a[20 * N + 21]).toBeGreaterThan(-10);
    expect(a[21 * N + 20]).toBeGreaterThan(-10);
    expect(a[50 * N + 48]).toBe(0); // 斜面の下端はそのまま
    expect(a[50 * N + 5]).toBe(-4000);
  });
});

describe('地名（OpenStreetMap）', () => {
  it('範囲の中の山・市・町だけを世界座標に、山は高い順', async () => {
    const { labelsFrom } = await import('../src/core/osmWater.js');
    const region = { lat: 36.3, lon: 137.64, size: 24000 };
    const els = [
      { type: 'node', lat: 36.2894, lon: 137.6481, tags: { natural: 'peak', name: '奥穂高岳', ele: '3190' } },
      { type: 'node', lat: 36.342, lon: 137.6476, tags: { natural: 'peak', name: '槍ヶ岳', ele: '3180' } },
      { type: 'node', lat: 35.0, lon: 135.0, tags: { place: 'city', name: '範囲の外' } },
      { type: 'node', lat: 36.2497, lon: 137.6385, tags: { place: 'village', name: '上高地' } },
      { type: 'way', tags: { natural: 'water' } },
    ];
    const l = labelsFrom(els, region);
    expect(l.map((x) => x.name)).toEqual(['上高地', '奥穂高岳', '槍ヶ岳']);
    const y = l.find((x) => x.name === '槍ヶ岳');
    expect(y.z).toBeLessThan(0); // 北は −z
    expect(y.ele).toBe(3180);
  });
});

describe('ベクトルタイル（MVT）の読み取り', () => {
  it('building 層の面と高さを読む', async () => {
    const { readLayer, polygonsOf } = await import('../src/core/mvt.js');
    // 小さな MVT を手で組む：層 building、キー render_height、値 12、四角い面 1 つ
    const varint = (n) => { const o = []; while (n > 127) { o.push((n & 127) | 128); n >>>= 7; } o.push(n); return o; };
    const zz = (n) => (n << 1) ^ (n >> 31);
    const field = (f, t, bytes) => [...varint((f << 3) | t), ...(t === 2 ? varint(bytes.length) : []), ...bytes];
    const str = (s) => [...new TextEncoder().encode(s)];
    const geom = [...varint((1 & 7) | (1 << 3)), ...varint(zz(10)), ...varint(zz(10)), ...varint((2 & 7) | (3 << 3)), ...varint(zz(20)), ...varint(zz(0)), ...varint(zz(0)), ...varint(zz(20)), ...varint(zz(-20)), ...varint(zz(0)), ...varint(7 | (1 << 3))];
    const feature = [...field(2, 2, [0, 0]), ...field(3, 0, varint(3)), ...field(4, 2, geom)];
    const value = field(5, 0, varint(12)); // uint
    const layer = [...field(1, 2, str('building')), ...field(2, 2, feature), ...field(3, 2, str('render_height')), ...field(4, 2, value), ...field(5, 0, varint(4096))];
    const tile = new Uint8Array(field(3, 2, layer));
    const { features, extent } = readLayer(tile.buffer, 'building');
    expect(extent).toBe(4096);
    expect(features.length).toBe(1);
    expect(features[0].props.render_height).toBe(12);
    const polys = polygonsOf(features[0].rings);
    expect(polys.length).toBe(1);
    expect(polys[0].outer.length).toBe(4);
    expect(polys[0].outer[2]).toEqual([30, 30]);
  });
});
