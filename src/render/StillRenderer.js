import * as THREE from 'three/webgpu';
import { t } from '../i18n/index.js';
import { ShaderMaterial, WebGLRenderTarget } from 'three';
import { WebGPUPathTracer, OIDNDenoiser, TRANSMISSIVE_BACKGROUND_ENVIRONMENT } from 'three-gpu-pathtracer/webgpu';
import { initUNetFromURL } from 'oidn-web';
// OIDN の学習済み重み（HDR・アルベド・法線つき）。同梱してオフラインでも使えるようにする
import OIDN_WEIGHTS from 'oidn-weights/rt_hdr_alb_nrm.tza?url';
import { sunDirection } from '../core/sun.js';
import { skyParams, renderSkyEquirect } from '../core/skyModel.js';
import { toneMapToRGBA8 } from '../core/tonemap.js';
import { sunIrradiance, discScaleFor } from '../core/skyModel.js';
import { computeAtmosphere } from './atmospherePass.js';
import { atmosphereParams } from './atmosphereParams.js';
import { coniferGeometry, broadleafGeometry, grassGeometry, fillInstances } from '../three/vegetationMeshes.js';
import { planetRadius } from '../core/schema.js';
import { curvePoint } from '../core/curvature.js';

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
    mark('terrain');
    this.#check();

    // ---- 2. シーンを組む ----
    this.ui.onStatus(t('光の通り道を組み立てています…'));
    await this.view.objects.ready();
    const objectMeshes = this.view.objects.exportMeshes();
    const celestial = new Set(s.objects.filter((o) => o.celestial).map((o) => o.id));
    const built = this.#buildScene(s, terrain, objectMeshes);
    mark('scene');
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
        this.ui.onProgress(Math.min(counts.avg, st.samples), st.samples, { sec, left, denoising: counts.min >= st.samples });
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
    const traceSec = (performance.now() - t0) / 1000;
    Object.assign(this.stats, { traceSec, frames: frame, samplesPerSec: counts.samplesPerSecond });

    // ---- 4. HDR を読み出して仕上げる ----
    mark('trace');
    this.ui.onStatus(t('かすみと光を仕上げています…'));
    const hdr = await this.#readHDR(renderer, pt, W, H);
    this.#applyAtmosphere(hdr, s, built, objectMeshes, celestial, camera, W, H);
    mark('atmosphere');
    if (st.bloom > 0) applyBloom(hdr, W, H, st.bloom);
    const rgba = toneMapToRGBA8(hdr, W, H, { mode: st.tone, exposure: s.atmosphere.exposure * st.exposure });
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
      });
    });
  }

  #buildScene(s, terrain, objectMeshes) {
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
    const terrainMesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 }));
    terrainMesh.name = 'Terrain';
    scene.add(terrainMesh);
    this.disposers.push(() => (geo.dispose(), terrainMesh.material.dispose()));

    // 水：透過・屈折・吸収をもつ本物の水。さざ波は法線マップ
    let water = null;
    if (s.water.enabled) {
      const span = Math.max(t.size * 30, 2000000); // 水平線（高さ数 km から百数十 km 先）より遠くまで
      // 丸い星では、注視点を中心に近くは細かく遠くは粗い円盤を、球面に沿って曲げる
      const R = this.place.R;
      const wgeo = R > 0 ? curvedDisc(R, s.water.level) : new THREE.PlaneGeometry(span, span, 1, 1);
      if (!(R > 0)) wgeo.rotateX(-Math.PI / 2);
      // さざ波は「表面の粗さ」で表す。繰り返しの法線マップはパストレーサのテクスチャ合成で継ぎ目が線になるため使わない。
      // 粗さは「揺らぎ」「波の大きさ」から決める（太陽の照り返しが広がり、遠くの水面が空を柔らかく映す）
      const tint = new THREE.Color(s.water.color);
      const wmat = new THREE.MeshPhysicalMaterial({
        color: 0xffffff,
        roughness: Math.min(0.25, 0.015 + s.water.distortion * 0.008 * s.water.waveScale),
        metalness: 0,
        transmission: 1,
        ior: 1.333,
        thickness: 1,
        // 水の色は「吸収されにくい色」として持たせる（浅瀬が水の色に染まり、深い所ほど暗くなる）
        attenuationColor: tint.clone().lerp(new THREE.Color(1, 1, 1), 0.55),
        attenuationDistance: 10,
      });
      water = new THREE.Mesh(wgeo, wmat);
      if (!(R > 0)) water.position.y = s.water.level;
      scene.add(water);
      // 水の底：地形の外まで光が素通りしないよう、暗い海底でふさぐ
      const bedY = Math.min(t.baseHeight, s.water.level) - 3; // 地形の最低点のすぐ下（縁の段差を作らない）
      const bgeo = R > 0 ? curvedDisc(R, bedY) : new THREE.PlaneGeometry(span, span, 1, 1);
      if (!(R > 0)) bgeo.rotateX(-Math.PI / 2);
      const bed = new THREE.Mesh(bgeo, new THREE.MeshStandardMaterial({ color: 0x1a1612, roughness: 1 }));
      if (!(R > 0)) bed.position.y = bedY;
      scene.add(bed);
      this.disposers.push(() => (wgeo.dispose(), wmat.dispose(), bgeo.dispose(), bed.material.dispose()));
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
      const add = (geo, color, list, opts = {}) => {
        if (!list.length) return;
        const mat = new THREE.MeshStandardMaterial({ color, roughness: opts.roughness ?? 0.85, metalness: 0, side: opts.side ?? THREE.FrontSide });
        const mesh = new THREE.InstancedMesh(geo, mat, list.length / 5);
        fillInstances(mesh, list, opts.colorVar ?? 0, opts.seed ?? 1);
        scene.add(mesh);
        plants.push(mesh);
        this.disposers.push(() => (geo.dispose(), mat.dispose()));
      };
      const con = coniferGeometry(), brd = broadleafGeometry();
      const trunk = new THREE.Color('#3a2b20');
      add(con.trunk, trunk, P.conifer);
      add(con.crown, new THREE.Color('#1b3317'), P.conifer, { colorVar: 0.35, seed: 3 });
      add(brd.trunk, trunk, P.broadleaf);
      add(brd.crown, new THREE.Color('#2e4d1f'), P.broadleaf, { colorVar: 0.4, seed: 5 });
      const grassCol = new THREE.Color(s.terrain.palette.low).lerp(new THREE.Color('#b7b05a'), 0.15);
      add(grassGeometry(), grassCol, P.grass, { side: THREE.DoubleSide, roughness: 0.7, colorVar: 0.45, seed: 9 });
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
    const opts = { skyScale: s.atmosphere.ambient, sunScale: s.sun.intensity, clouds: false };
    const mkEnv = (data) => {
      const tex = new THREE.DataTexture(data, ew, eh, THREE.RGBAFormat, THREE.FloatType);
      tex.mapping = THREE.EquirectangularReflectionMapping;
      tex.colorSpace = THREE.NoColorSpace;
      tex.minFilter = tex.magFilter = THREE.LinearFilter;
      tex.needsUpdate = true;
      textures.push(tex);
      return tex;
    };
    scene.environment = mkEnv(renderSkyEquirect(p, ew, eh, { ...opts, discScale }));
    // 背景は見た目だけなので、半精度に収まるよう太陽の芯だけ頭打ちにする（眩しさは変わらない）
    const bg = renderSkyEquirect(p, ew, eh, opts);
    for (let i = 0; i < bg.length; i++) if (bg[i] > 65000) bg[i] = 65000;
    scene.background = discScale > 1 ? mkEnv(bg) : scene.environment;

    scene.updateMatrixWorld(true);
    return { scene, terrainMesh, water, plants, textures, skyP: p };
  }

  #camera(s, aspect) {
    const P = this.place;
    // パストレーサは「手前の面」と「奥の面」の点から光線を作るので、near と far の比が大きすぎると
    // 計算が壊れて（NaN）GPU が止まる。比は 10 万倍までにし、地面からの高さに合わせて決める
    const [px, py, pz] = s.camera.position;
    const above = Math.max(10, py - Math.max(s.water.enabled ? s.water.level : -Infinity, this.view.gpuTerrain.heightAt(px, pz)));
    const near = Math.min(2000, Math.max(0.3, above * 0.03));
    const far = Math.max(near * 1e5, 1e5);
    const cam = new THREE.PerspectiveCamera(s.camera.fov, aspect, near, far);
    const [x, y, z] = s.camera.position;
    const c = curvePoint(x - P.ox, y, z - P.oz, 0, 0, P.R);
    cam.position.set(c[0], c[1], c[2]);
    const tg = s.camera.target;
    cam.lookAt(new THREE.Vector3(tg[0] - P.ox, tg[1], tg[2] - P.oz));
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
    if (built.water) meshes.push({ object: built.water, noShadow: true });
    for (const m of built.plants) meshes.push({ object: m });
    for (const m of objectMeshes) meshes.push({ object: m, celestial: celestial.has(m.userData.kuniumiId) });
    const P = this.place;
    const view = { origin: [P.ox, P.oz], planetR: P.R, cam: [0, 0, 0] };
    // 光の筋の影の地図は注視点の周りだけ（数千 km の大地全体では細かさが足りない）
    const tg = new THREE.Vector3(0, s.camera.target[1], 0);
    const radius = Math.min(Math.max(3000, camera.position.distanceTo(tg) * 3), Math.max(3000, Math.min(s.terrain.size * 0.75, 200000)));
    const shadowBounds = s.terrain.size > 60000 ? { center: tg, radius } : null;
    const res = computeAtmosphere(this.view.renderer, meshes, camera, W, H, { ...atmosphereParams(s), skyE, view, shadowBounds });
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
  const r = Math.max(2, Math.round(w * 0.012));
  for (let pass = 0; pass < 3; pass++) {
    boxBlur(small, tmp, w, h, r, true);
    boxBlur(tmp, small, w, h, r, false);
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4, so = ((y / f | 0) * w + (x / f | 0)) * 3;
      for (let c = 0; c < 3; c++) hdr[o + c] = hdr[o + c] * (1 - amount) + small[so + c] * amount;
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
function curvedDisc(R, level) {
  const SEG = 256;
  const maxR = Math.PI * R * 0.98;
  const radii = [0];
  for (let r = 2; r < maxR; r *= 1.06) radii.push(r);
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

// 画面の描き換えの機会を与える（requestAnimationFrame は画面が隠れていると止まるので時間で待つ）
const nextFrame = () => new Promise((r) => setTimeout(r, 50));
