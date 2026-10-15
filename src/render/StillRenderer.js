import * as THREE from 'three/webgpu';
import { ShaderMaterial, WebGLRenderTarget } from 'three';
import { WebGPUPathTracer, OIDNDenoiser, TRANSMISSIVE_BACKGROUND_ENVIRONMENT } from 'three-gpu-pathtracer/webgpu';
import { initUNetFromURL } from 'oidn-web';
import { TerrainService } from '../three/TerrainService.js';
import { createTerrainGeometry, applyHeights, createColorTexture, createTerrainMaterial } from '../three/terrainMesh.js';
import { sunDirection } from '../core/sun.js';
import { skyParams, renderSkyEquirect } from '../core/skyModel.js';
import { toneMapToRGBA8 } from '../core/tonemap.js';

// 高画質の一枚絵モード。リアルタイム表示と同じシーン JSON を、別の描画器（パストレーサ）で解釈する。
//
//   1. 地形を静止画用に細かく作り直す（頂点 1025〜2049/辺、地表テクスチャ 4096px）
//   2. 空の物理モデルから全天の HDR 画像を作り、空そのものを光源にする（太陽の柔らかい影・映り込み）
//   3. WebGPU のパストレーサで光の反射・屈折・間接光を計算し、AI ノイズ除去（OIDN）で仕上げる
//   4. 深度から遠景のかすみ（空気遠近）を足し、光のにじみ・トーンマップ（AgX）を掛けて書き出す

