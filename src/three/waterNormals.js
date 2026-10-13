import * as THREE from 'three';
import { hash2 } from '../core/noise.js';

// Water シェーダ用の法線マップをその場で作る（外部画像に頼らない）。
// 周期つきの値ノイズを何段も重ねた「さざ波の高さ」から法線を出す。周期が画像の幅に揃うので継ぎ目なくタイルする。
export function createWaterNormals(size = 512, seed = 7) {
  const height = new Float32Array(size * size);
  // 細かい段ほど弱く。最も大きな段でも画像に 4 周期入れて、繰り返し模様が目立たないようにする
  const octaves = [
    [4, 1.0],
    [8, 0.55],
    [16, 0.3],
    [32, 0.16],
    [64, 0.08],
  ];
  for (const [period, amp] of octaves) {
    const cell = size / period;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        height[y * size + x] += periodicNoise(x / cell, y / cell, period, seed + period) * amp;
      }
    }
  }
  // 中心差分で傾きを出し、平均の傾きが目標値になるよう縮める
  const grad = new Float32Array(size * size * 2);
  let sum2 = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const xm = (x - 1 + size) % size, xp = (x + 1) % size;
      const ym = (y - 1 + size) % size, yp = (y + 1) % size;
      const dx = (height[y * size + xp] - height[y * size + xm]) / 2;
      const dy = (height[yp * size + x] - height[ym * size + x]) / 2;
      grad[(y * size + x) * 2] = dx;
      grad[(y * size + x) * 2 + 1] = dy;
      sum2 += dx * dx + dy * dy;
    }
  }
  const k = 0.3 / Math.sqrt(sum2 / (size * size)); // 傾きの RMS ≈ 0.3

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const dx = grad[i * 2] * k;
    const dy = grad[i * 2 + 1] * k;
    const len = Math.hypot(dx, dy, 1);
    img.data[i * 4] = (-dx / len * 0.5 + 0.5) * 255;
    img.data[i * 4 + 1] = (-dy / len * 0.5 + 0.5) * 255;
    img.data[i * 4 + 2] = (1 / len * 0.5 + 0.5) * 255;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// 格子が period で一周する値ノイズ（滑らかな補間）。-1..1
function periodicNoise(x, y, period, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  let fx = x - xi, fy = y - yi;
  fx = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  fy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const w = (v) => ((v % period) + period) % period;
  const a = hash2(w(xi), w(yi), seed), b = hash2(w(xi + 1), w(yi), seed);
  const c = hash2(w(xi), w(yi + 1), seed), d = hash2(w(xi + 1), w(yi + 1), seed);
  return ((a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy) * 2 - 1;
}
