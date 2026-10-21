import * as THREE from 'three/webgpu';
import { t } from '../i18n/index.js';
import { ShaderMaterial, WebGLRenderTarget } from 'three';
import { WebGPUPathTracer, OIDNDenoiser, TRANSMISSIVE_BACKGROUND_ENVIRONMENT } from 'three-gpu-pathtracer/webgpu';
import { PhysicalCamera } from 'three-gpu-pathtracer/src/objects/PhysicalCamera.js';
import { initUNetFromURL } from 'oidn-web';
// OIDN の学習済み重み（HDR・アルベド・法線つき）。同梱してオフラインでも使えるようにする
import OIDN_WEIGHTS from 'oidn-weights/rt_hdr_alb_nrm.tza?url';
import { sunDirection, nightFactor, NIGHT_SKY, moonDirection, moonIllumination } from '../core/sun.js';
import { skyParams, renderSkyEquirect } from '../core/skyModel.js';
import { addAurora, addRainbow } from '../core/skyExtras.js';
import { toneMapToRGBA8 } from '../core/tonemap.js';
import { sunIrradiance, discScaleFor } from '../core/skyModel.js';
import { computeAtmosphere, renderMask } from './atmospherePass.js';
import { atmosphereParams, overcastAmount, exposureKeyTarget } from './atmosphereParams.js';
import { fillInstances, coniferGeometry, broadleafGeometry } from '../three/vegetationMeshes.js';
import { detailedBroadleaf, detailedConifer, detailedGrass, detailedFlowers, detailedRock, detailedReeds, detailedFern, detailedLitter, detailedPalm, detailedTropicalPlant } from '../three/detailedPlants.js';
import { planetRadius } from '../core/schema.js';
import { curvePoint, DISC_RATIO, DISC_SEG } from '../core/curvature.js';
import { buildSurroundMesh } from '../core/surroundMesh.js';
import { STILL_SEA_FLOOR } from '../core/terrainLod.js';
import { lakeMeshData } from '../core/lakes.js';
import { loadPlantModel } from '../three/customPlants.js';
import { loadMoonMap, sampleMoon } from '../three/moonTexture.js';

// 川・湖の印（PNG）から、粗さの地図（水 = なめらか）と、水の所を暗くした写真を作る（どちらも行 0 = 北、flipY のまま）
async function waterTextures(maskUrl, photoTex) {
  const load = (url) =>
    new Promise((res) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => res(null);
      img.src = url;
    });
  const mimg = await load(maskUrl);
  if (!mimg) return null;
  const N = mimg.width;
  const mc = document.createElement('canvas');
  mc.width = mc.height = N;
  const mx = mc.getContext('2d', { willReadFrequently: true });
  mx.drawImage(mimg, 0, 0);
  const m = mx.getImageData(0, 0, N, N);
  for (let k = 0; k < m.data.length; k += 4) {
    const w = m.data[k] / 255;
    const r = Math.round(255 * (0.95 - 0.89 * w)); // 粗さは G を使う
    m.data[k] = m.data[k + 1] = m.data[k + 2] = r;
  }
  mx.putImageData(m, 0, 0);
  const rough = new THREE.CanvasTexture(mc);
  rough.colorSpace = THREE.NoColorSpace;
  let color = null;
  const pimg = photoTex?.image;
  if (pimg) {
    const P = pimg.width;
    const pc = document.createElement('canvas');
    pc.width = pc.height = P;
    const px = pc.getContext('2d', { willReadFrequently: true });
    px.drawImage(pimg, 0, 0);
    const pd = px.getImageData(0, 0, P, P);
    // 印を写真の大きさに引き伸ばして重ねる
    const sc = document.createElement('canvas');
    sc.width = sc.height = P;
    const sx = sc.getContext('2d', { willReadFrequently: true });
    sx.drawImage(mimg, 0, 0, P, P);
    const sd = sx.getImageData(0, 0, P, P).data;
    for (let k = 0; k < pd.data.length; k += 4) {
      const w = sd[k] / 255;
      if (w <= 0) continue;
      const f = 1 - 0.65 * w;
      pd.data[k] = pd.data[k] * f + 6 * w;
      pd.data[k + 1] = pd.data[k + 1] * f + 22 * w;
      pd.data[k + 2] = pd.data[k + 2] * f + 30 * w;
    }
    px.putImageData(pd, 0, 0);
    color = new THREE.CanvasTexture(pc);
    color.colorSpace = THREE.SRGBColorSpace;
    color.anisotropy = 8;
  }
  return { rough, color };
}

