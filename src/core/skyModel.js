// 空の明るさ（線形 HDR）を CPU で計算する。Three.js r186 の Sky（Preetham モデル＋雲）と同じ式。
// リアルタイム表示は GPU の Sky、静止画はここで作った全天画像を「光源」として使うので、
// 両者の見た目がそろう。Three.js 非依存。

const PI = Math.PI;
const TOTAL_RAYLEIGH = [5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5];
const MIE_CONST = [1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14];
const CUTOFF = 1.6110731556870734;
const STEEPNESS = 1.5;
const EE = 1000;
const RAYLEIGH_ZENITH = 8.4e3;
const MIE_ZENITH = 1.25e3;
const SUN_COS = 0.999956676946448443553574619906976478926848692873900859324;
const THREE_OVER_16PI = 0.05968310365946075;
const ONE_OVER_4PI = 0.07957747154594767;

// Preetham の太陽円盤は空に比べて暗く（晴天でも直射:散乱 ≒ 1.3:1）、影が薄く平板になる。
// 実際の晴天（およそ 5:1）に近づけるため、円盤の明るさをこの倍率で持ち上げる
export const SUN_BOOST = 4;
// 円盤の縁のぼかし（clamp((cos−c0)·50000)）を積分した実効立体角
const SUN_SOLID_ANGLE = 2 * PI * (1 - SUN_COS - 1 / 100000);

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const f = Math.fround; // GPU と同じ単精度で雲のハッシュを計算する
const fract = (x) => f(x - Math.floor(x));
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

// atmosphere: シーンの atmosphere、sunDir: 太陽への単位ベクトル [x,y,z]
export function skyParams(atmosphere, sunDir) {
  const sunE = EE * Math.max(0, 1 - Math.exp(-((CUTOFF - Math.acos(clamp(sunDir[1], -1, 1))) / STEEPNESS)));
  const sunfade = 1 - clamp(1 - Math.exp(sunDir[1] / 450000), 0, 1);
  const rayleighCoef = atmosphere.rayleigh - (1 - sunfade);
  const betaR = TOTAL_RAYLEIGH.map((v) => v * rayleighCoef);
  const c = 0.2 * atmosphere.turbidity * 10e-18;
  const betaM = MIE_CONST.map((v) => 0.434 * c * v * atmosphere.mieCoefficient);
  return {
    sunDir,
    sunE,
    betaR,
    betaM,
    g: atmosphere.mieDirectionalG,
    clouds: {
      coverage: atmosphere.clouds ?? 0,
      density: atmosphere.cloudDensity ?? 0.4,
      scale: atmosphere.cloudScale ?? 0.0002,
      elevation: atmosphere.cloudElevation ?? 0.5,
    },
  };
}

function gradient(ix, iy) {
  let px = fract(f(ix * 0.1031)), py = fract(f(iy * 0.103)), pz = fract(f(ix * 0.0973));
  const d = f(f(px * f(py + 33.33)) + f(py * f(pz + 33.33)) + f(pz * f(px + 33.33)));
  px = f(px + d);
  py = f(py + d);
  pz = f(pz + d);
  // GLSL: fract( ( p.xx + p.yz ) * p.zy )
  return [fract(f(f(px + py) * pz)) * 2 - 1, fract(f(f(px + pz) * py)) * 2 - 1];
}

function noise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const g00 = gradient(ix, iy), g10 = gradient(ix + 1, iy), g01 = gradient(ix, iy + 1), g11 = gradient(ix + 1, iy + 1);
  const a = g00[0] * fx + g00[1] * fy;
  const b = g10[0] * (fx - 1) + g10[1] * fy;
  const c = g01[0] * fx + g01[1] * (fy - 1);
  const d = g11[0] * (fx - 1) + g11[1] * (fy - 1);
  return ((a + (b - a) * ux) * (1 - uy) + (c + (d - c) * ux) * uy) * 1.6;
}

function fbm(x, y) {
  let r = 0, a = 1;
  for (let i = 0; i < 4; i++) {
    r += a * noise(x, y);
    a *= 0.5;
    x = x * 2;
    y = y * 2;
  }
  return r;
}

