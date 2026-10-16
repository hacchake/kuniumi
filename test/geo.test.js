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