// 季節を写真に焼き込む（GpuTerrain の季節の規則と同じ）。field: 高さ場 { field(0..1), res }
function seasonalPhoto(photoTex, season, terrain, { field, res }) {
  const img = photoTex.image;
  if (!img?.width) return null;
  const P = img.width;
  const c = document.createElement('canvas');
  c.width = c.height = P;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(img, 0, 0);
  const d = x.getImageData(0, 0, P, P);
  const lin = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  const enc = (v) => 255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(Math.max(0, v), 1 / 2.4) - 0.055);
  const hAt = (u, v) => {
    const fx = Math.min(res - 1, Math.max(0, u * (res - 1))), fy = Math.min(res - 1, Math.max(0, v * (res - 1)));
    const i = Math.min(res - 2, Math.floor(fx)), j = Math.min(res - 2, Math.floor(fy)), a = fx - i, b = fy - j;
    const f = (field[j * res + i] * (1 - a) + field[j * res + i + 1] * a) * (1 - b) + (field[(j + 1) * res + i] * (1 - a) + field[(j + 1) * res + i + 1] * a) * b;
    return terrain.baseHeight + f * terrain.heightScale;
  };
  const cell = terrain.size / P;
  const hash = (i, j) => {
    let h = (i * 374761393 + j * 668265263) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const noise = (u, v) => {
    // 約 130 m の大きさの斑（秋の赤〜黄のばらつき）
    const s = terrain.size / 130;
    const X = u * s, Y = v * s, i = Math.floor(X), j = Math.floor(Y), fx = X - i, fy = Y - j;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    return (hash(i, j) * (1 - sx) + hash(i + 1, j) * sx) * (1 - sy) + (hash(i, j + 1) * (1 - sx) + hash(i + 1, j + 1) * sx) * sy;
  };
  for (let j = 0; j < P; j++) {
    for (let i = 0; i < P; i++) {
      const k = (j * P + i) * 4;
      let r = lin(d.data[k]), g = lin(d.data[k + 1]), b = lin(d.data[k + 2]);
      const gr = Math.min(1, Math.max(0, ((g - r) / (g + r + 1e-4)) * 4));
      const lm = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const u = (i + 0.5) / P, v = (j + 0.5) / P;
      if (season === 'spring') {
        r += (r * 1.05 - r) * gr * 0.7;
        g += (g * 1.25 - g) * gr * 0.7;
        b += (b * 0.85 - b) * gr * 0.7;
      } else if (season === 'autumn') {
        const n = noise(u, v);
        const k2 = lm * 2.2 + 0.03, w = gr * 0.85;
        r += ((0.62 + 0.1 * n) * k2 - r) * w;
        g += ((0.16 + 0.32 * n) * k2 - g) * w;
        b += ((0.04 + 0.04 * n) * k2 - b) * w;
      } else if (season === 'winter') {
        const h = hAt(u, v);
        const gx = (hAt(u + 1 / P, v) - hAt(u - 1 / P, v)) / (2 * cell), gz = (hAt(u, v + 1 / P) - hAt(u, v - 1 / P)) / (2 * cell);
        const sl = Math.hypot(gx, gz);
        const sm = (a, b2, x2) => {
          const q = Math.min(1, Math.max(0, (x2 - a) / (b2 - a)));
          return q * q * (3 - 2 * q);
        };
        const snow = sm(terrain.winterSnow - 150, terrain.winterSnow + 250, h) * (1 - sm(0.55, 1.0, sl));
        const dull = 1 - 0.25 * gr;
        r = r * 0.95 * dull + (0.82 - r * 0.95 * dull) * snow;
        g = g * 0.92 * dull + (0.85 - g * 0.92 * dull) * snow;
        b = b * 0.85 * dull + (0.9 - b * 0.85 * dull) * snow;
      }
      d.data[k] = enc(r);
      d.data[k + 1] = enc(g);
      d.data[k + 2] = enc(b);
    }
  }
  x.putImageData(d, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

// 衛星写真（JPEG の data URL）をテクスチャに。行 0 = 北 = uv の v 1（flipY のまま）
function loadPhotoTexture(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const tex = new THREE.Texture(img);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8;
      tex.needsUpdate = true;
      resolve(tex);
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}
import { decodePng } from '../core/png16.js';

// 高画質の一枚絵モード。リアルタイム表示と同じシーン JSON を、別の描画器（パストレーサ）で解釈する。
// 数千 km の大地のため、座標の原点を注視点へずらし（Float32 の精度対策）、星の丸みもリアルタイム表示と同じ式で曲げて組む。
//
//   1. 地形を静止画用に細かく作り直す（頂点 1025〜2049/辺、地表テクスチャ 4096px）
//   2. 空の物理モデルから全天の HDR 画像を作り、空そのものを光源にする（太陽の柔らかい影・映り込み）
//   3. WebGPU のパストレーサで光の反射・屈折・間接光を計算し、AI ノイズ除去（OIDN）で仕上げる
//   4. 深度から遠景のかすみ（空気遠近）を足し、光のにじみ・トーンマップ（AgX）を掛けて書き出す

const ENV_SIZE = [2048, 1024];

export class StillJob {
  // deps: { view: RealtimeRenderer } / ui: { canvas, onStatus(text), onProgress(done, total, info) }
  constructor(scene, deps, ui) {
    this.scene = scene;
    this.view = deps.view;
    this.ui = ui;
    this.cancelled = false;
    this.disposers = [];
    this.tuning = deps.tuning ?? {}; // 検証用の上書き（光の反射回数など）
    this.stats = {};
  }

  cancel() {
    this.cancelled = true;
  }

  #check() {
    if (this.cancelled) throw new Error('中止しました');
  }

  async run() {
    try {
      return await this.#run();
    } finally {
      for (const d of this.disposers.reverse()) {
        try {
          d();
        } catch {
          // 片付けの失敗は結果に影響しない
        }
      }
    }
  }

  async #run() {
    const s = this.scene;
    const st = s.render.still;
    const W = Math.round(st.width), H = Math.round(st.height);
    if (!navigator.gpu) throw new Error(t('このブラウザは WebGPU に対応していません（Chrome / Edge の最新版で開いてください）'));

    // ---- 1. 地形を作り直す ----
    this.ui.onStatus(t('大地を細かく作り直しています…'));
    // 地形は「近いほど細かい」区画で作り直す（ノイズ地形・ハイトマップ地形とも）
    const mark = (k) => (this.stats.timings[k] = Math.round(performance.now() - tStart));
    const tStart = performance.now();
    this.stats.timings = {};
    // 原点 = 注視点の真下。丸みの中心も注視点（リアルタイム表示と同じ）
    const R = planetRadius(s);
    this.place = { ox: s.camera.target[0], oz: s.camera.target[2], cx: s.camera.target[0], cz: s.camera.target[2], R };
    const terrain = await this.#lodTerrain(s, W / H, H);
    // 地球から取り込んだ地形なら、範囲の外側の「周りの地形」も粗く置く
    const sur = s.terrain.mode === 'heightmap' ? s.terrain.heightmap?.surround : null;
    if (sur) {
      const img = await decodePng(await (await fetch(sur.png)).arrayBuffer());
      if (img) {
        const meters = new Float32Array(img.data.length);
        // 範囲の地形と同じ変換（「基準の標高」「起伏の高さ」を変えていれば周りもそのぶん動かす）
        const g = s.terrain.heightmap?.geo;
        const g0 = Number.isFinite(g?.min) ? g.min : s.terrain.baseHeight;
        const g1 = Number.isFinite(g?.max) ? g.max : s.terrain.baseHeight + s.terrain.heightScale;
        const k1 = s.terrain.heightScale / Math.max(1, g1 - g0);
        for (let k = 0; k < meters.length; k++) meters[k] = s.terrain.baseHeight + (sur.min + img.data[k] * (sur.max - sur.min) - g0) * k1;
        const photo = s.terrain.photo !== false && !!sur.photo;
        terrain.surround = buildSurroundMesh(meters, img.width, sur.size, { innerSize: s.terrain.size, terrain: s.terrain, water: s.water, place: this.place, photo });
      }
    }
    mark('terrain');
    this.#check();

    // ---- 2. シーンを組む ----
    this.ui.onStatus(t('光の通り道を組み立てています…'));
    await this.view.objects.ready();
    const objectMeshes = this.view.objects.exportMeshes();
    const celestial = new Set(s.objects.filter((o) => o.celestial).map((o) => o.id));
    const built = await this.#buildScene(s, terrain, objectMeshes);
    mark('scene');
    // 一枚絵の細かい地面はリアルタイム表示と少し違うので、カメラが地面すれすれ（1.4 m 未満）なら持ち上げる
    const cg = terrain.lod?.camGround;
    if (Number.isFinite(cg) && s.camera.position[1] - cg < 1.4 && s.camera.position[1] - cg > -20) {
      const dy = cg + 1.4 - s.camera.position[1];
      s.camera.position = [s.camera.position[0], s.camera.position[1] + dy, s.camera.position[2]];
      s.camera.target = [s.camera.target[0], s.camera.target[1] + dy, s.camera.target[2]];
    }
    const camera = this.#camera(s, W / H);
    this.#check();

    // ---- 3. パストレース ----
    if (!this.tuning.keepRealtime) {
      this.view.paused = true;
      this.disposers.push(() => (this.view.paused = false));
    }
    // 細かい地形は頂点データが数百 MB になるので、GPU が許す上限まで使えるように頼む（既定は 128MB）
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    const requiredLimits = adapter
      ? { maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize, maxBufferSize: adapter.limits.maxBufferSize }
      : undefined;
    const renderer = new THREE.WebGPURenderer({ canvas: this.ui.canvas, antialias: false, alpha: false, powerPreference: 'high-performance', requiredLimits });
    await renderer.init();
    mark('gpuInit');
    // GPU 側のエラー（メモリ不足など）は捕まえて止める（放っておくと黙って描けないまま回り続ける）
    renderer.backend.device?.addEventListener('uncapturederror', (e) => {
      this.gpuError ??= e.error?.message ?? String(e.error);
    });
    // GPU が止まった（重すぎて OS に打ち切られた等）ときは、待っている処理を終わらせて知らせる
    const lost = renderer.backend.device?.lost.then((info) => {
      this.gpuError ??= info?.message || 'GPU device lost';
    });
    const gpuWait = (p) => (lost ? Promise.race([p, lost]) : p);
    this.disposers.push(() => renderer.dispose());
    renderer.setPixelRatio(1);
    renderer.setSize(W, H, false);
    // 途中経過の表示用（最終画像は自前でトーンマップする）
    renderer.toneMapping = st.tone === 'aces' ? THREE.ACESFilmicToneMapping : THREE.AgXToneMapping;
    renderer.toneMappingExposure = s.atmosphere.exposure * st.exposure;

    const pt = new WebGPUPathTracer(renderer);
    this.disposers.push(() => pt.dispose());
    pt.renderDelay = 0;
    pt.minSamples = 1;
    pt.fadeDuration = 0;
    pt.dynamicLowRes = false;
    pt.maxBounces = this.tuning.bounces ?? 6;
    // 1 回に GPU へ積む光線の数。大きな大地は 1 本あたりの計算が重く、まとめて積むと
    // OS の監視（約 2 秒）で GPU が打ち切られるので、小分けにする
    pt.frameBudget = this.tuning.frameBudget ?? (s.terrain.size > 200000 ? 50000 : 250000);
    if (this.tuning.megakernel) this.useMegakernel = true;
    pt.maxSamples = st.samples;
    pt.filterGlossyFactor = 0.5;
    pt.transmissiveBackground = TRANSMISSIVE_BACKGROUND_ENVIRONMENT;
    let denoiser = null;
    if (st.denoise) {
      denoiser = new OIDNDenoiser({ initUNetFromURL, auxWeightsUrl: OIDN_WEIGHTS });
      pt.setDenoiser(denoiser);
    }
    // 形状の加速構造は同期で作られて画面が固まるので、表示を一度更新してから
    await nextFrame();
    pt.setScene(built.scene, camera);
    mark('bvh');
    if (this.useMegakernel) pt.useMegakernel(true);
    this.#check();

    // 光を追いかける 1 回分（label：進み具合に添える「1/2」など）
    const trace = async (label = '') => {
      const t0 = performance.now();
      let counts = { min: 0, avg: 0 };
      let doneAt = null;
      let frame = 0;
      // 画面の更新（requestAnimationFrame）に合わせると GPU が空回りするので、
      // GPU の処理完了を待ちながら連続で積む（同時に積むのは 2 回分まで）
      const device = renderer.backend?.device;
      for (;;) {
        this.#check();
        if (this.gpuError) throw new Error(t('GPU でエラーが出ました（地形の細かさや解像度を下げてください）: {msg}', { msg: this.gpuError.split(/\r?\n/)[0] }));
        pt.renderSample();
        frame++;
        if (frame === 1) {
          if (device) await gpuWait(device.queue.onSubmittedWorkDone());
          mark('firstSample');
        }
        if (device && frame % 2 === 0) await gpuWait(device.queue.onSubmittedWorkDone());
        if (frame % 16 === 0) {
          counts = await gpuWait(pt.getSampleCountsAsync());
          if (this.gpuError || !counts) continue;
          const sec = (performance.now() - t0) / 1000;
          const left = counts.avg > 0 ? (sec / counts.avg) * Math.max(0, st.samples - counts.avg) : 0;
          this.ui.onProgress(Math.min(counts.avg, st.samples), st.samples, { sec, left, denoising: counts.min >= st.samples, label });
          if (counts.min >= st.samples) {
            if (doneAt === null) {
              doneAt = performance.now();
              // ノイズ除去（oidn-web）は requestAnimationFrame で少しずつ進むので、画面が隠れていると止まる。
              // 除去の間だけ時間で進む版に差し替える
              const raf = window.requestAnimationFrame;
              window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 4);
              this.disposers.push(() => (window.requestAnimationFrame = raf));
            }
            if (!denoiser || denoiser.complete) break;
            // ノイズ除去が 90 秒たっても終わらなければ諦め、除去前の画像で仕上げる
            if (performance.now() - doneAt > 90000) {
              pt.setDenoiser(null);
              denoiser = null;
              this.stats.denoiseTimeout = true;
              break;
            }
          }
        }
        if (!device || frame % 4 === 0) await new Promise((r) => setTimeout(r, 0)); // 画面の操作に応える隙間
      }
      return { traceSec: (performance.now() - t0) / 1000, frame, counts };
    };
    let { traceSec, frame, counts } = await trace();
    Object.assign(this.stats, { traceSec, frames: frame, samplesPerSec: counts.samplesPerSecond });

    // ---- 4. HDR を読み出して仕上げる ----
    mark('trace');
    this.ui.onStatus(t('かすみと光を仕上げています…'));
    const hdr = await this.#readHDR(renderer, pt, W, H);
    // 「水面に映す」を切った物体：その物体を抜いた絵をもう 1 枚描き、物体そのものが見えている画素だけ 1 枚目を使う
    // （水面や地面の反射には出ない）。物体が見えている所は、画素ごとの最初に当たる物の印で決める
    const noReflectIds = new Set(s.objects.filter((o) => o.reflect === false).map((o) => o.id));
    const noReflect = objectMeshes.filter((m) => noReflectIds.has(m.userData.kuniumiId));
    if (noReflect.length) {
      const others = [built.terrainMesh, built.surroundMesh, built.water, built.lakeMesh, ...built.plants, ...(built.buildingMeshes ?? []), ...objectMeshes.filter((m) => !noReflect.includes(m))].filter(Boolean);
      const mask = renderMask(this.view.renderer, noReflect, others, camera, W, H);
      for (const m of noReflect) built.scene.remove(m);
      this.ui.onStatus(t('水面に映さない物体を抜いて、もう一度描いています…'));
      if (st.denoise) {
        denoiser = new OIDNDenoiser({ initUNetFromURL, auxWeightsUrl: OIDN_WEIGHTS });
        pt.setDenoiser(denoiser);
      }
      await nextFrame();
      pt.setScene(built.scene, camera);
      const second = await trace('2/2');
      traceSec += second.traceSec;
      const hdr2 = await this.#readHDR(renderer, pt, W, H);
      for (let i = 0, n = W * H; i < n; i++) {
        const k = mask[i];
        if (k >= 1) continue;
        for (let c = 0; c < 4; c++) hdr[i * 4 + c] = hdr[i * 4 + c] * k + hdr2[i * 4 + c] * (1 - k);
      }
      this.stats.noReflectPass = true;
    }
    // 夜空の星（画面の画素ごと）。空が見えている所だけ、霧や大気を重ねる前に
    if (built.starK > 0.01) {
      const solid = [built.terrainMesh, built.surroundMesh, built.water, built.lakeMesh, ...built.plants, ...(built.buildingMeshes ?? []), ...objectMeshes].filter(Boolean);
      const hit = renderMask(this.view.renderer, solid, [], camera, W, H);
      for (let i = 0; i < hit.length; i++) hit[i] = 1 - hit[i];
      addStarsScreen(hdr, W, H, camera, hit, built.starK, s.atmosphere.exposure);
    }
    // 月（画面の画素ごとに、月面図の模様で）
    if (built.moon) {
      const solid = [built.terrainMesh, built.surroundMesh, built.water, built.lakeMesh, ...built.plants, ...(built.buildingMeshes ?? []), ...objectMeshes].filter(Boolean);
      const hit = renderMask(this.view.renderer, solid, [], camera, W, H);
      for (let i = 0; i < hit.length; i++) hit[i] = 1 - hit[i];
      const map = await loadMoonMap().catch(() => null);
      addMoonScreen(hdr, W, H, camera, hit, built.moon, map);
    }
    this.#applyAtmosphere(hdr, s, built, objectMeshes, celestial, camera, W, H);
    mark('atmosphere');
    if (st.bloom > 0) applyBloom(hdr, W, H, st.bloom);
    // 自動露出：絵の明るさの対数平均を、晴れた景色のふつうの明るさ（0.12）へ寄せる。
    // 寄せ方は控えめ（比の 0.6 乗、0.7〜6 倍）で、暗い森は開けた所よりは暗く残る。
    // 夕景（太陽が地平線近く）は暗さも演出なので最大 2 倍まで、夜（太陽が −4° より下）は補わない
    let exposure = s.atmosphere.exposure * st.exposure;
    const aeMax = s.sun.elevation > 5 ? 6 : s.sun.elevation > -4 ? 2 : 1;
    if (st.autoExposure !== false && aeMax > 1) {
      let sum = 0;
      const n = W * H;
      for (let i = 0; i < n * 4; i += 4) sum += Math.log(1e-4 + (hdr[i] * 0.2126 + hdr[i + 1] * 0.7152 + hdr[i + 2] * 0.0722) * exposure);
      const key = Math.exp(sum / n);
      // 下限も目標に合わせて下げる（雷雨は明るい霧が画面を占めて明るく測れるので、0.7 倍止まりでは暗くならなかった）
      const target = exposureKeyTarget(s.atmosphere);
      const k = Math.min(aeMax, Math.max(aeMax > 2 ? 0.7 * (target / 0.12) : 1, Math.pow(target / Math.max(1e-6, key), 0.6)));
      exposure *= k;
      this.stats.autoExposure = Math.round(k * 100) / 100;
    }
    const rgba = toneMapToRGBA8(hdr, W, H, { mode: st.tone, exposure });
    for (const t of built.textures) t.dispose();
    return { hdr, rgba, width: W, height: H, samples: st.samples, traceSec, denoised: !!denoiser };
  }

  // カメラから近いほど細かい地形（ワーカーで計算）
  #lodTerrain(s, aspect, height) {
    const maxTriangles = s.render.still.terrainDetail >= 2049 ? 7_000_000 : 4_000_000;
    return new Promise((resolve, reject) => {
      const w = new Worker(new URL('../workers/lodWorker.js', import.meta.url), { type: 'module' });
      this.disposers.push(() => w.terminate());
      w.onmessage = (e) => {
        if (e.data.progress !== undefined) {
          this.ui.onStatus(t('大地を細かく作り直しています… {p}%', { p: Math.round(e.data.progress * 100) }));
          return;
        }
        w.terminate();
        if (e.data.error) reject(new Error(t('地形の生成に失敗: {msg}', { msg: e.data.error })));
        else resolve({ lod: e.data.result });
      };
      w.postMessage({
        terrain: s.terrain,
        water: s.water,
        view: { position: s.camera.position, target: s.camera.target, fov: s.camera.fov, aspect, height },
        maxTriangles,
        vegetation: s.vegetation,
        place: this.place,
        // リアルタイム表示の高さ場（同じ地形のときだけ）。一枚絵の地面をそれに合わせる
        // 窪地の湖（木や草を湖の中と岸辺に置かない）
        lakes: (s.water.lakes ?? 0) > 0 && this.view.lakes?.lakes.length ? { shore: this.view.lakes.shore.slice(), res: this.view.lakes.res } : null,
        refField: s.terrain.mode !== 'heightmap' && this.view.terrainService?.field ? { field: this.view.terrainService.field.slice(), res: this.view.terrainService.res } : null,
      });
    });
  }

  async #buildScene(s, terrain, objectMeshes) {
    const scene = new THREE.Scene();
    const textures = [];
    const t = s.terrain;

    // 地形（近いほど細かい区画。色は頂点ごと）
    const r = terrain.lod;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(r.positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(r.normals, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(r.colors, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(r.uvs, 2));
    geo.setIndex(new THREE.BufferAttribute(r.index, 1));
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    this.stats.terrainTriangles = r.triangles;
    // 地球から取り込んだ地形の衛星写真は、テクスチャとして貼る（遠くまで写真の細かさで）
    const usePhoto = t.mode === 'heightmap' && t.photo !== false;
    let innerPhoto = usePhoto && t.heightmap?.photo ? await loadPhotoTexture(t.heightmap.photo) : null;
    // 川・湖（OpenStreetMap の印）：そこだけなめらか（空と岸を映す）にし、写真の色も水らしく暗く
    const inlandWater = t.mode === 'heightmap' && t.heightmap?.water ? await waterTextures(t.heightmap.water, innerPhoto) : null;
    if (inlandWater?.color) {
      innerPhoto?.dispose();
      innerPhoto = inlandWater.color;
    }
    if (inlandWater) this.disposers.push(() => inlandWater.rough.dispose());
    // 季節（紅葉・若葉・雪）を写真に焼き込む（リアルタイム表示と同じ規則）
    const season = t.season ?? 'summer';
    if (innerPhoto && season !== 'summer' && this.view.terrainData) {
      const tex = seasonalPhoto(innerPhoto, season, t, this.view.terrainData);
      if (tex) {
        innerPhoto.dispose();
        innerPhoto = tex;
      }
    }
    let outerPhoto = usePhoto && t.heightmap?.surround?.photo ? await loadPhotoTexture(t.heightmap.surround.photo) : null;
    // 周りの地形の写真にも季節を（高さは周りの地形の標高 m）
    const S = this.view.surround;
    if (outerPhoto && season !== 'summer' && S?.meters) {
      const tex = seasonalPhoto(outerPhoto, season, { size: S.size, baseHeight: 0, heightScale: 1, winterSnow: t.winterSnow }, { field: S.meters, res: S.res });
      if (tex) {
        outerPhoto.dispose();
        outerPhoto = tex;
      }
    }
    for (const tex of [innerPhoto, outerPhoto]) if (tex) this.disposers.push(() => tex.dispose());
    // 夜の街の明かり（夜ほど強く）
    const nf = nightFactor(s.sun.elevation);
    const lightsTex = nf > 0.02 && t.mode === 'heightmap' && t.heightmap?.lights ? await loadPhotoTexture(t.heightmap.lights) : null;
    if (lightsTex) this.disposers.push(() => lightsTex.dispose());
    const terrainMesh = new THREE.Mesh(
      geo,
      new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 1, specularIntensity: inlandWater ? 1 : 0.15, metalness: 0, map: innerPhoto, roughnessMap: inlandWater?.rough ?? null, emissiveMap: lightsTex, emissive: lightsTex ? new THREE.Color(1, 0.8, 0.55) : new THREE.Color(0), emissiveIntensity: lightsTex ? nf * 4 : 0 }),
    );
    terrainMesh.name = 'Terrain';
    scene.add(terrainMesh);
    this.disposers.push(() => (geo.dispose(), terrainMesh.material.dispose()));
    let surroundMesh = null;
    if (terrain.surround) {
      const sr = terrain.surround;
      const sg = new THREE.BufferGeometry();
      sg.setAttribute('position', new THREE.BufferAttribute(sr.positions, 3));
      sg.setAttribute('normal', new THREE.BufferAttribute(sr.normals, 3));
      sg.setAttribute('color', new THREE.BufferAttribute(sr.colors, 3));
      sg.setAttribute('uv', new THREE.BufferAttribute(sr.uvs, 2));
      sg.setIndex(new THREE.BufferAttribute(sr.index, 1));
      const smat = outerPhoto ? new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 1, specularIntensity: 0.15, metalness: 0, map: outerPhoto }) : terrainMesh.material;
      if (outerPhoto) this.disposers.push(() => smat.dispose());
      surroundMesh = new THREE.Mesh(sg, smat);
      surroundMesh.name = 'Surround';
      scene.add(surroundMesh);
      this.disposers.push(() => sg.dispose());
    }

    // 建物（リアルタイム表示で取り寄せてあるもの。一枚絵の原点と丸みに合わせて置き直す）
    const buildingMeshes = [];
    const bgroup = this.view.buildings?.group;
    if (bgroup?.visible && t.buildings !== false) {
      const P = this.place;
      const pcx = P.cx - P.ox, pcz = P.cz - P.oz;
      const bmat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0, side: THREE.DoubleSide });
      this.disposers.push(() => bmat.dispose());
      const pp = [0, 0, 0];
      let nb = 0;
      for (const m of bgroup.children) {
        const src = m.geometry?.attributes?.position;
        if (!src) continue;
        const pos = new Float32Array(src.array.length);
        for (let v = 0; v < src.count; v++) {
          curvePoint(src.array[v * 3] - P.ox, src.array[v * 3 + 1], src.array[v * 3 + 2] - P.oz, pcx, pcz, P.R, pp);
          pos[v * 3] = pp[0];
          pos[v * 3 + 1] = pp[1];
          pos[v * 3 + 2] = pp[2];
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        g.setAttribute('color', m.geometry.attributes.color);
        g.computeVertexNormals();
        const mesh = new THREE.Mesh(g, bmat);
        mesh.name = 'Buildings';
        scene.add(mesh);
        buildingMeshes.push(mesh);
        this.disposers.push(() => g.dispose());
        nb += src.count / 3;
      }
      this.stats.buildingTriangles = nb;
    }

    // 水：透過・屈折・吸収をもつ本物の水。さざ波は法線マップ
    // 水の素材（海と窪地の湖で同じ）。level: その水面の標高（波の模様を貼る範囲をカメラの高さから決める）
    const makeWater = (level) => {
      // 波：カメラの真下を中心に、繰り返さない波の法線マップを貼る（太陽のきらめき・映り込みの揺らぎ）。
      // 繰り返す法線マップはパストレーサのテクスチャ合成で継ぎ目が線になるので、範囲の外は平らにして「表面の粗さ」に任せる。
      // 粗さは「揺らぎ」「波の大きさ」から決める（太陽の照り返しが広がり、遠くの水面が空を柔らかく映す）
      const tint = new THREE.Color(s.water.color);
      const rough = Math.min(0.25, 0.015 + s.water.distortion * 0.008 * s.water.waveScale) * 0.75;
      const camH = Math.max(1, s.camera.position[1] - level);
      // 範囲は見ている先の海を覆うように：カメラの高さの 12 倍ほどの広さを、視線の向き（水平）へずらして置く
      const waveW = Math.min(12000, Math.max(800, camH * 12 + 600));
      const fx = s.camera.target[0] - s.camera.position[0], fz = s.camera.target[2] - s.camera.position[2];
      const fl = Math.hypot(fx, fz) || 1;
      const ahead = waveW * 0.4;
      const waveC = [s.camera.position[0] - this.place.ox + (fx / fl) * ahead, s.camera.position[2] - this.place.oz + (fz / fl) * ahead];
      const waveTex = waveNormalMap(1536, waveW, s.water.distortion, s.water.waveScale, (s.vegetation?.seed ?? 77) + 5);
      // 上空（20 km 以上）から見下ろすときは、海底は見えないので「透ける水」をやめ、暗い水の色と表面の反射だけにする。
      // 透ける水のままだと、球面に沿わせた三角形の面ごとに屈折がずれ、同心円の縞になる
      const fromSky = R > 0 && s.camera.position[1] > 20000;
      const wmat = fromSky
        ? new THREE.MeshPhysicalMaterial({ color: tint.clone().multiplyScalar(0.35), roughness: Math.max(rough, 0.06), metalness: 0, ior: 1.333, specularIntensity: 1 })
        : new THREE.MeshPhysicalMaterial({
            color: 0xffffff,
            roughness: rough,
            metalness: 0,
            transmission: 1,
            ior: 1.333,
            thickness: 1,
            // 水の色は「吸収されにくい色」として持たせる（浅瀬が水の色に染まり、深い所ほど暗くなる）
            attenuationColor: tint.clone().lerp(new THREE.Color(1, 1, 1), 0.55),
            attenuationDistance: 10,
          });
      if (!this.tuning.noWaves) wmat.normalMap = waveTex;
      wmat.normalScale = new THREE.Vector2(1, 1);
      // 波の模様が届かない遠くの水面：平らなままだと太陽や月が丸い鏡像のまま映り、二つ目の太陽に見える。
      // 本物の海では遠くの波が映り込みを縦に引き伸ばして光の道になるので、波の強さに応じて表面を粗くする
      // （粗さの地図は波の模様と同じ範囲に貼り、範囲の外は端の値＝遠くの粗さが続く）。穏やかな水面は鏡のまま
      // 粗くしすぎると地平の明るい霞を広く映して、海全体が白っぽく濁る（既定の揺らぎ 3.7 で緑灰色の海になった）
      const farRough = Math.min(0.2, rough + s.water.distortion * 0.025 * s.water.waveScale);
      let roughTex = null;
      if (!fromSky && farRough > rough * 1.2) {
        const N = 64, rd = new Uint8Array(N * N * 4);
        for (let j = 0; j < N; j++)
          for (let i = 0; i < N; i++) {
            const e = Math.max(Math.abs((i + 0.5) / N - 0.5), Math.abs((j + 0.5) / N - 0.5)) * 2; // 0 = 中心、1 = 端
            const t = Math.min(1, Math.max(0, (e - 0.7) / 0.28));
            const g = (rough + (farRough - rough) * t * t * (3 - 2 * t)) / farRough;
            rd.set([255, Math.round(g * 255), 255, 255], (j * N + i) * 4);
          }
        roughTex = new THREE.DataTexture(rd, N, N, THREE.RGBAFormat);
        roughTex.magFilter = roughTex.minFilter = THREE.LinearFilter;
        roughTex.needsUpdate = true;
        wmat.roughness = farRough;
        wmat.roughnessMap = roughTex;
      }
      this.disposers.push(() => (waveTex.dispose(), roughTex?.dispose(), wmat.dispose()));
      return { wmat, waveC, waveW };
    };
    let water = null;
    const R = this.place.R;
    if (s.water.enabled) {
      const span = Math.max(t.size * 30, 2000000); // 水平線（高さ数 km から百数十 km 先）より遠くまで
      // 丸い星では、注視点を中心に近くは細かく遠くは粗い円盤を、球面に沿って曲げる
      const wgeo = R > 0 ? curvedDisc(R, s.water.level) : new THREE.PlaneGeometry(span, span, 1, 1);
      if (!(R > 0)) wgeo.rotateX(-Math.PI / 2);
      const { wmat, waveC, waveW } = makeWater(s.water.level);
      addWaveUV(wgeo, waveC, waveW);
      water = new THREE.Mesh(wgeo, wmat);
      if (!(R > 0)) water.position.y = s.water.level;
      scene.add(water);
      // 水の底：地形の外まで光が素通りしないよう、暗い海底でふさぐ
      // 一枚絵の地形は深い海の底を STILL_SEA_FLOOR で受け止めるので、そのすぐ下に地形の外まで続く海の底を置く（色は水の散乱色）
      const bedY = s.water.level - STILL_SEA_FLOOR - 0.3;
      const bgeo = R > 0 ? curvedDisc(R, bedY, Math.PI * R * 0.98, 256, 1.06) : new THREE.PlaneGeometry(span, span, 1, 1);
      if (!(R > 0)) bgeo.rotateX(-Math.PI / 2);
      const bedCol = new THREE.Color(s.water.color).multiplyScalar(2.5);
      bedCol.r = Math.min(1, bedCol.r); bedCol.g = Math.min(1, bedCol.g); bedCol.b = Math.min(1, bedCol.b);
      const bed = new THREE.Mesh(bgeo, new THREE.MeshStandardMaterial({ color: bedCol, roughness: 1 }));
      if (!(R > 0)) bed.position.y = bedY;
      scene.add(bed);
      this.disposers.push(() => (wgeo.dispose(), bgeo.dispose(), bed.material.dispose()));
    }
    // 窪地の湖（リアルタイム表示で見つけた湖と同じ）。水面の三角形を、地形と同じように原点をずらして丸みで曲げる
    let lakeMesh = null;
    const lakeGrid = (s.water.lakes ?? 0) > 0 ? this.view.lakes : null;
    if (lakeGrid?.lakes.length) {
      const w = lakeMeshData(lakeGrid, t.size);
      const P = this.place, pcx = P.cx - P.ox, pcz = P.cz - P.oz, pp = [0, 0, 0];
      const pos = new Float32Array(w.length);
      for (let k = 0; k < w.length; k += 3) {
        curvePoint(w[k] - P.ox, w[k + 1], w[k + 2] - P.oz, pcx, pcz, P.R, pp);
        pos[k] = pp[0];
        pos[k + 1] = pp[1];
        pos[k + 2] = pp[2];
      }
      const lgeo = new THREE.BufferGeometry();
      lgeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      lgeo.computeVertexNormals();
      // 波の模様の範囲は、カメラにいちばん近い湖の高さで決める
      const cx = s.camera.position[0], cz = s.camera.position[2];
      let near = lakeGrid.lakes[0].level, nd = Infinity;
      for (let k = 0; k < w.length; k += 300) {
        const d = Math.hypot(w[k] - cx, w[k + 2] - cz);
        if (d < nd) (nd = d), (near = w[k + 1]);
      }
      const { wmat, waveC, waveW } = makeWater(near);
      addWaveUV(lgeo, waveC, waveW);
      lakeMesh = new THREE.Mesh(lgeo, wmat);
      scene.add(lakeMesh);
      this.disposers.push(() => lgeo.dispose());
    }

    // 物体（リアルタイム表示と同じ形と素材）。原点をずらし、置き場所を丸みで曲げる（天体は空にあるので曲げない）
    const P = this.place;
    const pp = [0, 0, 0];
    const celestialIds = new Set(s.objects.filter((o) => o.celestial).map((o) => o.id));
    for (const m of objectMeshes) {
      if (celestialIds.has(m.userData.kuniumiId)) {
        m.position.x -= P.ox;
        m.position.z -= P.oz;
      } else {
        curvePoint(m.position.x - P.ox, m.position.y, m.position.z - P.oz, 0, 0, P.R, pp);
        m.position.set(pp[0], pp[1], pp[2]);
      }
      m.updateMatrixWorld();
      scene.add(m);
    }

    // 木と草（同じ形を位置だけ変えて大量に置く）
    const plants = [];
    if (terrain.lod?.plants) {
      const P = terrain.lod.plants;
      // 自分のモデルで置き換える植物（植生の「自分のモデル」）。読めなければいつもの形のまま
      const custom = {};
      for (const [kind, m] of Object.entries(s.vegetation.models ?? {})) {
        if (!m?.glb) continue;
        try {
          custom[kind] = (await loadPlantModel(m.glb, { unitBy: kind === 'rock' ? 'max' : 'height' })).geometry;
        } catch (err) {
          console.warn(`植物のモデル（${kind}）を読めません`, err);
        }
      }
      const white = new THREE.Color(1, 1, 1);
      const add = (geo, color, list, opts = {}) => {
        if (!list.length) return;
        const mat = new THREE.MeshStandardMaterial({ color, roughness: opts.roughness ?? 0.85, metalness: 0, side: opts.side ?? THREE.FrontSide, vertexColors: !!geo.attributes.color });
        const mesh = new THREE.InstancedMesh(geo, mat, list.length / 5);
        fillInstances(mesh, list, opts.colorVar ?? 0, opts.seed ?? 1);
        scene.add(mesh);
        plants.push(mesh);
        this.disposers.push(() => (geo.dispose(), mat.dispose()));
      };
      // 置き場所の一覧を、形の違う 3 本へ振り分ける（同じ木が並ばないように）
      // first: 指定すると 2 つに分け、最初の組の割合をそれにする
      const split = (list, n, salt = 0, first = null) => {
        const out = Array.from({ length: n }, () => []);
        for (let k = 0; k < list.length; k += 5) {
          const h = Math.abs(Math.sin(list[k] * (12.9898 + salt) + list[k + 2] * (78.233 - salt * 3.1)) * 43758.5453) % 1;
          out[first !== null ? (h < first ? 0 : 1) : Math.min(n - 1, Math.floor(h * n))].push(list[k], list[k + 1], list[k + 2], list[k + 3], list[k + 4]);
        }
        return out;
      };
      const trunk = new THREE.Color('#4a3a2c');
      const conCol = new THREE.Color(s.terrain.season === 'winter' ? '#33433a' : '#1d3519');
      // 広葉樹の色は木ごとにばらつかせる（秋は赤・橙・黄・まだ緑の木が混ざる）
      const brdCols = ({
        spring: ['#4f8028', '#6a9a30', '#5d8a3a', '#7a9a3c', '#e4a9bd'], // 春は 5 本に 1 本ほど桜色
        autumn: ['#a8461a', '#c27a1c', '#b8962a', '#8c2c16', '#6a7026'],
        winter: ['#4d4136', '#584a3c', '#463c34'],
      }[s.terrain.season] ?? ['#325a22', '#3e6a26', '#2c4e20', '#4a6a2a']).map((c) => new THREE.Color(c));
      // 遠くの木（画面で背丈 40 画素より小さく見えるもの）は軽い形にする。細かい形は 1 本 1 万枚以上の三角形で、
      // 十数万本すべてを細かくすると光線の計算も GPU の記憶も重くなる（重い場面で GPU が打ち切られる原因になる）
      const camL = [s.camera.position[0] - this.place.ox, s.camera.position[1], s.camera.position[2] - this.place.oz];
      const focalPx = s.render.still.height / (2 * Math.tan(((s.camera.fov ?? 50) * Math.PI) / 360));
      const nearFar = (list) => {
        const near = [], far = [];
        for (let k = 0; k < list.length; k += 5) {
          const d = Math.hypot(list[k] - camL[0], list[k + 1] - camL[1], list[k + 2] - camL[2]);
          (list[k + 3] * focalPx >= 40 * d ? near : far).push(list[k], list[k + 1], list[k + 2], list[k + 3], list[k + 4]);
        }
        return [near, far];
      };
      // 軽い形（リアルタイム表示の木）。細かい形の葉の平均の明るさに合わせて頂点の色を塗る
      const shade = (g, v) => {
        g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 3).fill(v), 3));
        return g;
      };
      const lite = {};
      const liteConifer = () => (lite.c ??= (({ trunk, crown }) => ({ trunk: shade(trunk, 1), crown: shade(crown, 0.72) }))(coniferGeometry()));
      const liteBroadleaf = () => (lite.b ??= (({ trunk, crown }) => ({ trunk: shade(trunk, 1), crown: shade(crown, 0.75) }))(broadleafGeometry()));
      const [conNear, conFar] = custom.conifer ? [[], []] : nearFar(P.conifer);
      if (custom.conifer) add(custom.conifer.clone(), white, P.conifer, { side: THREE.DoubleSide, colorVar: 0.25, seed: 3 });
      // 冬：雪の積もる高さより上の針葉樹は、上を向いた葉に雪を乗せる（素材の色は頂点の色に掛かるので、
      // 雪の木は素材を白にして、緑と雪を頂点の色に焼き込む）
      const winter = s.terrain.season === 'winter';
      const wsY = (s.terrain.winterSnow ?? 600) + 50;
      const snowyCrown = (g) => {
        const c = g.clone(), col = c.attributes.color, n = c.attributes.normal;
        const base = conCol.clone(); // 線形の色
        for (let i = 0; i < col.count; i++) {
          const k = Math.min(1, Math.max(0, (n.getY(i) - 0.25) / 0.6)) * 0.85;
          col.setXYZ(i, base.r * col.getX(i) * (1 - k) + 0.85 * k, base.g * col.getY(i) * (1 - k) + 0.88 * k, base.b * col.getZ(i) * (1 - k) + 0.93 * k);
        }
        col.needsUpdate = true;
        return c;
      };
      split(conNear, 3).forEach((list, i) => {
        const g = detailedConifer(i + 1);
        add(g.trunk, trunk, list);
        if (!winter) return add(g.crown, conCol, list, { side: THREE.DoubleSide, colorVar: 0.25, seed: 3 + i });
        const snowy = [], bare = [];
        for (let k = 0; k < list.length; k += 5) (list[k + 1] > wsY ? snowy : bare).push(list[k], list[k + 1], list[k + 2], list[k + 3], list[k + 4]);
        add(g.crown, conCol, bare, { side: THREE.DoubleSide, colorVar: 0.25, seed: 3 + i });
        add(snowyCrown(g.crown), new THREE.Color(1, 1, 1), snowy, { side: THREE.DoubleSide, colorVar: 0.15, seed: 3 + i });
      });
      if (conFar.length) {
        const g = liteConifer();
        add(g.trunk, trunk, conFar);
        add(g.crown, conCol, conFar, { colorVar: 0.25, seed: 4 });
      }
      this.stats.treesLite = (conFar.length) / 5;
      // 熱帯：広葉樹の一部をヤシに（割合は植生の「熱帯」）
      const tropical = Math.max(0, Math.min(1, s.vegetation.tropical ?? 0));
      const [palms, broad] = split(P.broadleaf, 2, 3.7, tropical);
      const palmTrunk = new THREE.Color('#7d6e5a'), palmCol = new THREE.Color(s.terrain.season === 'winter' ? '#5a6a3a' : '#4a7a2a');
      split(palms, 3).forEach((list, i) => {
        const g = detailedPalm(i + 1);
        add(g.trunk, palmTrunk, list);
        add(g.crown, palmCol, list, { side: THREE.DoubleSide, colorVar: 0.3, seed: 51 + i, roughness: 0.6 });
      });
      const [broadNear, broadFar] = custom.broadleaf ? [[], []] : nearFar(broad);
      if (custom.broadleaf) add(custom.broadleaf.clone(), white, broad, { side: THREE.DoubleSide, colorVar: 0.3, seed: 5 });
      if (broadFar.length) {
        const g = liteBroadleaf();
        add(g.trunk, trunk, broadFar);
        split(broadFar, brdCols.length, 7.3).forEach((sub, j) => add(j ? g.crown.clone() : g.crown, brdCols[j], sub, { colorVar: 0.3, seed: 60 + j, roughness: 0.7 }));
        this.stats.treesLite += broadFar.length / 5;
      }
      split(broadNear, 3).forEach((list, i) => {
        const g = detailedBroadleaf(i + 1);
        add(g.trunk, trunk, list);
        split(list, brdCols.length, 7.3).forEach((sub, j) => add(j ? g.crown.clone() : g.crown, brdCols[j], sub, { side: THREE.DoubleSide, colorVar: 0.3, seed: 5 + i * 7 + j, roughness: 0.7 }));
      });
      // 草の葉の色：低地の色から。季節で枯れ色へ寄せる（秋は黄土色、冬は枯れ草色）
      const grassCol = new THREE.Color(s.terrain.palette.low).lerp(new THREE.Color('#9fa84a'), 0.25);
      if (s.terrain.season === 'autumn') grassCol.lerp(new THREE.Color('#a58c4c'), 0.55);
      else if (s.terrain.season === 'winter') grassCol.lerp(new THREE.Color('#8f7c5c'), 0.7);
      else if (s.terrain.season === 'spring') grassCol.lerp(new THREE.Color('#7fb048'), 0.3);
      const grassLists = split(P.grass, 3);
      if (custom.grass) add(custom.grass.clone(), white, P.grass, { side: THREE.DoubleSide, roughness: 0.6, colorVar: 0.35, seed: 9 });
      else grassLists.forEach((list, i) => add(detailedGrass(i + 1), grassCol, list, { side: THREE.DoubleSide, roughness: 0.6, colorVar: 0.35, seed: 9 + i }));
      // 岩と石（形の違う 4 種）。色は大地の岩の色を明るめに
      // 岩の色：大地の岩肌の色に少しだけ明るい灰色を混ぜる（強く寄せると草の斜面で白く光って浮く）
      const rockCol = new THREE.Color(s.terrain.palette.rock).lerp(new THREE.Color('#8e8880'), 0.3);
      if (custom.rock) add(custom.rock.clone(), white, P.rocks ?? [], { roughness: 0.9, colorVar: 0.25, seed: 21 });
      else split(P.rocks ?? [], 4).forEach((list, i) => add(detailedRock(i + 1), rockCol, list, { roughness: 0.9, colorVar: 0.25, seed: 21 + i }));
      // シダ（森の下草）
      const fernCol = new THREE.Color(s.terrain.season === 'autumn' ? '#5a6a26' : '#3a6a22');
      if (s.terrain.season !== 'winter') {
        // 熱帯では、下草の一部が幅広の葉の株に
        const [trop, ferns] = split(P.ferns ?? [], 2, 5.1, tropical * 0.6);
        if (custom.fern) add(custom.fern.clone(), white, ferns, { side: THREE.DoubleSide, roughness: 0.65, colorVar: 0.3, seed: 41 });
        else split(ferns, 2).forEach((list, i) => add(detailedFern(i + 1), fernCol, list, { side: THREE.DoubleSide, roughness: 0.65, colorVar: 0.3, seed: 41 + i }));
        split(trop, 2).forEach((list, i) => add(detailedTropicalPlant(i + 1), new THREE.Color('#3f7a28'), list, { side: THREE.DoubleSide, roughness: 0.5, colorVar: 0.35, seed: 45 + i }));
      }
      // 落ち葉・落ち針（木の下）。季節で色を変える（秋は鮮やかな赤茶、ほかは枯れた茶）
      const litterCol = new THREE.Color({ autumn: '#9a5424', winter: '#5e4a38', spring: '#5f4c34' }[s.terrain.season] ?? '#5a4630');
      split(P.litter ?? [], 2).forEach((list, i) => add(detailedLitter(i + 1), litterCol, list, { side: THREE.DoubleSide, roughness: 0.85, colorVar: 0.3, seed: 71 + i }));
      split(P.needles ?? [], 2).forEach((list, i) => add(detailedLitter(i + 1, true), new THREE.Color('#6a4a2e'), list, { side: THREE.DoubleSide, roughness: 0.85, colorVar: 0.25, seed: 75 + i }));
      // 葦（水際）。季節で色を変える（秋冬は枯れ色）
      const reedCol = new THREE.Color({ spring: '#6f8a3c', autumn: '#a08a52', winter: '#9a8a68' }[s.terrain.season] ?? '#6a7d38');
      split(P.reeds ?? [], 2).forEach((list, i) => add(detailedReeds(i + 1), reedCol, list, { side: THREE.DoubleSide, roughness: 0.6, colorVar: 0.25, seed: 31 + i }));
      // 野の花：草の株のうち「野の花」の割合（既定は 4 つに 1 つ。冬は咲かない）
      const flowerK = s.vegetation.flowers ?? 0.25;
      if (s.terrain.season !== 'winter' && flowerK > 0) {
        const fl = [];
        for (let k = 0; k < P.grass.length; k += 5) {
          const h = Math.abs(Math.sin(P.grass[k] * 3.17 + P.grass[k + 2] * 7.31) * 43758.5453) % 1;
          if (h < flowerK) fl.push(P.grass[k], P.grass[k + 1], P.grass[k + 2], P.grass[k + 3], P.grass[k + 4]);
        }
        add(detailedFlowers(1), new THREE.Color(1, 1, 1), fl, { side: THREE.DoubleSide, roughness: 0.6, colorVar: 0.1, seed: 13 });
      }
      this.stats.trees = (P.conifer.length + P.broadleaf.length) / 5;
      this.stats.grass = P.grass.length / 5;
    }

    // 空：全天の HDR 画像を光源と背景にする（太陽円盤を含む）
    const dir = sunDirection(s.sun.elevation, s.sun.azimuth);
    const p = skyParams(s.atmosphere, dir);
    const [ew, eh] = ENV_SIZE;
    // 雲は厚みのある立体として後から描くので、全天画像には入れない
    // 照明用：パストレーサは環境光を半精度（最大 65504）で持つので、太陽円盤を広げて薄め、総量はそのまま収める。
    // 背景用：見た目の太陽の大きさは本物のまま（切り詰められても見た目には眩しいだけで差がない）
    const discScale = discScaleFor(Math.max(...sunIrradiance(p)) * s.sun.intensity);
    // 丸い星の地平線の下がり角：カメラの高さ h、半径 R のとき acos(R / (R + h))（小さな星では大きく、空が下まで回り込む）
    const R0 = this.place.R;
    const camH = Math.max(1, s.camera.position[1] - (s.water.enabled ? s.water.level : s.terrain.baseHeight));
    const horizonDip = R0 > 0 ? Math.acos(R0 / (R0 + camH)) : 0;
    const opts = { skyScale: s.atmosphere.ambient, sunScale: s.sun.intensity, clouds: false, horizonDip };
    const mkEnv = (data) => {
      const tex = new THREE.DataTexture(data, ew, eh, THREE.RGBAFormat, THREE.FloatType);
      tex.mapping = THREE.EquirectangularReflectionMapping;
      tex.colorSpace = THREE.NoColorSpace;
      tex.minFilter = tex.magFilter = THREE.LinearFilter;
      tex.needsUpdate = true;
      textures.push(tex);
      return tex;
    };
    // 夜は月明かり・星明かり程度の青い光を空に足す（リアルタイム表示の夜の光と同じ明るさ）
    const night = nightFactor(s.sun.elevation);
    // withBow：虹も描くか（背景だけ。水面に映る周りの光には入れない）
    const addNight = (data, withBow = false) => {
      if (night <= 0) {
        if (!withBow) addMoon(data); // 背景の月は画面の細かさで後から描く（addMoonScreen）
        addExtras(data, withBow);
        return data;
      }
      for (let r = 0; r < eh; r++) {
        const up = Math.max(0.15, Math.min(1, (r / eh - 0.5) * 2 + 0.3)); // 上ほど明るい（行 0 = 真下、最後の行 = 真上）
        for (let c = 0; c < ew; c++) {
          const o = (r * ew + c) * 4;
          for (let k = 0; k < 3; k++) data[o + k] += NIGHT_SKY[k] * night * up;
        }
      }
      if (!withBow) addMoon(data);
      addExtras(data, withBow);
      return data;
    };
    // オーロラと虹：リアルタイム表示と同じ式・同じ強さで空に描き込む（core/skyExtras.js）
    function addExtras(data, withBow) {
      const a = s.atmosphere;
      const exposure = Math.max(0.02, a.exposure);
      const geo = s.terrain.mode === 'heightmap' ? s.terrain.heightmap?.geo : null;
      const aur = (a.aurora ?? 0) * (1 - 0.85 * (a.clouds ?? 0)) * night * (0.35 / exposure);
      const rainy = a.precip === 'rain' || a.precip === 'storm';
      const el = s.sun.elevation;
      const bow = rainy && withBow ? THREE.MathUtils.smoothstep(el, 1, 5) * (1 - THREE.MathUtils.smoothstep(el, 34, 42)) * (1 - 0.6 * (a.clouds ?? 0)) * (0.15 / exposure) : 0;
      if (aur <= 0.001 && bow <= 0.001) return;
      const S = sunDirection(el, s.sun.azimuth);
      const anti = [-S[0], -S[1], -S[2]];
      const north = (geo?.lat ?? 1) < 0 ? -1 : 1;
      const add = [0, 0, 0];
      for (let r = eh >> 1; r < eh; r++) {
        const lat = ((r + 0.5) / eh - 0.5) * Math.PI;
        const y = Math.sin(lat), cl = Math.cos(lat);
        for (let c = 0; c < ew; c++) {
          const phi = ((c + 0.5) / ew - 0.5) * 2 * Math.PI;
          const d = [Math.cos(phi) * cl, y, Math.sin(phi) * cl];
          add[0] = add[1] = add[2] = 0;
          if (aur > 0.001) addAurora(d, north, 0, add, aur);
          if (bow > 0.001) addRainbow(d, anti, add, bow);
          const o = (r * ew + c) * 4;
          data[o] += add[0];
          data[o + 1] += add[1];
          data[o + 2] += add[2];
        }
      }
    }
    // 月：リアルタイム表示と同じ位置・満ち欠け・大きさ（1.5°）の円盤を空に描き込む（背景に映り、わずかに照らす）
    function addMoon(data) {
      const age = s.sun.moonAge ?? 12;
      if (moonIllumination(age) < 0.01) return;
      const S = sunDirection(s.sun.elevation, s.sun.azimuth);
      const m = moonDirection(S, age);
      if (m[1] < -0.02) return;
      const rho = THREE.MathUtils.degToRad(0.75), sinR = Math.sin(rho), cosR = Math.cos(rho);
      // 夜は表示で白く見える明るさ、昼は空に溶けて淡く（リアルタイム表示と同じ考え）
      const gain = (0.9 / Math.max(0.02, s.atmosphere.exposure)) * (1 - 0.75 * (1 - night));
      const r0 = Math.max(0, Math.floor(((Math.asin(m[1]) - rho * 2) / Math.PI + 0.5) * eh) - 1);
      const r1 = Math.min(eh - 1, Math.ceil(((Math.asin(m[1]) + rho * 2) / Math.PI + 0.5) * eh) + 1);
      for (let r = r0; r <= r1; r++) {
        const lat = ((r + 0.5) / eh - 0.5) * Math.PI;
        const y = Math.sin(lat), cl = Math.cos(lat);
        for (let c = 0; c < ew; c++) {
          const phi = ((c + 0.5) / ew - 0.5) * 2 * Math.PI;
          const d = [Math.cos(phi) * cl, y, Math.sin(phi) * cl];
          const cm = d[0] * m[0] + d[1] * m[1] + d[2] * m[2];
          if (cm < cosR) continue;
          // 円盤の上の点の法線：中心からのずれ（横）と、こちら向き（−m）から
          const o = [(d[0] - m[0] * cm) / sinR, (d[1] - m[1] * cm) / sinR, (d[2] - m[2] * cm) / sinR];
          const x2 = Math.min(1, o[0] * o[0] + o[1] * o[1] + o[2] * o[2]);
          const z = Math.sqrt(1 - x2);
          const n = [o[0] - m[0] * z, o[1] - m[1] * z, o[2] - m[2] * z];
          const lit = THREE.MathUtils.smoothstep(n[0] * S[0] + n[1] * S[1] + n[2] * S[2], -0.04, 0.12) + 0.01;
          const v = gain * lit * (y > 0 ? 1 : 0.5);
          const off = (r * ew + c) * 4;
          data[off] += v;
          data[off + 1] += v * 0.97;
          data[off + 2] += v * 0.9;
        }
      }
    }
    // 厚い雲の下では、空の光を灰色へ（雲を通った光。晴れの空の色のままだと、雷雨でもセピア色の絵になる）
    const ov = overcastAmount(s.atmosphere);
    const grey = (d) => {
      if (ov <= 0) return d;
      for (let i = 0; i < d.length; i += 4) {
        const L = d[i] * 0.2126 + d[i + 1] * 0.7152 + d[i + 2] * 0.0722;
        d[i] += (L * 0.95 - d[i]) * ov;
        d[i + 1] += (L - d[i + 1]) * ov;
        d[i + 2] += (L * 1.08 - d[i + 2]) * ov;
      }
      return d;
    };
    // 厚い雲が空を覆うと、直射日光は雲に遮られて地面まで届かない（光源の全天画像には雲が入っていないので、
    // そのままでは雷雨の山にも晴れの日のくっきりした影が落ちた）。光源の太陽だけを雲の量に応じて弱める
    const sunThrough = 1 - 0.92 * Math.min(1, ov / 0.85);
    scene.environment = mkEnv(addNight(grey(renderSkyEquirect(p, ew, eh, { ...opts, sunScale: opts.sunScale * sunThrough, discScale }))));
    // 背景は見た目だけなので、半精度に収まるよう太陽の芯だけ頭打ちにする（眩しさは変わらない）
    const bg = addNight(grey(renderSkyEquirect(p, ew, eh, opts)), true);
    // 夜空の星と天の川（リアルタイム表示の RealtimeAtmosphere と同じ式）。背景の見た目だけで、光源には入れない
    const starK = night * (1 - 0.85 * (s.atmosphere.clouds ?? 0)) * (8 / Math.max(0.02, s.atmosphere.exposure / 0.12));
    if (starK > 0.01) addStarsAndMilkyWay(bg, ew, eh, starK, s.atmosphere.exposure, false); // 星は画面の細かさで後から（addStarsScreen）
    for (let i = 0; i < bg.length; i++) if (bg[i] > 65000) bg[i] = 65000;
    const rainy = s.atmosphere.precip === 'rain' || s.atmosphere.precip === 'storm';
    // 見えている月（背景は画面の細かさで描くので、光源とは別の背景にする）
    const moonAge = s.sun.moonAge ?? 12;
    const moonDir = moonDirection(sunDirection(s.sun.elevation, s.sun.azimuth), moonAge);
    const moon = moonIllumination(moonAge) >= 0.01 && moonDir[1] >= -0.02 ? { dir: moonDir, sun: sunDirection(s.sun.elevation, s.sun.azimuth), gain: (0.9 / Math.max(0.02, s.atmosphere.exposure)) * (1 - 0.75 * (1 - night)) } : null;
    scene.background = discScale > 1 || rainy || starK > 0.01 || moon ? mkEnv(bg) : scene.environment;

    scene.updateMatrixWorld(true);
    return { starK, moon, scene, terrainMesh, surroundMesh, water, lakeMesh, plants, buildingMeshes, textures, skyP: p, skyBG: { data: bg, w: ew, h: eh } };
  }

  #camera(s, aspect) {
    const P = this.place;
    // パストレーサは「手前の面」と「奥の面」の点から光線を作るので、near と far の比が大きすぎると
    // 計算が壊れて（NaN）GPU が止まる。比は 10 万倍までにし、地面からの高さに合わせて決める
    const [px, py, pz] = s.camera.position;
    const above = Math.max(10, py - Math.max(s.water.enabled ? s.water.level : -Infinity, this.view.gpuTerrain.heightAt(px, pz)));
    const near = Math.min(2000, Math.max(0.3, above * 0.03));
    const far = Math.max(near * 1e5, 1e5);
    // 被写界深度：ぼけの強さがあれば、レンズの口径の中から光線を出すカメラ。
    // 景色は実寸 (m) なので、写真のレンズ（口径 数 cm）では数 km 先がほとんどぼけない。強さ 1 で口径 20 cm
    const st = s.render.still;
    const dof = (st.bokeh ?? 0) > 0;
    const cam = dof ? new PhysicalCamera(s.camera.fov, aspect, near, far) : new THREE.PerspectiveCamera(s.camera.fov, aspect, near, far);
    const [x, y, z] = s.camera.position;
    const c = curvePoint(x - P.ox, y, z - P.oz, 0, 0, P.R);
    cam.position.set(c[0], c[1], c[2]);
    const tg = s.camera.target;
    const look = new THREE.Vector3(tg[0] - P.ox, tg[1], tg[2] - P.oz);
    cam.lookAt(look);
    if (dof) {
      cam.bokehSize = st.bokeh * 200; // 口径 (mm)
      cam.focusDistance = st.focus > 0 ? st.focus : cam.position.distanceTo(look);
      cam.apertureBlades = 6; // 六角形の絞り（玉ぼけの形）
    }
    cam.updateMatrixWorld();
    return cam;
  }

  // パストレースの結果（ノイズ除去後）を線形 HDR のまま読み出す。行0 = 画像の上
  async #readHDR(renderer, pt, W, H) {
    const rt = new THREE.RenderTarget(W, H, { type: THREE.FloatType, depthBuffer: false });
    renderer.setRenderTarget(rt);
    pt.renderSample(); // 打ち切り済みなのでサンプルは増えず、結果を rt へ描くだけ
    renderer.setRenderTarget(null);
    const px = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, W, H);
    rt.dispose();
    const out = new Float32Array(W * H * 4);
    out.set(px.subarray(0, out.length));
    if (this.readFlipY) flipRows(out, W, H);
    return out;
  }

  // 雲の影・立体的な霧（光の筋）を GPU で計算し、パストレースの結果に重ねる
  #applyAtmosphere(hdr, s, built, objectMeshes, celestial, camera, W, H) {
    const a = s.atmosphere;
    const p = built.skyP;
    // 空からの光（水平面への放射照度）：全天画像の上半分を積分
    const LW = 128, LH = 64;
    const lut = renderSkyEquirect(p, LW, LH, { sunDisc: false, clouds: false, skyScale: a.ambient });
    let skyE = 0;
    for (let r = LH / 2; r < LH; r++) {
      const lat = ((r + 0.5) / LH - 0.5) * Math.PI;
      const dw = Math.cos(lat) * (Math.PI / LH) * ((2 * Math.PI) / LW);
      for (let c = 0; c < LW; c++) {
        const o = (r * LW + c) * 4;
        skyE += (lut[o] * 0.2126 + lut[o + 1] * 0.7152 + lut[o + 2] * 0.0722) * Math.sin(lat) * dw;
      }
    }
    const meshes = [{ object: built.terrainMesh }];
    if (built.surroundMesh) meshes.push({ object: built.surroundMesh });
    if (built.water) meshes.push({ object: built.water, noShadow: true });
    if (built.lakeMesh) meshes.push({ object: built.lakeMesh, noShadow: true });
    for (const m of built.plants) meshes.push({ object: m });
    for (const m of built.buildingMeshes ?? []) meshes.push({ object: m });
    for (const m of objectMeshes) meshes.push({ object: m, celestial: celestial.has(m.userData.kuniumiId) });
    const P = this.place;
    const view = { origin: [P.ox, P.oz], planetR: P.R, cam: [0, 0, 0] };
    // 光の筋の影の地図は注視点の周りだけ（数千 km の大地全体では細かさが足りない）
    const tg = new THREE.Vector3(0, s.camera.target[1], 0);
    const radius = Math.min(Math.max(3000, camera.position.distanceTo(tg) * 3), Math.max(3000, Math.min(s.terrain.size * 0.75, 200000)));
    const shadowBounds = s.terrain.size > 60000 ? { center: tg, radius } : null;
    // 天体は空気の向こうにある：その向きの空の明るさ（手前の空気が散らす光）を重ね、空気の厚みのぶん少し暗くする。
    // 昼や夕方は昼の月のように淡くかすみ、夜はくっきり見える
    const celMeshes = objectMeshes.filter((m) => celestial.has(m.userData.kuniumiId));
    if (celMeshes.length && built.skyBG) {
      const others = [built.terrainMesh, built.surroundMesh, built.water, built.lakeMesh, ...built.plants, ...(built.buildingMeshes ?? []), ...objectMeshes.filter((m) => !celestial.has(m.userData.kuniumiId))].filter(Boolean);
      const mask = renderMask(this.view.renderer, celMeshes, others, camera, W, H);
      const { data: bg, w: ew, h: eh } = built.skyBG;
      const ip = camera.projectionMatrixInverse, cw = camera.matrixWorld;
      const v = new THREE.Vector3();
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const k = mask[y * W + x];
          if (k <= 0) continue;
          v.set(((x + 0.5) / W) * 2 - 1, 1 - ((y + 0.5) / H) * 2, 0.5).applyMatrix4(ip).transformDirection(cw);
          // 空の画像（正距円筒、行 0 = 真下）から、その向きの空の明るさ
          const lat = Math.asin(Math.max(-1, Math.min(1, v.y))), phi = Math.atan2(v.z, v.x);
          const r = Math.min(eh - 1, Math.max(0, Math.floor((lat / Math.PI + 0.5) * eh)));
          const c = Math.min(ew - 1, Math.max(0, Math.floor((phi / (2 * Math.PI) + 0.5) * ew)));
          const so = (r * ew + c) * 4;
          // 空気の厚み（低いほど厚い）で天体の光が弱まる
          const T = Math.exp(-0.12 / Math.max(0.06, v.y + 0.04));
          const o = (y * W + x) * 4;
          for (let ch = 0; ch < 3; ch++) hdr[o + ch] = hdr[o + ch] * (1 - k) + (hdr[o + ch] * T + bg[so + ch]) * k;
        }
      }
    }
    const res = computeAtmosphere(this.view.renderer, meshes, camera, W, H, { ...atmosphereParams(s), skyE, view, shadowBounds, waterLevel: s.water.enabled ? s.water.level : null });
    for (let i = 0, n = W * H; i < n; i++) {
      const o = i * 4, m = res.surface[i], T = res.inscatter[o + 3];
      for (let c = 0; c < 3; c++) hdr[o + c] = hdr[o + c] * m * T + res.inscatter[o + c];
    }
  }
}