// OIDN の学習済み重み（HDR・アルベド・法線つき）。oidn-web の作者が npm に置いているもの
const OIDN_WEIGHTS = 'https://cdn.jsdelivr.net/npm/oidn-weights@2.3.0-1/rt_hdr_alb_nrm.tza';
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
    if (!navigator.gpu) throw new Error('このブラウザは WebGPU に対応していません（Chrome / Edge の最新版で開いてください）');

    // ---- 1. 地形を作り直す ----
    this.ui.onStatus('大地を細かく作り直しています…');
    // ノイズ地形は「近いほど細かい」区画で作り直す。ハイトマップは格子を細かくする
    const terrain = s.terrain.mode === 'noise' ? await this.#lodTerrain(s, W / H, H) : await this.#hiResTerrain(s);
    this.#check();

    // ---- 2. シーンを組む ----
    this.ui.onStatus('光の通り道を組み立てています…');
    await this.view.objects.ready();
    const objectMeshes = this.view.objects.exportMeshes();
    const celestial = new Set(s.objects.filter((o) => o.celestial).map((o) => o.id));
    const built = this.#buildScene(s, terrain, objectMeshes);
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
    // GPU 側のエラー（メモリ不足など）は捕まえて止める（放っておくと黙って描けないまま回り続ける）
    renderer.backend.device?.addEventListener('uncapturederror', (e) => {
      this.gpuError ??= e.error?.message ?? String(e.error);
    });
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
    if (this.tuning.frameBudget) pt.frameBudget = this.tuning.frameBudget;
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
    if (this.useMegakernel) pt.useMegakernel(true);
    this.#check();

    const t0 = performance.now();
    let counts = { min: 0, avg: 0 };
    let frame = 0;
    // 画面の更新（requestAnimationFrame）に合わせると GPU が空回りするので、
    // GPU の処理完了を待ちながら連続で積む（同時に積むのは 2 回分まで）
    const device = renderer.backend?.device;
    for (;;) {
      this.#check();
      if (this.gpuError) throw new Error(`GPU でエラーが出ました（地形の細かさや解像度を下げてください）: ${this.gpuError.split(/\r?\n/)[0]}`);
      pt.renderSample();
      frame++;
      if (device && frame % 2 === 0) await device.queue.onSubmittedWorkDone();
      if (frame % 16 === 0) {
        counts = await pt.getSampleCountsAsync();
        const sec = (performance.now() - t0) / 1000;
        const left = counts.avg > 0 ? (sec / counts.avg) * Math.max(0, st.samples - counts.avg) : 0;
        this.ui.onProgress(Math.min(counts.avg, st.samples), st.samples, { sec, left, denoising: counts.min >= st.samples });
        if (counts.min >= st.samples && (!denoiser || denoiser.complete)) break;
      }
      if (!device || frame % 4 === 0) await new Promise((r) => setTimeout(r, 0)); // 画面の操作に応える隙間
    }
    const traceSec = (performance.now() - t0) / 1000;
    Object.assign(this.stats, { traceSec, frames: frame, samplesPerSec: counts.samplesPerSecond });

    // ---- 4. HDR を読み出して仕上げる ----
    this.ui.onStatus('かすみと光を仕上げています…');
    const hdr = await this.#readHDR(renderer, pt, W, H);
    const depth = this.#depthPass(s, built, objectMeshes, celestial, camera, W, H);
    applyAerialPerspective(hdr, depth, s, camera, W, H);
    if (st.bloom > 0) applyBloom(hdr, W, H, st.bloom);
    const rgba = toneMapToRGBA8(hdr, W, H, { mode: st.tone, exposure: s.atmosphere.exposure * st.exposure });
    for (const t of built.textures) t.dispose();
    return { hdr, rgba, width: W, height: H, samples: st.samples, traceSec, denoised: !!denoiser };
  }

  // 静止画用の地形（頂点を増やし、地表テクスチャを 4096px に）
  #hiResTerrain(s) {
    const res = Math.max(s.terrain.resolution, s.render.still.terrainDetail);
    return new Promise((resolve, reject) => {
      const svc = new TerrainService(
        (r) => {
          svc.dispose();
          resolve(r);
        },
        (err) => {
          svc.dispose();
          reject(new Error(`地形の生成に失敗: ${err}`));
        },
        { textureSize: 4096 },
      );
      svc.request({ ...s, terrain: { ...s.terrain, resolution: res } });
      this.disposers.push(() => svc.dispose());
    });
  }

  // カメラから近いほど細かい地形（ワーカーで計算）
  #lodTerrain(s, aspect, height) {
    const maxTriangles = s.render.still.terrainDetail >= 2049 ? 7_000_000 : 4_000_000;
    return new Promise((resolve, reject) => {
      const w = new Worker(new URL('../workers/lodWorker.js', import.meta.url), { type: 'module' });
      this.disposers.push(() => w.terminate());
      w.onmessage = (e) => {
        if (e.data.progress !== undefined) {
          this.ui.onStatus(`大地を細かく作り直しています… ${Math.round(e.data.progress * 100)}%`);
          return;
        }
        w.terminate();
        if (e.data.error) reject(new Error(`地形の生成に失敗: ${e.data.error}`));
        else resolve({ lod: e.data.result });
      };
      w.postMessage({
        terrain: s.terrain,
        water: s.water,
        view: { position: s.camera.position, target: s.camera.target, fov: s.camera.fov, aspect, height },
        maxTriangles,
      });
    });
  }

  #buildScene(s, terrain, objectMeshes) {
    const scene = new THREE.Scene();
    const textures = [];
    const t = s.terrain;

    // 地形
    let geo, terrainMesh;
    if (terrain.lod) {
      const r = terrain.lod;
      geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(r.positions, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(r.normals, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(r.colors, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(r.uvs, 2));
      geo.setIndex(new THREE.BufferAttribute(r.index, 1));
      geo.computeBoundingBox();
      geo.computeBoundingSphere();
      this.stats.terrainTriangles = r.triangles;
      terrainMesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 }));
    } else {
      geo = createTerrainGeometry(terrain.res);
      applyHeights(geo, terrain.field, terrain.res, t);
      const map = createColorTexture(terrain.colors, terrain.texSize);
      textures.push(map);
      terrainMesh = new THREE.Mesh(geo, createTerrainMaterial(map, t.size));
    }
    terrainMesh.name = 'Terrain';
    scene.add(terrainMesh);
    this.disposers.push(() => (geo.dispose(), terrainMesh.material.dispose()));

    // 水：透過・屈折・吸収をもつ本物の水。さざ波は法線マップ
    let water = null;
    if (s.water.enabled) {
      const span = Math.max(t.size * 30, 2000000); // 水平線（高さ数 km から百数十 km 先）より遠くまで
      const wgeo = new THREE.PlaneGeometry(span, span, 1, 1);
      wgeo.rotateX(-Math.PI / 2);
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
      water.position.y = s.water.level;
      scene.add(water);
      // 水の底：地形の外まで光が素通りしないよう、暗い海底でふさぐ
      const bgeo = new THREE.PlaneGeometry(span, span, 1, 1);
      bgeo.rotateX(-Math.PI / 2);
      const bed = new THREE.Mesh(bgeo, new THREE.MeshStandardMaterial({ color: 0x1a1612, roughness: 1 }));
      bed.position.y = Math.min(t.baseHeight, s.water.level) - 30;
      scene.add(bed);
      this.disposers.push(() => (wgeo.dispose(), wmat.dispose(), bgeo.dispose(), bed.material.dispose()));
    }

    // 物体（リアルタイム表示と同じ形と素材）
    for (const m of objectMeshes) scene.add(m);

    // 空：全天の HDR 画像を光源と背景にする（太陽円盤を含む）
    const dir = sunDirection(s.sun.elevation, s.sun.azimuth);
    const p = skyParams(s.atmosphere, dir);
    const [ew, eh] = ENV_SIZE;
    const envData = renderSkyEquirect(p, ew, eh, { skyScale: s.atmosphere.ambient, sunScale: s.sun.intensity });
    const env = new THREE.DataTexture(envData, ew, eh, THREE.RGBAFormat, THREE.FloatType);
    env.mapping = THREE.EquirectangularReflectionMapping;
    env.colorSpace = THREE.NoColorSpace;
    env.minFilter = env.magFilter = THREE.LinearFilter;
    env.needsUpdate = true;
    textures.push(env);
    scene.environment = env;
    scene.background = env;

    scene.updateMatrixWorld(true);
    return { scene, terrainMesh, water, textures, skyP: p };
  }

  #camera(s, aspect) {
    const cam = new THREE.PerspectiveCamera(s.camera.fov, aspect, 1, s.terrain.size * 200);
    cam.position.fromArray(s.camera.position);
    cam.lookAt(new THREE.Vector3().fromArray(s.camera.target));
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

  // 各画素の「カメラから最初に当たる面までの距離」。かすみの計算に使う（WebGL で描く）。
  // 空 = 0、かすみを受けない天体 = -1。行0 = 画像の上にそろえて返す
  #depthPass(s, built, objectMeshes, celestial, camera, W, H) {
    const gl = this.view.renderer;
    const scene = new THREE.Scene();
    const mk = (flag) =>
      new ShaderMaterial({
        side: THREE.DoubleSide,
        vertexShader: /* glsl */ `
          varying vec3 vW;
          void main() {
            vec4 w = modelMatrix * vec4(position, 1.0);
            vW = w.xyz;
            gl_Position = projectionMatrix * viewMatrix * w;
          }`,
        fragmentShader: /* glsl */ `
          varying vec3 vW;
          void main() { gl_FragColor = vec4(${flag ? '-1.0' : 'distance(vW, cameraPosition)'}, 0.0, 0.0, 1.0); }`,
      });
    const solid = mk(false), sky = mk(true);
    const add = (src, mat) => {
      const m = new THREE.Mesh(src.geometry, mat);
      m.matrixAutoUpdate = false;
      m.matrix.copy(src.matrixWorld);
      m.matrixWorld.copy(src.matrixWorld);
      scene.add(m);
    };
    add(built.terrainMesh, solid);
    if (built.water) add(built.water, solid);
    for (const m of objectMeshes) add(m, celestial.has(m.userData.kuniumiId) ? sky : solid);

    const rt = new WebGLRenderTarget(W, H, { type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    const prev = gl.getRenderTarget();
    const prevColor = gl.getClearColor(new THREE.Color());
    const prevAlpha = gl.getClearAlpha();
    gl.setRenderTarget(rt);
    gl.setClearColor(0x000000, 0);
    gl.clear();
    gl.render(scene, camera);
    const px = new Float32Array(W * H * 4);
    gl.readRenderTargetPixels(rt, 0, 0, W, H, px);
    gl.setRenderTarget(prev);
    gl.setClearColor(prevColor, prevAlpha);
    rt.dispose();
    solid.dispose();
    sky.dispose();
    // WebGL の読み出しは下の行から。上から並べ直し、距離だけ取り出す
    const depth = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      const src = (H - 1 - y) * W;
      for (let x = 0; x < W; x++) depth[y * W + x] = px[(src + x) * 4 + 3] > 0.5 ? px[(src + x) * 4] : 0;
    }
    return depth;
  }
}