// 方向 dir（単位ベクトル）の空の明るさを out[0..2] に書く
// opts.sunDisc: 太陽円盤を含めるか / opts.clouds: 雲を含めるか
export function skyRadiance(p, dir, out, opts = {}) {
  const { sunDisc = true, clouds = true, sunScale = 1 } = opts;
  const [dx, dy, dz] = dir;
  const sd = p.sunDir;
  const zenith = Math.acos(Math.max(0, dy));
  const inv = 1 / (Math.cos(zenith) + 0.15 * Math.pow(93.885 - (zenith * 180) / PI, -1.253));
  const sR = RAYLEIGH_ZENITH * inv;
  const sM = MIE_ZENITH * inv;
  const cosT = dx * sd[0] + dy * sd[1] + dz * sd[2];
  const rPhase = THREE_OVER_16PI * (1 + Math.pow(cosT * 0.5 + 0.5, 2));
  const g2 = p.g * p.g;
  const mPhase = ONE_OVER_4PI * ((1 - g2) / Math.pow(1 - 2 * p.g * cosT + g2, 1.5));
  const fade = clamp(Math.pow(1 - sd[1], 5), 0, 1);
  const Fex = [0, 0, 0], Lin = [0, 0, 0], tex = [0, 0, 0], L0 = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const bR = p.betaR[c], bM = p.betaM[c];
    Fex[c] = Math.exp(-(bR * sR + bM * sM));
    const ratio = (bR * rPhase + bM * mPhase) / (bR + bM);
    let lin = Math.pow(p.sunE * ratio * (1 - Fex[c]), 1.5);
    lin *= 1 + (Math.pow(p.sunE * ratio * Fex[c], 0.5) - 1) * fade;
    Lin[c] = lin;
    L0[c] = 0.1 * Fex[c];
  }
  const disc = sunDisc ? clamp((cosT - SUN_COS) * 50000, 0, 1) * SUN_BOOST * sunScale : 0;
  const base = [0, 0.0003, 0.00075];
  for (let c = 0; c < 3; c++) tex[c] = (Lin[c] + L0[c]) * 0.04 + 760 * disc * Math.min(p.sunE * Fex[c], 80) + base[c];

  const cl = p.clouds;
  if (clouds && dy > 0 && cl.coverage > 0) {
    const elev = 1 + (0.1 - 1) * cl.elevation;
    const ux = (dx / (dy * elev)) * cl.scale;
    const uz = (dz / (dy * elev)) * cl.scale;
    const cn = clamp(fbm(ux * 1000, uz * 1000) * 0.7 + 0.5, 0, 1);
    const region = noise(ux * 300, uz * 300) * 0.37 + 0.5;
    const cov = clamp(cl.coverage + (region - 0.5) * 0.6, 0, 1);
    const th = 1 - cov;
    let mask = smoothstep(th, th + 0.3, cn);
    const hf = smoothstep(0, 0.03 + 0.06 * cl.elevation, dy);
    mask *= hf;
    const day = smoothstep(-0.08, 0.3, sd[1]);
    const depth = Math.max(0, cn - th);
    const beer = Math.exp(-4 * depth);
    const powder = 1 - beer * beer;
    const shade = 0.45 + 0.55 * clamp(beer * powder * 2.6, 0, 1);
    const silver = clamp(0.51 / Math.pow(1.49 - cosT * 1.4, 1.5), 0, 3);
    const edge = mask * (1 - mask) * 4;
    const alpha = (1 - Math.exp(-12 * depth * cl.density)) * hf;
    for (let c = 0; c < 3; c++) {
      const sunC = p.sunE * Fex[c] * 0.22 * 0.04;
      const amb = Lin[c] * 0.04 + base[c];
      let cc = amb + sunC * shade + sunC * silver * edge * 0.6;
      cc *= Math.max(day, 0.03);
      tex[c] -= L0[c] * 0.04 * alpha;
      const aerial = tex[c] + (cc - tex[c]) * Fex[c];
      tex[c] = tex[c] + (aerial - tex[c]) * alpha;
    }
  }
  out[0] = tex[0];
  out[1] = tex[1];
  out[2] = tex[2];
  return out;
}

