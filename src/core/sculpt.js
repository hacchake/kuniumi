// 手彫り：筆の跡（terrain.sculpt）を高さ場に重ねる。跡は世界座標 (m) で持つので、解像度を変えても同じ所が盛られる。
// 跡 1 つ：{ x, z, r, h }（盛る・削る：中心で h m、半径 r m で滑らかに 0 へ）
//          { x, z, r, flat, k }（ならす：高さ flat m へ、中心で k の割合だけ寄せる）
//          { x, z, r, cone }（富士山形の山：高さ cone m、頂に浅い火口）
//          { x, z, r, smooth }（なめらかに：周りの平均へ smooth の割合だけ寄せる。尖った所・段差を丸める）
// 高さ場は 0..1（標高 = baseHeight + 値 × heightScale）、field[j * res + i]、i = 西→東、j = 北→南

function falloff(d2, r2) {
  if (d2 >= r2) return 0;
  const t = 1 - d2 / r2;
  return t * t * (3 - 2 * t); // 縁でなめらかに 0
}

export function applySculpt(field, res, terrain) {
  const strokes = terrain.sculpt;
  if (!strokes?.length) return field;
  const size = terrain.size, hs = Math.max(1e-6, terrain.heightScale), base = terrain.baseHeight ?? 0;
  const step = size / (res - 1);
  for (const s of strokes) {
    const r2 = s.r * s.r;
    const i0 = Math.max(0, Math.floor((s.x - s.r) / step + (res - 1) / 2));
    const i1 = Math.min(res - 1, Math.ceil((s.x + s.r) / step + (res - 1) / 2));
    const j0 = Math.max(0, Math.floor((s.z - s.r) / step + (res - 1) / 2));
    const j1 = Math.min(res - 1, Math.ceil((s.z + s.r) / step + (res - 1) / 2));
    const flat = s.flat != null ? (s.flat - base) / hs : null;
    if (s.smooth != null) {
      smoothRegion(field, res, i0, i1, j0, j1, step, s);
      continue;
    }
    for (let j = j0; j <= j1; j++) {
      const z = (j - (res - 1) / 2) * step - s.z;
      for (let i = i0; i <= i1; i++) {
        const x = (i - (res - 1) / 2) * step - s.x;
        const w = falloff(x * x + z * z, r2);
        if (w <= 0) continue;
        const k = j * res + i;
        if (s.cone != null) {
          field[k] += (s.cone / hs) * coneProfile(Math.sqrt(x * x + z * z) / s.r);
          continue;
        }
        if (flat != null) field[k] += (flat - field[k]) * w * (s.k ?? 0.5);
        else field[k] += (s.h / hs) * w;
      }
    }
  }
  return field;
}

// 範囲の中を、周り（筆の半径の 1/8 ほど、少なくとも 1 格子）の平均へ寄せる
function smoothRegion(field, res, i0, i1, j0, j1, step, s) {
  const rad = Math.max(1, Math.round(s.r / 8 / step));
  const w0 = i1 - i0 + 1, h0 = j1 - j0 + 1;
  const src = new Float32Array(w0 * h0);
  for (let j = 0; j < h0; j++) for (let i = 0; i < w0; i++) src[j * w0 + i] = field[(j + j0) * res + i + i0];
  // 横・縦の 2 回の移動平均（端は範囲の中だけで平均）
  const tmp = new Float32Array(w0 * h0);
  for (let j = 0; j < h0; j++)
    for (let i = 0; i < w0; i++) {
      let a = 0, n = 0;
      for (let d = -rad; d <= rad; d++) {
        const x = i + d;
        if (x >= 0 && x < w0) (a += src[j * w0 + x]), n++;
      }
      tmp[j * w0 + i] = a / n;
    }
  const r2 = s.r * s.r;
  for (let j = 0; j < h0; j++) {
    const z = (j + j0 - (res - 1) / 2) * step - s.z;
    for (let i = 0; i < w0; i++) {
      const x = (i + i0 - (res - 1) / 2) * step - s.x;
      const w = falloff(x * x + z * z, r2);
      if (w <= 0) continue;
      let a = 0, n = 0;
      for (let d = -rad; d <= rad; d++) {
        const y = j + d;
        if (y >= 0 && y < h0) (a += tmp[y * w0 + i]), n++;
      }
      const k = (j + j0) * res + i + i0;
      field[k] += (a / n - field[k]) * w * s.smooth;
    }
  }
}

// 地形の計算のやり直しが要るかを見分ける短い鍵（跡の数と値から）
export function sculptKey(strokes) {
  if (!strokes?.length) return '';
  let h = 0;
  for (const s of strokes) {
    for (const v of [s.x, s.z, s.r, s.h ?? 0, s.flat ?? 0, s.k ?? 0, s.smooth ?? 0, s.cone ?? 0]) h = (Math.imul(h, 31) + Math.round(v * 100)) | 0;
  }
  return `${strokes.length}:${h}`;
}

// 山の丸み：尖った頂や尾根（周りの平均より高い所）だけを、周りの平均へ向けて削る（谷はそのまま）。
// amount 0..1。ぼかしの半径は大地の一辺の 1.5%（世界の大きさで決めるので、解像度を変えても同じ形）
export function roundPeaks(field, res, size, amount) {
  if (!(amount > 0)) return field;
  const step = size / (res - 1);
  const rad = Math.max(1, Math.round((size * 0.015 * (0.4 + amount)) / step));
  const tmp = new Float32Array(field.length), blur = new Float32Array(field.length);
  // 横・縦の移動平均を 2 回（ほぼガウスぼかし）
  const pass = (src, dst, horiz) => {
    for (let j = 0; j < res; j++) {
      let acc = 0, n = 0;
      const at = (k) => (horiz ? src[j * res + k] : src[k * res + j]);
      for (let k = -rad; k <= rad; k++) if (k >= 0 && k < res) (acc += at(k)), n++;
      for (let i = 0; i < res; i++) {
        (horiz ? dst : dst)[horiz ? j * res + i : i * res + j] = acc / n;
        const out = i - rad, inn = i + rad + 1;
        if (out >= 0) (acc -= at(out)), n--;
        if (inn < res) (acc += at(inn)), n++;
      }
    }
  };
  pass(field, tmp, true);
  pass(tmp, blur, false);
  pass(blur, tmp, true);
  pass(tmp, blur, false);
  for (let k = 0; k < field.length; k++) {
    const over = field[k] - blur[k];
    if (over > 0) field[k] -= over * amount * 0.85;
  }
  return field;
}

// 富士山形の山の高さの形（0..1）：d = 中心からの距離 / 半径。裾野は広く凹んだ斜面、頂に浅い火口
export function coneProfile(d) {
  if (d >= 1) return 0;
  const s = Math.pow(1 - d, 1.9);
  const top = Math.pow(1 - 0.05, 1.9); // 頂は少し平らに切る
  let h = Math.min(s, top) / top;
  const crater = 1 - Math.min(1, d / 0.045);
  h -= crater * crater * (3 - 2 * crater) * 0.05; // 火口のくぼみ
  return h;
}