// 空気遠近：遠いものほど、その方向の地平線近くの空の色に溶ける（リアルタイムの霧と同じ濃さの式）
function applyAerialPerspective(hdr, depth, s, camera, W, H) {
  const density = s.atmosphere.haze * 2.2e-4;
  if (density <= 0) return;
  // かすみの色は「その画素の向き（ただし地平線より少し上）」の空の明るさ。太陽円盤と雲は含めない
  const p = skyParams(s.atmosphere, sunDirection(s.sun.elevation, s.sun.azimuth));
  const LW = 256, LH = 128;
  const lut = renderSkyEquirect(p, LW, LH, { sunDisc: false, clouds: false, skyScale: s.atmosphere.ambient });
  const e = camera.matrixWorld.elements;
  const right = [e[0], e[1], e[2]], up = [e[4], e[5], e[6]], fwd = [-e[8], -e[9], -e[10]];
  const tanH = Math.tan((camera.fov * Math.PI) / 360);
  const aspect = W / H;
  for (let y = 0; y < H; y++) {
    const ny = (1 - ((y + 0.5) / H) * 2) * tanH;
    for (let x = 0; x < W; x++) {
      const d = depth[y * W + x];
      if (d <= 0) continue; // 空・天体はそのまま
      const k = density * d;
      const T = Math.exp(-k * k);
      if (T > 0.999) continue;
      const nx = (((x + 0.5) / W) * 2 - 1) * tanH * aspect;
      let dx = fwd[0] + right[0] * nx + up[0] * ny;
      let dy = fwd[1] + right[1] * nx + up[1] * ny;
      let dz = fwd[2] + right[2] * nx + up[2] * ny;
      const len = Math.hypot(dx, dy, dz);
      dx /= len;
      dz /= len;
      dy = Math.max(dy / len, 0.03);
      const hl = Math.hypot(dx, dz) || 1;
      // 正距円筒 LUT を引く（行0 = 真下）
      const lat = Math.asin(Math.min(1, dy));
      const phi = Math.atan2(dz / hl, dx / hl);
      const ly = Math.min(LH - 1, Math.max(0, Math.floor((lat / Math.PI + 0.5) * LH)));
      const lx = Math.min(LW - 1, Math.max(0, Math.floor((phi / (2 * Math.PI) + 0.5) * LW)));
      const li = (ly * LW + lx) * 4;
      const o = (y * W + x) * 4;
      hdr[o] = hdr[o] * T + lut[li] * (1 - T);
      hdr[o + 1] = hdr[o + 1] * T + lut[li + 1] * (1 - T);
      hdr[o + 2] = hdr[o + 2] * T + lut[li + 2] * (1 - T);
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

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