// 太陽の放射照度（法線入射）。円盤の明るさ × 実効立体角
export function sunIrradiance(p) {
  const sd = p.sunDir;
  const zenith = Math.acos(Math.max(0, sd[1]));
  const inv = 1 / (Math.cos(zenith) + 0.15 * Math.pow(93.885 - (zenith * 180) / PI, -1.253));
  return [0, 1, 2].map((c) => {
    const fex = Math.exp(-(p.betaR[c] * RAYLEIGH_ZENITH * inv + p.betaM[c] * MIE_ZENITH * inv));
    // 地平線の下に沈んだ太陽は照らさない（sunE は地平線付近で 0 へ落ちる）
    return 760 * Math.min(p.sunE * fex, 80) * SUN_BOOST * SUN_SOLID_ANGLE * (sd[1] > -0.02 ? 1 : 0);
  });
}

// 全天の正距円筒画像（RGBA Float32）。行0 = 真下、最終行 = 真上（Three.js の DataTexture の向き）。
// 地平線より下は地面の照り返し程度に暗くする（地形の外へ抜けた光が空と同じ明るさで返らないように）
export function renderSkyEquirect(p, width, height, opts = {}) {
  const data = new Float32Array(width * height * 4);
  const col = [0, 0, 0];
  const horizon = [0, 0, 0];
  const SS = 12;
  const skyScale = opts.skyScale ?? 1; // 空の明るさ（環境光）の倍率
  const nearSun = Math.cos(Math.acos(SUN_COS) + (6 * PI) / height); // 円盤の縁から数画素以内
  for (let r = 0; r < height; r++) {
    const v = (r + 0.5) / height;
    const lat = (v - 0.5) * PI;
    const y = Math.sin(lat), cl = Math.cos(lat);
    for (let c = 0; c < width; c++) {
      const phi = ((c + 0.5) / width - 0.5) * 2 * PI;
      const dir = [Math.cos(phi) * cl, y, Math.sin(phi) * cl];
      const o = (r * width + c) * 4;
      const cosSun = dir[0] * p.sunDir[0] + dir[1] * p.sunDir[1] + dir[2] * p.sunDir[2];
      if (cosSun > nearSun && opts.sunDisc !== false) {
        // 太陽円盤は数画素しかないので、近くの画素だけ細かく標本化して明るさの総量を正しく保つ
        const acc = [0, 0, 0];
        for (let sy = 0; sy < SS; sy++) {
          const lat2 = ((r + (sy + 0.5) / SS) / height - 0.5) * PI;
          for (let sx = 0; sx < SS; sx++) {
            const phi2 = ((c + (sx + 0.5) / SS) / width - 0.5) * 2 * PI;
            const d2 = [Math.cos(phi2) * Math.cos(lat2), Math.sin(lat2), Math.sin(phi2) * Math.cos(lat2)];
            skyRadiance(p, d2, col, opts);
            skyRadiance(p, d2, horizon, { ...opts, sunDisc: false });
            // 円盤のぶん（col − horizon）はそのまま、空のぶんだけ skyScale 倍
            for (let k = 0; k < 3; k++) acc[k] += col[k] - horizon[k] + horizon[k] * skyScale;
          }
        }
        col[0] = acc[0] / (SS * SS);
        col[1] = acc[1] / (SS * SS);
        col[2] = acc[2] / (SS * SS);
      } else if (y >= 0) {
        skyRadiance(p, dir, col, opts);
        col[0] *= skyScale;
        col[1] *= skyScale;
        col[2] *= skyScale;
      } else {
        skyRadiance(p, [dir[0] / cl, 0.0, dir[2] / cl], horizon, { sunDisc: false, clouds: false });
        const k = 0.25 + 0.75 * Math.exp(y * 8); // 下ほど暗く
        col[0] = horizon[0] * k * 0.5 * skyScale;
        col[1] = horizon[1] * k * 0.5 * skyScale;
        col[2] = horizon[2] * k * 0.5 * skyScale;
      }
      data[o] = col[0];
      data[o + 1] = col[1];
      data[o + 2] = col[2];
      data[o + 3] = 1;
    }
  }
  return data;
}