// 光のにじみ：明るい所をぼかして薄く重ねる（レンズと大気の散乱の近似）。エネルギーは保つ
function applyBloom(hdr, W, H, amount) {
  const f = 4;
  const w = Math.ceil(W / f), h = Math.ceil(H / f);
  const small = new Float32Array(w * h * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4, so = ((y / f | 0) * w + (x / f | 0)) * 3;
      small[so] += hdr[o] / (f * f);
      small[so + 1] += hdr[o + 1] / (f * f);
      small[so + 2] += hdr[o + 2] / (f * f);
    }
  }
  const tmp = new Float32Array(small.length);
  // 箱型のぼかしを 5 回重ねてガウス分布に近づける（3 回では太陽のような強い光のにじみが四角く見えた）。
  // 回数を増やしたぶん半径を縮め、広がりは同じくらいに
  const r = Math.max(2, Math.round(w * 0.012 * Math.sqrt(3 / 5)));
  for (let pass = 0; pass < 5; pass++) {
    boxBlur(small, tmp, w, h, r, true);
    boxBlur(tmp, small, w, h, r, false);
  }
  // 縮めた絵を双一次補間で戻す（最近傍では 4×4 画素の段が見えた）
  for (let y = 0; y < H; y++) {
    const fy = Math.min(h - 1, Math.max(0, (y + 0.5) / f - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(h - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < W; x++) {
      const fx = Math.min(w - 1, Math.max(0, (x + 0.5) / f - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(w - 1, x0 + 1), tx = fx - x0;
      const a00 = (y0 * w + x0) * 3, a10 = (y0 * w + x1) * 3, a01 = (y1 * w + x0) * 3, a11 = (y1 * w + x1) * 3;
      const o = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) {
        const v = (small[a00 + c] * (1 - tx) + small[a10 + c] * tx) * (1 - ty) + (small[a01 + c] * (1 - tx) + small[a11 + c] * tx) * ty;
        hdr[o + c] = hdr[o + c] * (1 - amount) + v * amount;
      }
    }
  }
}

function boxBlur(src, dst, w, h, r, horizontal) {
  const n = horizontal ? w : h, m = horizontal ? h : w;
  for (let j = 0; j < m; j++) {
    for (let c = 0; c < 3; c++) {
      let acc = 0;
      const at = (i) => {
        const ii = Math.min(n - 1, Math.max(0, i));
        return src[((horizontal ? j * w + ii : ii * w + j) * 3) + c];
      };
      for (let i = -r; i <= r; i++) acc += at(i);
      for (let i = 0; i < n; i++) {
        dst[((horizontal ? j * w + i : i * w + j) * 3) + c] = acc / (2 * r + 1);
        acc += at(i + r + 1) - at(i - r);
      }
    }
  }
}

function flipRows(data, W, H) {
  const row = new Float32Array(W * 4);
  for (let y = 0; y < H / 2; y++) {
    const a = y * W * 4, b = (H - 1 - y) * W * 4;
    row.set(data.subarray(a, a + W * 4));
    data.copyWithin(a, b, b + W * 4);
    data.set(row, b);
  }
}

// 丸い星の水面（と海底）：注視点（原点）を中心に、近くは細かく遠くは粗い同心円の円盤を、標高 level の球面に沿って曲げる
// 波の法線マップ（size 画素四方で W m 四方を覆う。繰り返さない）。風向きのまわりに散らした波を重ねる。
// 接線の空間は 接線 = +x、従法線 = −z（addWaveUV の接線と合わせる）。縁へ向かって平らに戻す（範囲の外と継ぎ目を作らない）
function waveNormalMap(size, W, distortion, waveScale, seed) {
  let st = seed * 9301 + 49297;
  const rand = () => ((st = (st * 233280 + 49297) % 2147483647) / 2147483647 + 1) % 1;
  const texel = W / size;
  const lMin = texel * 3, lMax = Math.max(lMin * 4, Math.min(W / 5, 60 * Math.max(0.3, waveScale)));
  const slope = 0.09 * Math.min(2, Math.max(0.25, distortion / 3));
  const wind = rand() * Math.PI * 2;
  const NW = 28;
  const waves = [];
  for (let i = 0; i < NW; i++) {
    const lam = lMin * Math.pow(lMax / lMin, (i + rand()) / NW);
    const dir = wind + (rand() - 0.5) * 2.4;
    const k = (Math.PI * 2) / lam;
    waves.push({ kx: Math.cos(dir) * k, kz: Math.sin(dir) * k, s: (slope / Math.sqrt(NW)) * (0.6 + rand() * 0.8), ph: rand() * Math.PI * 2 });
  }
  const data = new Uint8Array(size * size * 4);
  for (let j = 0; j < size; j++) {
    const z = (j / (size - 1) - 0.5) * W;
    for (let i = 0; i < size; i++) {
      const x = (i / (size - 1) - 0.5) * W;
      let hx = 0, hz = 0;
      for (const w of waves) {
        // 高さ = Σ (s/k) sin(k·p + φ) なので、傾きは s cos(k·p + φ) × 波の向き
        const c = Math.cos(w.kx * x + w.kz * z + w.ph) * w.s;
        const kl = Math.hypot(w.kx, w.kz);
        hx += c * (w.kx / kl);
        hz += c * (w.kz / kl);
      }
      // 縁の 25% で平らへ（範囲の外の、粗さで表す水面となめらかにつなぐ）
      const e = Math.min(i, j, size - 1 - i, size - 1 - j) / (size * 0.25);
      const f = Math.min(1, e) * Math.min(1, e);
      hx *= f;
      hz *= f;
      const l = Math.hypot(hx, 1, hz);
      const o = (j * size + i) * 4;
      data[o] = ((-hx / l) * 0.5 + 0.5) * 255;
      data[o + 1] = ((hz / l) * 0.5 + 0.5) * 255;
      data[o + 2] = ((1 / l) * 0.5 + 0.5) * 255;
      data[o + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// 水面に、波の法線マップ用の UV（c を中心に W m 四方で 0..1）と接線（+x を面に沿わせたもの）を付ける
function addWaveUV(geo, c, W) {
  const p = geo.attributes.position;
  if (!geo.attributes.normal) geo.computeVertexNormals();
  const n = geo.attributes.normal;
  const uv = new Float32Array(p.count * 2), tan = new Float32Array(p.count * 4);
  for (let i = 0; i < p.count; i++) {
    uv[i * 2] = (p.getX(i) - c[0]) / W + 0.5;
    uv[i * 2 + 1] = (p.getZ(i) - c[1]) / W + 0.5;
    const nx = n.getX(i), ny = n.getY(i), nz = n.getZ(i);
    let tx = 1 - nx * nx, ty = -nx * ny, tz = -nx * nz;
    const l = Math.hypot(tx, ty, tz) || 1;
    tan.set([tx / l, ty / l, tz / l, 1], i * 4);
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('tangent', new THREE.BufferAttribute(tan, 4));
}

function curvedDisc(R, level, maxR = Math.PI * R * 0.98, SEG = DISC_SEG, ratio = DISC_RATIO) {
  const radii = [0];
  for (let r = 2; r < maxR; r *= ratio) radii.push(r);
  radii.push(maxR);
  const pos = new Float32Array((1 + (radii.length - 1) * SEG) * 3);
  const p = [0, 0, 0];
  curvePoint(0, level, 0, 0, 0, R, p);
  pos.set(p, 0);
  let v = 1;
  for (let k = 1; k < radii.length; k++) {
    for (let i = 0; i < SEG; i++, v++) {
      const a = (i / SEG) * Math.PI * 2;
      curvePoint(Math.cos(a) * radii[k], level, Math.sin(a) * radii[k], 0, 0, R, p);
      pos.set(p, v * 3);
    }
  }
  const index = [];
  for (let i = 0; i < SEG; i++) index.push(0, 1 + ((i + 1) % SEG), 1 + i);
  for (let k = 1; k < radii.length - 1; k++) {
    const a0 = 1 + (k - 1) * SEG, b0 = 1 + k * SEG;
    for (let i = 0; i < SEG; i++) {
      const i1 = (i + 1) % SEG;
      index.push(a0 + i, b0 + i1, b0 + i, a0 + i, a0 + i1, b0 + i1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

// ---- 夜空：星と天の川（RealtimeAtmosphere.js の GLSL と同じ式を、全天画像に描き込む） ----
const MW_POLE = (() => { const v = [0.42, 0.55, -0.72], l = Math.hypot(...v); return v.map((x) => x / l); })();
const MW_CENTER = (() => { const v = [-0.62, 0.2, -0.24], l = Math.hypot(...v); return v.map((x) => x / l); })();
const fract = (x) => x - Math.floor(x);
function sHash(x, y, z) {
  x = fract(x * 0.3183099 + 0.1) * 17;
  y = fract(y * 0.3183099 + 0.1) * 17;
  z = fract(z * 0.3183099 + 0.1) * 17;
  return fract(x * y * z * (x + y + z));
}
function mwNoise(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  let fx = x - ix, fy = y - iy, fz = z - iz;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  fz = fz * fz * (3 - 2 * fz);
  const h = (a, b, c) => sHash(ix + a, iy + b, iz + c);
  const l = (a, b, t) => a + (b - a) * t;
  return l(l(l(h(0, 0, 0), h(1, 0, 0), fx), l(h(0, 1, 0), h(1, 1, 0), fx), fy), l(l(h(0, 0, 1), h(1, 0, 1), fx), l(h(0, 1, 1), h(1, 1, 1), fx), fy), fz);
}
function milkyBand(d) {
  const lat = d[0] * MW_POLE[0] + d[1] * MW_POLE[1] + d[2] * MW_POLE[2];
  const core = Math.max(0, d[0] * MW_CENTER[0] + d[1] * MW_CENTER[1] + d[2] * MW_CENTER[2]);
  const w = 0.12 + 0.1 * core;
  return Math.exp(-(lat * lat) / (w * w)) * (0.35 + 0.65 * core * core);
}
// data: 全天画像（行 0 = 真下）。k: 星の明るさ（リアルタイムの starI と同じ尺度）、exposure: 空の明るさとの比べに使う露出
function addStarsAndMilkyWay(data, ew, eh, k, exposure, stars = true) {
  const pixAng = (2 * Math.PI) / ew; // 1 画素の角度
  const d = [0, 0, 0], st3 = [0, 0, 0];
  for (let r = Math.floor(eh / 2); r < eh; r++) {
    const lat = ((r + 0.5) / eh - 0.5) * Math.PI;
    const y = Math.sin(lat), cl = Math.cos(lat);
    for (let c = 0; c < ew; c++) {
      const phi = ((c + 0.5) / ew - 0.5) * 2 * Math.PI;
      d[0] = Math.cos(phi) * cl; d[1] = y; d[2] = Math.sin(phi) * cl;
      const o = (r * ew + c) * 4;
      const lum = (data[o] * 0.2126 + data[o + 1] * 0.7152 + data[o + 2] * 0.0722) * exposure;
      const fade = Math.exp(-lum * 6) * Math.min(1, Math.max(0, (y + 0.02) / 0.08)); // 明るい空と地平線では見えない
      if (fade < 0.01) continue;
      let sr = 0, sg = 0, sb = 0;
      // 天の川
      const b = milkyBand(d);
      if (b > 0.01) {
        const n = mwNoise(d[0] * 9, d[1] * 9, d[2] * 9) * 0.55 + mwNoise(d[0] * 23, d[1] * 23, d[2] * 23) * 0.3 + mwNoise(d[0] * 61, d[1] * 61, d[2] * 61) * 0.15;
        const la = d[0] * MW_POLE[0] + d[1] * MW_POLE[1] + d[2] * MW_POLE[2];
        const rift = 1 - 0.7 * Math.exp(-Math.pow((la - 0.02) / 0.035, 2)) * smooth01(0.35, 0.65, mwNoise(d[0] * 14 + 3.1, d[1] * 14 + 3.1, d[2] * 14 + 3.1));
        const m = b * (0.4 + 0.9 * n * n) * rift * 0.07;
        sr += 0.85 * m; sg += 0.82 * m; sb += 0.78 * m;
      }
      // 星（stars = false なら描かない：一枚絵では画面の細かさで後から描く。addStarsScreen）
      if (stars) {
        starAt(d, b, pixAng, st3);
        sr += st3[0]; sg += st3[1]; sb += st3[2];
      }
      // リアルタイムでは表示の値に足しているので、露出で割って空の明るさの単位に戻す
      const g = (k * fade) / Math.max(0.02, exposure);
      data[o] += sr * g;
      data[o + 1] += sg * g;
      data[o + 2] += sb * g;
    }
  }
}
// 向き d の星の明るさ（色ごと）を out へ。格子ごとにまれに 1 つ。画素（角度 pixAng）より小さい星は、画素に合わせて広げて明るさの総量を保つ
// b: 天の川の濃さ（天の川の中は暗い星が多い）
function starAt(d, b, pixAng, out, minSig = 0.13) {
  out[0] = out[1] = out[2] = 0;
  for (let l = 0; l < 2; l++) {
    const sc = l === 0 ? 180 : 520;
    const qx = d[0] * sc, qy = d[1] * sc, qz = d[2] * sc;
    const cx = Math.floor(qx), cy = Math.floor(qy), cz = Math.floor(qz);
    const h = sHash(cx, cy, cz);
    const th = l === 0 ? 0.988 : 0.975 - 0.02 * b;
    if (h <= th) continue;
    const px = cx + sHash(cx + 1.37, cy + 1.37, cz + 1.37), py = cy + sHash(cx + 2.11, cy + 2.11, cz + 2.11), pz = cz + sHash(cx + 3.73, cy + 3.73, cz + 3.73);
    const dd2 = (qx - px) ** 2 + (qy - py) ** 2 + (qz - pz) ** 2;
    const sig = Math.max(minSig, pixAng * sc * 0.6); // 星の広がり（格子の単位）
    const e = Math.exp(-dd2 / (2 * sig * sig)) * ((0.13 * 0.13) / (sig * sig));
    const bb = Math.pow((h - th) / (1 - th), 3) * (l === 0 ? 1 : 0.35) * e;
    const tint = sHash(cx + 7.7, cy + 7.7, cz + 7.7);
    out[0] += (1 + (0.7 - 1) * tint) * bb;
    out[1] += (0.78 + (0.82 - 0.78) * tint) * bb;
    out[2] += (0.6 + (1 - 0.6) * tint) * bb;
  }
}

// 一枚絵の星を、画面の画素ごとに描く（全天画像に描くと、画像の 1 画素が画面の数画素に広がって星がぼやけた雪の粒になる）。
// sky: 空が見えている割合（画素ごと、0..1）。明るさの尺度は addStarsAndMilkyWay と同じ
function addStarsScreen(hdr, W, H, camera, sky, k, exposure) {
  const fovY = THREE.MathUtils.degToRad(camera.fov);
  const pixAng = fovY / H;
  const v = new THREE.Vector3(), o = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
  const d = [0, 0, 0], st3 = [0, 0, 0];
  const g0 = k / Math.max(0.02, exposure);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!(sky[i] > 0.01)) continue;
      v.set(((x + 0.5) / W) * 2 - 1, 1 - ((y + 0.5) / H) * 2, 0.5).unproject(camera).sub(o).normalize();
      d[0] = v.x; d[1] = v.y; d[2] = v.z;
      const q = i * 4;
      const lum = (hdr[q] * 0.2126 + hdr[q + 1] * 0.7152 + hdr[q + 2] * 0.0722) * exposure;
      const fade = Math.exp(-lum * 6) * Math.min(1, Math.max(0, (d[1] + 0.02) / 0.08)) * sky[i];
      if (fade < 0.01) continue;
      starAt(d, milkyBand(d), pixAng, st3, 0); // 画面では望遠でも 1 画素ほどの点に
      const g = g0 * fade;
      hdr[q] += st3[0] * g;
      hdr[q + 1] += st3[1] * g;
      hdr[q + 2] += st3[2] * g;
    }
  }
}

// 空の月を画面の画素ごとに描く（直径 1.5°。全天画像に描くと数画素の円盤になり模様が見えない）。
// moon: { dir: 月の向き, sun: 太陽の向き, gain }, map: 月面図（無ければ一様な明るさ）
function addMoonScreen(hdr, W, H, camera, sky, moon, map) {
  const m = moon.dir, S = moon.sun;
  const rho = THREE.MathUtils.degToRad(0.75), sinR = Math.sin(rho);
  // 円盤の右（東）と上（北）：月を見る向きと、世界の上から
  const fwd = new THREE.Vector3(...m);
  const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
  const up = new THREE.Vector3().crossVectors(right, fwd).normalize();
  const pixAng = THREE.MathUtils.degToRad(camera.fov) / H;
  const v = new THREE.Vector3(), o = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
  // 月が写る画素の範囲だけ調べる
  const c = fwd.clone().multiplyScalar(1000).add(o).project(camera);
  if (c.z > 1) return;
  const cx = (c.x * 0.5 + 0.5) * W, cy = (0.5 - c.y * 0.5) * H, rp = rho / pixAng + 3;
  for (let y = Math.max(0, Math.floor(cy - rp)); y < Math.min(H, Math.ceil(cy + rp)); y++) {
    for (let x = Math.max(0, Math.floor(cx - rp)); x < Math.min(W, Math.ceil(cx + rp)); x++) {
      const i = y * W + x;
      if (!(sky[i] > 0.01)) continue;
      v.set(((x + 0.5) / W) * 2 - 1, 1 - ((y + 0.5) / H) * 2, 0.5).unproject(camera).sub(o).normalize();
      const cm = v.dot(fwd);
      // 縁は画素の大きさだけぼかす
      const edge = THREE.MathUtils.clamp((Math.acos(Math.min(1, cm)) - rho) / -pixAng + 0.5, 0, 1);
      if (edge <= 0) continue;
      const ox = v.dot(right) / sinR, oy = v.dot(up) / sinR;
      const r2 = Math.min(1, ox * ox + oy * oy), z = Math.sqrt(1 - r2);
      // 面の向き（世界）：円盤の中心から外へ ox・oy、こちら向きに z
      const nx = right.x * ox + up.x * oy - fwd.x * z, ny = right.y * ox + up.y * oy - fwd.y * z, nz = right.z * ox + up.z * oy - fwd.z * z;
      const lit = THREE.MathUtils.smoothstep(nx * S[0] + ny * S[1] + nz * S[2], -0.04, 0.12) + 0.01;
      const alb = map ? sampleMoon(map, Math.asin(Math.max(-1, Math.min(1, oy))), Math.atan2(ox, z)) * 0.9 : 1;
      const k = moon.gain * lit * alb * edge * sky[i] * (v.y > 0 ? 1 : 0.5);
      const q = i * 4;
      hdr[q] += k;
      hdr[q + 1] += k * 0.97;
      hdr[q + 2] += k * 0.9;
    }
  }
}

function smooth01(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// 画面の描き換えの機会を与える（requestAnimationFrame は画面が隠れていると止まるので時間で待つ）
const nextFrame = () => new Promise((r) => setTimeout(r, 50));
