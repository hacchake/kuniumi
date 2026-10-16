import { describe, it, expect } from 'vitest';
import {
  GLOBE_R, ecef, toLatLon, enu, mercYToLat, latToMercY, tileLatLon, tileBounds, behindHorizon,
  orbitCamera, subsolarPoint, sampleGrid, gridAt, locateTile, ancestorXf, importSizeFor,
} from '../src/core/globe.js';

const len = (v) => Math.hypot(...v);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

describe('地球モードの計算（globe）', () => {
  it('経緯度 ⇔ ECEF は往復で元に戻る（北極 = +Y）', () => {
    for (const [lat, lon] of [[35.36, 138.73], [-41, 173], [0, -179.5], [89, 10]]) {
      const p = ecef(lat, lon, GLOBE_R + 1000);
      const q = toLatLon(...p);
      expect(q.lat).toBeCloseTo(lat, 9);
      expect(q.lon).toBeCloseTo(lon, 9);
      expect(q.r).toBeCloseTo(GLOBE_R + 1000, 3);
    }
    expect(ecef(90, 0, 1)[1]).toBeCloseTo(1, 12);
  });
  it('東・北・上は直交し、北 = 上 × 東', () => {
    const f = enu(35, 139);
    expect(dot(f.east, f.north)).toBeCloseTo(0, 12);
    expect(dot(f.east, f.up)).toBeCloseTo(0, 12);
    const c = [f.up[1] * f.east[2] - f.up[2] * f.east[1], f.up[2] * f.east[0] - f.up[0] * f.east[2], f.up[0] * f.east[1] - f.up[1] * f.east[0]];
    for (let k = 0; k < 3; k++) expect(c[k]).toBeCloseTo(f.north[k], 12);
    // 東へ少し進むと経度が増える
    const p = ecef(35, 139, GLOBE_R).map((v, k) => v + f.east[k] * 1000);
    expect(toLatLon(...p).lon).toBeGreaterThan(139);
  });
  it('メルカトルの行 ⇔ 緯度', () => {
    expect(mercYToLat(0.5)).toBeCloseTo(0, 12);
    expect(mercYToLat(0)).toBeCloseTo(85.05112878, 6);
    for (const lat of [-60, -10, 0, 35.36, 70]) expect(mercYToLat(latToMercY(lat))).toBeCloseTo(lat, 9);
    const p = tileLatLon(1, 1, 0, 0, 1);
    expect(p.lat).toBeCloseTo(0, 9);
    expect(p.lon).toBeCloseTo(0, 9);
  });
  it('タイルを包む球は四隅を含む', () => {
    const b = tileBounds(5, 28, 12, 0, 3776);
    for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const ll = tileLatLon(5, 28, 12, u, v);
      const p = ecef(ll.lat, ll.lon, GLOBE_R + 3776);
      expect(Math.hypot(p[0] - b.center[0], p[1] - b.center[1], p[2] - b.center[2])).toBeLessThanOrEqual(b.radius + 1e-6);
    }
  });
  it('地平線の向こう：真裏は隠れ、足元は見える', () => {
    const cam = ecef(35, 139, GLOBE_R + 10000);
    expect(behindHorizon(cam, ecef(-35, -41, GLOBE_R), 1000)).toBe(true);
    expect(behindHorizon(cam, ecef(35.1, 139.1, GLOBE_R), 1000)).toBe(false);
    // 高い山は地平線の先でも頭が見える（富士山から 200 km 先の 3000 m 級）
    const low = ecef(35.36, 138.73, GLOBE_R + 3800);
    expect(behindHorizon(low, ecef(36.3, 137.6, GLOBE_R + 3000), 500)).toBe(false);
  });
  it('視点：真下を見るときはちょうど真上、傾けると手前（南）に下がる', () => {
    const v = { lat: 35, lon: 139, range: 5000, heading: 0, tilt: 0 };
    const a = orbitCamera(v);
    expect(len(a.pos) - GLOBE_R).toBeCloseTo(5000, 3);
    const b = orbitCamera({ ...v, tilt: 60 });
    expect(toLatLon(...b.pos).lat).toBeLessThan(35);
    expect(Math.hypot(b.pos[0] - b.target[0], b.pos[1] - b.target[1], b.pos[2] - b.target[2])).toBeCloseTo(5000, 3);
    // 上の向きは視線と直交
    const d = b.target.map((x, k) => x - b.pos[k]);
    expect(dot(d, b.up) / len(d)).toBeCloseTo(0, 9);
  });
  it('太陽の真下の点：夏至の正午（UTC）は北緯 23° 付近・経度 0 付近', () => {
    const s = subsolarPoint(new Date(Date.UTC(2026, 5, 21, 12, 0, 0)));
    expect(s.lat).toBeGreaterThan(22.5);
    expect(s.lat).toBeLessThan(23.6);
    expect(Math.abs(s.lon)).toBeLessThan(1);
    expect(subsolarPoint(new Date(Date.UTC(2026, 11, 21, 0, 0, 0))).lat).toBeLessThan(-22.5);
  });
  it('格子の標本化と、その場所の標高', () => {
    const h = new Float32Array(256 * 256);
    for (let j = 0; j < 256; j++) for (let i = 0; i < 256; i++) h[j * 256 + i] = i * 2 + j;
    const g = sampleGrid(h);
    expect(g.length).toBe(33 * 33);
    expect(g[0]).toBeCloseTo(0, 6);
    expect(gridAt(g, 0.5, 0.5)).toBeCloseTo(h[128 * 256 + 128] - 1.5, 0);
  });
  it('経緯度 → タイル、祖先の写真の位置', () => {
    const l = locateTile(35.36, 138.73, 10);
    const p = tileLatLon(10, l.x, l.y, l.u, l.v);
    expect(p.lat).toBeCloseTo(35.36, 6);
    expect(p.lon).toBeCloseTo(138.73, 6);
    const a = ancestorXf(10, 909, 403, 8);
    expect(a).toEqual({ x: 227, y: 100, ox: 0.25, oy: 0.75, scale: 0.25 });
  });
  it('取り込む広さは見ている距離に合わせる（4 km〜3000 km）', () => {
    expect(importSizeFor(100)).toBe(4000);
    expect(importSizeFor(25000)).toBe(40000);
    expect(importSizeFor(1e8)).toBe(3000e3);
  });
});
