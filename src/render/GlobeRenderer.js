import * as THREE from 'three';
import {
  GLOBE_R, GLOBE_MAX_ZOOM, GRID, MERC_MAX_LAT, ecef, toLatLon, enu, tileLatLon, tileInfo, tileBounds,
  behindHorizon, orbitCamera, subsolarPoint, gridAt, locateTile, IMAGERY_MAX_ZOOM, LIGHTS_MAX_ZOOM, imageryUrl, lightsUrl, ancestorXf, prefersRecentPhoto,
} from '../core/globe.js';
import { sunDirection } from '../core/sun.js';
import { GLOBE_ATMO_GLSL, GLOBE_SURFACE_GLSL, GLOBE_CLOUD_GLSL } from './globeGLSL.js';

// 地球モード：地球全体を丸ごと描く。
//   ・地表は標高タイル（Web メルカトル z/x/y）の四分木。近い所ほど細かいズームのタイルに分ける
//   ・タイルは見えている所の分だけ、その都度取り寄せる（globeTileWorker.js）。届くまでは親のタイルで代える
//   ・座標は地球中心（ECEF）だが、描くときはカメラを原点にする（タイルの中心 − カメラ を倍精度で求めてから渡す）
//   ・大気は一回散乱（レイリー + ミー）。空も地表のかすみも同じ式
const SPLIT = 2.6; // 区画までの距離が一辺の何倍より近ければ細かく分けるか
const MIN_ZOOM = 2; // いつも少なくともこのズームまでは分ける
const MAX_TILES = 360; // GPU に置いておくタイルの上限
const MAX_LOADING = 24;
const D2R = Math.PI / 180;
const ATMO_TOP = 100000;

export class GlobeRenderer {
  constructor(container, { onInfo } = {}) {
    this.container = container;
    this.onInfo = onInfo ?? (() => {});
    const canvas = document.createElement('canvas');
    canvas.className = 'globe-canvas';
    container.prepend(canvas);
    this.canvas = canvas;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
    // 画質（解像度の倍率）。重い端末では自動で下げ、軽ければ上げる（#adaptQuality）
    this.maxRatio = Math.min(window.devicePixelRatio, 2);
    this.quality = { ratio: this.maxRatio, frames: 0, sum: 0 };
    renderer.setPixelRatio(this.maxRatio);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.22;
    this.renderer = renderer;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 1, 1e9);
    this.scene.add(this.camera);

    // 視点：見ている地表の点・そこまでの距離・向き・傾き
    this.view = { lat: 30, lon: 135, range: 2.2e7, heading: 0, tilt: 0 };
    this.targetH = 0;
    this.exag = 1; // 高さの誇張
    // 地表の写真：取り込み画面で新しい版を選んでいれば 2023 年版（作ったときに決める。途中で混ざらないように）
    this.recentPhoto = prefersRecentPhoto();
    this.imgUrl = (a, x, y) => imageryUrl(a, x, y, this.recentPhoto);
    this.sunMode = 'follow'; // 'follow' = 見ている所の時刻はシーンの太陽、'real' = 実際の日時、'lapse' = いまから早送り（1 日を 40 秒で）
    this.sceneSun = { elevation: 40, azimuth: 150 };
    this.camEcef = [0, 0, GLOBE_R * 3];
    this.flight = null;

    this.shared = {
      camC: { value: new THREE.Vector3() },
      sunDir: { value: new THREE.Vector3(1, 0, 0) },
      planetR: { value: GLOBE_R },
      atmoR: { value: GLOBE_R + ATMO_TOP },
      sunI: { value: 22 },
      exag: { value: 1 },
      imgOn: { value: 1 }, // 衛星写真の色を使うか
      lightsI: { value: 2.5 }, // 夜の街の明かりの強さ
      cloudOn: { value: 1 }, // 雲を描くか
      cloudH: { value: 6000 }, // 雲の層の高さ (m)
      cloudCover: { value: 0.5 }, // 雲の量（0..1）
      cloudTime: { value: 0 }, // 雲がゆっくり流れる
      cloudReal: { value: 0 }, // 今日の実際の雲（衛星画像）を使うか
      cloudToday: { value: null },
      cloudBase: { value: null },
    };

    this.tiles = new Map(); // "z/x/y" → タイル
    this.images = new Map(); // "層:z/x/y" → 衛星写真・街の明かり { tex, used }
    this.lightsOn = true;
    this.imgLoading = 0;
    this.frameNo = 0;
    this.loading = 0;
    this.#setupWorker();
    this.#setupShaders();
    this.#setupSky();
    this.#setupAurora();
    this.#setupControls();
    this.#resize();
    new ResizeObserver(() => this.#resize()).observe(container);
    // 最初に地球全体の粗いタイル（ズーム 0〜2）を取り寄せておく
    for (let z = 0; z <= MIN_ZOOM; z++) {
      const n = 2 ** z;
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) this.#request(this.#tile(z, x, y));
    }
  }

  start() {
    this.running = true;
    this.renderer.setAnimationLoop(() => this.#frame());
  }

  stop() {
    this.running = false;
    this.renderer.setAnimationLoop(null);
  }

  // ---- 取り寄せ ----
  #setupWorker() {
    this.worker = new Worker(new URL('../workers/globeTileWorker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => {
      const m = e.data;
      const t = this.tiles.get(m.key);
      if (t?.state === 'loading') this.loading--;
      if (!t) return;
      if (m.cancelled) return (t.state = 'none');
      if (m.error) {
        t.state = 'failed';
        t.retry = performance.now() + 15000;
        return;
      }
      t.grid = m.grid;
      t.min = m.min;
      t.max = m.max;
      const tex = new THREE.DataTexture(m.tex, 256, 256, THREE.RGBAFormat, THREE.HalfFloatType);
      tex.magFilter = THREE.LinearFilter;
      // 半精度の縮小版（ミップマップ）は GPU によって作れないことがあるので使わない（タイルは見かけの大きさに合わせて選ぶので粗くならない）
      tex.minFilter = THREE.LinearFilter;
      tex.generateMipmaps = false;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.needsUpdate = true;
      t.tex = tex;
      t.state = 'ready';
      t.bounds = null; // 標高の幅が分かったので包む球を作り直す
      if (t.z === MIN_ZOOM) this.capsDirty = true;
    };
  }

  #tile(z, x, y) {
    const key = `${z}/${x}/${y}`;
    let t = this.tiles.get(key);
    if (!t) {
      t = { key, z, x, y, state: 'none', used: 0, info: tileInfo(z, x, y) };
      this.tiles.set(key, t);
    }
    return t;
  }

  #request(t) {
    if (t.state === 'failed' && performance.now() > t.retry) t.state = 'none';
    if (t.state !== 'none' || this.loading >= MAX_LOADING) return;
    t.state = 'loading';
    this.loading++;
    this.worker.postMessage({ key: t.key, z: t.z, x: t.x, y: t.y });
  }

  #boundsOf(t) {
    if (!t.bounds) {
      // 標高の幅：自分のが無ければ親の（無ければ地球全体の）
      let lo = -11000, hi = 9000;
      for (let p = t, z = t.z, x = t.x, y = t.y; p; ) {
        if (p.state === 'ready') {
          lo = Math.max(0, p.min) * this.exag;
          hi = Math.max(0, p.max) * this.exag;
          break;
        }
        if (z === 0) break;
        z--, x >>= 1, y >>= 1;
        p = this.tiles.get(`${z}/${x}/${y}`);
      }
      t.bounds = tileBounds(t.z, t.x, t.y, lo - 50, hi + 50);
      t.boundsExag = this.exag;
    }
    return t.bounds;
  }

  // ---- 描き方 ----
  #setupShaders() {
    const vert = /* glsl */ `
      varying vec2 vUv;
      varying vec3 vRel;
      #ifdef CAP
      attribute float aH;
      varying float vH;
      #endif
      #include <common>
      #include <logdepthbuf_pars_vertex>
      void main() {
        vUv = uv;
        #ifdef CAP
        vH = aH;
        #endif
        vec4 wp = modelMatrix * vec4( position, 1.0 );
        vRel = wp.xyz; // カメラが原点
        gl_Position = projectionMatrix * viewMatrix * wp;
        #include <logdepthbuf_vertex>
      }`;
    const frag = /* glsl */ `
      uniform sampler2D tex, img, lit;
      uniform vec3 imgXf, litXf; // 祖先の写真の中の位置（ox, oy, 倍率）
      uniform float exag, imgOn, imgHas, litHas, lightsI;
      varying vec2 vUv;
      varying vec3 vRel;
      #ifdef CAP
      varying float vH;
      #endif
      #include <common>
      #include <logdepthbuf_pars_fragment>
      ${GLOBE_ATMO_GLSL}
      ${GLOBE_SURFACE_GLSL}
      ${GLOBE_CLOUD_GLSL}
      void main() {
        #include <logdepthbuf_fragment>
        float dist = length( vRel );
        vec3 vd = vRel / dist;
        vec3 wp = camC + vRel;
        #ifdef CAP
        vec3 col = gShade( wp, vd, vH, vec2( 0.0 ), 1.0, vec4( 0.0 ) );
        #else
        vec4 d = texture2D( tex, vUv );
        vec4 im = vec4( 0.0 );
        if ( imgOn > 0.5 && imgHas > 0.5 ) im = vec4( texture2D( img, imgXf.xy + vUv * imgXf.z ).rgb, 1.0 );
        vec3 col = gShade( wp, vd, d.b, d.rg * exag, 0.0, im );
        // 夜の街の明かり（昼の側では消す。暗い陸の写りは除いて、明かりだけを光らせる）
        if ( litHas > 0.5 ) {
          vec3 L = texture2D( lit, litXf.xy + vUv * litXf.z ).rgb;
          float night = smoothstep( 0.06, -0.14, dot( normalize( wp ), sunDir ) );
          col += max( L - 0.06, vec3( 0.0 ) ) * vec3( 1.0, 0.82, 0.55 ) * lightsI * night;
        }
        #endif
        // 雲の影（夜の街の明かりには落とさないよう、明かりは足した後でもよい程度の弱さ）
        col *= gCloudShadow( wp );
        vec3 ins, tr;
        gAtmosphere( camC, vd, dist, 8, ins, tr );
        vec3 outc = col * tr + ins;
        // 手前にある雲（雲までの空気の分だけかすませる）
        float tc;
        vec4 cl = gClouds( camC, vd, dist, tc );
        if ( cl.a > 0.0 ) {
          vec3 ci, ct;
          gAtmosphere( camC, vd, tc, 6, ci, ct );
          outc = mix( outc, cl.rgb * ct + ci, cl.a );
        }
        gl_FragColor = vec4( outc, 1.0 );
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`;
    this.vert = vert;
    this.frag = frag;
    this.capMaterial = new THREE.ShaderMaterial({ uniforms: { ...this.shared, tex: { value: null } }, vertexShader: vert, fragmentShader: frag, defines: { CAP: 1 } });

    // 格子の並び（全タイル共通）：33 × 33 の頂点 + 縁の「すそ」（隙間を隠す）
    const n = GRID + 1;
    const uv = [];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) uv.push(i / GRID, j / GRID);
    const edges = [];
    for (let i = 0; i < n; i++) edges.push([i, 0], [i, GRID]);
    for (let j = 1; j < GRID; j++) edges.push([0, j], [GRID, j]);
    this.skirt = edges;
    for (const [i, j] of edges) uv.push(i / GRID, j / GRID);
    const idx = [];
    for (let j = 0; j < GRID; j++) {
      for (let i = 0; i < GRID; i++) {
        const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    // すその帯：縁の頂点 → その真下のすそ頂点
    const skirtOf = new Map(edges.map(([i, j], k) => [j * n + i, n * n + k]));
    const ring = (list) => {
      for (let k = 0; k < list.length - 1; k++) {
        const a = list[k], b = list[k + 1];
        const sa = skirtOf.get(a), sb = skirtOf.get(b);
        idx.push(a, sa, b, b, sa, sb, a, b, sa, b, sb, sa); // 両面
      }
    };
    ring([...Array(n).keys()].map((i) => i)); // 北の縁
    ring([...Array(n).keys()].map((i) => GRID * n + i)); // 南の縁
    ring([...Array(n).keys()].map((j) => j * n)); // 西の縁
    ring([...Array(n).keys()].map((j) => j * n + GRID)); // 東の縁
    this.uvArr = new Float32Array(uv);
    this.indexArr = new Uint16Array(idx);
  }

  #buildMesh(t) {
    const n = GRID + 1;
    const info = t.info;
    const c = ecef(tileLatLon(t.z, t.x, t.y, 0.5, 0.5).lat, info.midLon, GLOBE_R);
    t.center = c;
    const pos = new Float32Array((n * n + this.skirt.length) * 3);
    const p = [0, 0, 0];
    const lat = new Float64Array(n);
    for (let j = 0; j < n; j++) lat[j] = tileLatLon(t.z, t.x, t.y, 0, j / GRID).lat;
    const put = (k, la, lo, h) => {
      ecef(la, lo, GLOBE_R + h, p);
      pos[k * 3] = p[0] - c[0];
      pos[k * 3 + 1] = p[1] - c[1];
      pos[k * 3 + 2] = p[2] - c[2];
    };
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const lo = info.west + ((info.east - info.west) * i) / GRID;
        put(j * n + i, lat[j], lo, Math.max(0, t.grid[j * n + i]) * this.exag);
      }
    }
    // すそは一辺の 1.5%（＋ 30 m）だけ下げる
    const drop = info.width * 0.015 + 30;
    this.skirt.forEach(([i, j], k) => {
      const lo = info.west + ((info.east - info.west) * i) / GRID;
      put(n * n + k, lat[j], lo, Math.max(0, t.grid[j * n + i]) * this.exag - drop);
    });
    if (t.mesh) {
      t.mesh.geometry.attributes.position.array.set(pos);
      t.mesh.geometry.attributes.position.needsUpdate = true;
      t.mesh.geometry.computeBoundingSphere();
    } else {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      // 並びの配列は共有してよいが、属性（GPU のバッファ）はタイルごとに作る。
      // 共有すると、片付けたタイルの dispose() が共有のバッファまで消し、ほかのタイルが描かれなくなる
      g.setAttribute('uv', new THREE.BufferAttribute(this.uvArr, 2));
      g.setIndex(new THREE.BufferAttribute(this.indexArr, 1));
      const m = new THREE.ShaderMaterial({ uniforms: { ...this.shared, tex: { value: t.tex }, img: { value: null }, imgXf: { value: new THREE.Vector3(0, 0, 1) }, imgHas: { value: 0 }, lit: { value: null }, litXf: { value: new THREE.Vector3(0, 0, 1) }, litHas: { value: 0 } }, vertexShader: this.vert, fragmentShader: this.frag });
      t.mesh = new THREE.Mesh(g, m);
      t.mesh.frustumCulled = false; // 自分で間引く
      t.mesh.matrixAutoUpdate = true;
    }
    t.meshExag = this.exag;
  }

  // ---- 衛星写真（地表の色） ----
  // タイルのズームが写真の上限より細かいときは、祖先の写真の一部を引き伸ばして使う。
  // まだ届いていなければ、届いているいちばん細かい祖先の写真で代える
  #bindImagery(t) {
    const u = t.mesh.material.uniforms;
    if (this.shared.imgOn.value) this.#bindLayer(t, 'c', IMAGERY_MAX_ZOOM, this.imgUrl, u.img, u.imgXf, u.imgHas);
    // 街の明かりは夜の側のタイルだけ取り寄せる
    const c = t.center, r = Math.hypot(...c), s = this.shared.sunDir.value;
    const night = (c[0] * s.x + c[1] * s.y + c[2] * s.z) / r < 0.25;
    if (night && this.lightsOn) this.#bindLayer(t, 'n', LIGHTS_MAX_ZOOM, lightsUrl, u.lit, u.litXf, u.litHas);
    else u.litHas.value = 0;
  }

  // 写真の層を 1 つ割り当てる（その層の上限より細かいタイルは、祖先の写真の一部を引き伸ばす）
  #bindLayer(t, src, maxZ, urlOf, tex, xfU, has) {
    const want = Math.min(t.z, maxZ);
    for (let a = want; a >= 0; a--) {
      const xf = ancestorXf(t.z, t.x, t.y, a);
      const key = `${src}:${a}/${xf.x}/${xf.y}`;
      const im = this.images.get(key);
      if (a === want && !im) this.#requestImage(urlOf(a, xf.x, xf.y), key);
      if (im?.tex) {
        im.used = this.frameNo;
        tex.value = im.tex;
        xfU.value.set(xf.ox, xf.oy, xf.scale);
        has.value = 1;
        return;
      }
    }
    has.value = 0;
  }

  #requestImage(url, key) {
    if (this.imgLoading >= 10) return;
    const im = { used: this.frameNo, tex: null };
    this.images.set(key, im);
    this.imgLoading++;
    fetch(url)
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(r.status))))
      .then((b) => createImageBitmap(b, { imageOrientation: 'none' }))
      .then((bmp) => {
        const tex = new THREE.Texture(bmp);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.flipY = false; // 行 0 = 北（uv の v = 0）
        tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.anisotropy = 4;
        tex.needsUpdate = true;
        im.tex = tex;
      })
      .catch(() => setTimeout(() => this.images.delete(key), 20000)) // しばらくしてからまた試す
      .finally(() => this.imgLoading--);
  }

  // 使われなくなった写真を片付ける（そのコマのタイルに全部割り当て終えてから。割り当て中に消すと、消した写真を描こうとしてしまう）
  #evictImages() {
    if (this.images.size <= 500) return;
    const list = [...this.images.entries()].filter(([k, v]) => v.tex && !k.includes(':0/') && v.used < this.frameNo - 30);
    list.sort((a, b) => a[1].used - b[1].used);
    for (const [k, v] of list.slice(0, this.images.size - 400)) {
      v.tex.dispose();
      this.images.delete(k);
    }
  }

  // 北を上に（傾きも戻す）
  northUp() {
    this.flyTo({ lat: this.view.lat, lon: this.view.lon, range: this.view.range, heading: 0, tilt: 0 });
  }

  // 寄る（k < 1）・離れる（k > 1）
  zoomBy(k) {
    this.flight = null;
    this.view.range = THREE.MathUtils.clamp(this.view.range * k, 60, 6e7);
    this.view.tilt = Math.min(this.view.tilt, this.#maxTilt());
  }

  // 雲：'none' | 'procedural'（手続きの雲）| 'today'（昨日〜今日の衛星画像の雲。取り寄せられなければ手続きの雲）
  async setClouds(mode) {
    if (mode === true) mode = 'procedural';
    if (mode === false) mode = 'none';
    this.shared.cloudOn.value = mode === 'none' ? 0 : 1;
    this.shared.cloudReal.value = 0;
    if (mode !== 'today') return true;
    try {
      await this.#loadRealClouds();
      this.shared.cloudReal.value = 1;
      return true;
    } catch (err) {
      console.warn('今日の雲を取り寄せられませんでした', err);
      return false;
    }
  }

  // NASA GIBS の WMS で、地球全体の正距円筒の画像を 2 枚：きのう（UTC）の VIIRS の写真と、雲の無い Blue Marble
  async #loadRealClouds() {
    if (this.shared.cloudToday.value) return;
    const wms = (layer, time) =>
      `https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=${layer}&CRS=EPSG:4326&BBOX=-90,-180,90,180&WIDTH=4096&HEIGHT=2048&FORMAT=image/jpeg${time ? `&TIME=${time}` : ''}`;
    const load = async (url) => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const bmp = await createImageBitmap(await r.blob(), { imageOrientation: 'none' });
      const tex = new THREE.Texture(bmp);
      tex.flipY = false; // 行 0 = 北
      tex.wrapS = THREE.RepeatWrapping;
      tex.colorSpace = THREE.NoColorSpace;
      tex.needsUpdate = true;
      return tex;
    };
    const day = (k) => new Date(Date.now() - k * 86400000).toISOString().slice(0, 10);
    let today = null;
    for (const k of [1, 2]) {
      try {
        today = await load(wms('VIIRS_SNPP_CorrectedReflectance_TrueColor', day(k)));
        this.cloudDate = day(k);
        break;
      } catch (err) {
        if (k === 2) throw err;
      }
    }
    this.shared.cloudBase.value = await load(wms('BlueMarble_NextGeneration'));
    this.shared.cloudToday.value = today;
  }

  setImagery(on) {
    this.shared.imgOn.value = on ? 1 : 0;
  }

  #disposeTile(t) {
    if (t.mesh) {
      this.scene.remove(t.mesh);
      t.mesh.geometry.dispose();
      t.mesh.material.dispose();
    }
    t.tex?.dispose();
    this.tiles.delete(t.key);
  }

  // 極のふた（メルカトルが届かない緯度 ±85° より先）。縁の高さはズーム 2 のタイルから
  #buildCaps() {
    for (const m of this.caps ?? []) {
      this.scene.remove(m);
      m.geometry.dispose();
    }
    this.caps = [];
    const SEG = 128, RINGS = 6;
    for (const north of [true, false]) {
      const n = 2 ** MIN_ZOOM;
      const rim = [];
      let ok = true;
      for (let k = 0; k <= SEG; k++) {
        const lon = -180 + (360 * k) / SEG;
        const x = Math.min(n - 1, Math.floor(((lon + 180) / 360) * n));
        const t = this.tiles.get(`${MIN_ZOOM}/${x}/${north ? 0 : n - 1}`);
        if (t?.state !== 'ready') ok = false;
        const u = ((lon + 180) / 360) * n - x;
        rim.push(ok ? Math.max(0, gridAt(t.grid, u, north ? 0 : 1)) : 0);
      }
      if (!ok) return;
      const poleH = north ? 0 : 2800;
      const center = ecef(north ? 90 : -90, 0, GLOBE_R);
      const pos = [], hs = [], idx = [];
      const p = [0, 0, 0];
      const lat0 = north ? MERC_MAX_LAT : -MERC_MAX_LAT;
      for (let r = 0; r <= RINGS; r++) {
        const f = r / RINGS;
        const lat = lat0 + ((north ? 90 : -90) - lat0) * f * 0.999;
        for (let k = 0; k <= SEG; k++) {
          const lon = -180 + (360 * k) / SEG;
          const h = rim[k] + (poleH - rim[k]) * (f * f * (3 - 2 * f));
          ecef(lat, lon, GLOBE_R + h * this.exag, p);
          pos.push(p[0] - center[0], p[1] - center[1], p[2] - center[2]);
          hs.push(north ? (r === 0 ? -1 : -1) : h);
        }
      }
      const w = SEG + 1;
      for (let r = 0; r < RINGS; r++) {
        for (let k = 0; k < SEG; k++) {
          const a = r * w + k, b = a + 1, c = a + w, d = c + 1;
          idx.push(a, c, b, b, c, d, a, b, c, b, d, c);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((pos.length / 3) * 2), 2));
      g.setAttribute('aH', new THREE.Float32BufferAttribute(hs, 1));
      g.setIndex(idx);
      const mesh = new THREE.Mesh(g, this.capMaterial);
      mesh.frustumCulled = false;
      mesh.userData.center = center;
      this.scene.add(mesh);
      this.caps.push(mesh);
    }
    this.capsDirty = false;
    this.capsExag = this.exag;
  }

  #setupSky() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.skyMat = new THREE.ShaderMaterial({
      uniforms: { ...this.shared, invProj: { value: new THREE.Matrix4() }, camRot: { value: new THREE.Matrix4() }, starI: { value: 1 } },
      vertexShader: /* glsl */ `
        varying vec2 vNdc;
        void main() { vNdc = position.xy; gl_Position = vec4( position.xy, 1.0, 1.0 ); }`,
      fragmentShader: /* glsl */ `
        varying vec2 vNdc;
        uniform mat4 invProj, camRot;
        uniform float starI;
        ${GLOBE_ATMO_GLSL}
        ${GLOBE_CLOUD_GLSL}
        float sHash( vec3 p ) { p = fract( p * 0.3183099 + 0.1 ); p *= 17.0; return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) ); }
        vec3 stars( vec3 d ) {
          vec3 s = vec3( 0.0 );
          for ( int l = 0; l < 2; l ++ ) {
            float sc = l == 0 ? 180.0 : 520.0;
            vec3 q = d * sc;
            vec3 c = floor( q );
            float h = sHash( c );
            float th = l == 0 ? 0.988 : 0.975;
            if ( h > th ) {
              vec3 pos = c + vec3( sHash( c + 1.37 ), sHash( c + 2.11 ), sHash( c + 3.73 ) );
              float dd = length( q - pos );
              float b = pow( ( h - th ) / ( 1.0 - th ), 3.0 ) * ( l == 0 ? 1.0 : 0.35 );
              s += mix( vec3( 1.0, 0.78, 0.6 ), vec3( 0.7, 0.82, 1.0 ), sHash( c + 7.7 ) ) * b * exp( - dd * dd * 30.0 );
            }
          }
          return s;
        }
        void main() {
          vec4 v = invProj * vec4( vNdc, -1.0, 1.0 );
          v /= v.w;
          vec3 dir = normalize( ( camRot * vec4( v.xyz, 0.0 ) ).xyz );
          vec2 tp = gRaySphere( camC, dir, planetR );
          float tMax = ( tp.x < tp.y && tp.x > 0.0 ) ? tp.x : 1e30;
          vec3 ins, tr;
          gAtmosphere( camC, dir, tMax, 16, ins, tr );
          vec3 col = ins;
          if ( tMax > 1e29 ) {
            float sd = dot( dir, sunDir );
            col += tr * ( sunI * 60.0 * smoothstep( 0.99996, 0.99999, sd ) + stars( dir ) * starI );
          }
          // 空に見える雲（地上から見上げたとき・宇宙から地球の縁のあたり）
          float tc;
          vec4 cl = gClouds( camC, dir, tMax, tc );
          if ( cl.a > 0.0 ) {
            vec3 ci, ct;
            gAtmosphere( camC, dir, tc, 6, ci, ct );
            col = mix( col, cl.rgb * ct + ci, cl.a );
          }
          gl_FragColor = vec4( col, 1.0 );
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      depthTest: false,
      depthWrite: false,
    });
    const sky = new THREE.Mesh(g, this.skyMat);
    sky.frustumCulled = false;
    sky.renderOrder = -1;
    this.scene.add(sky);
  }

  // オーロラ：夜側の両極のまわり（磁気緯度 約 67° の輪、高さ 100〜300 km）に光る帯。宇宙からは輪、地上からは空のカーテン。
  // 画面全体に光線を飛ばし、その高さの殻の中を歩いて光を足し合わせる（地球に隠れる所は数えない）
  #setupAurora() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    const pole = (lat, lon) => new THREE.Vector3(...ecef(lat, lon, 1));
    this.auroraMat = new THREE.ShaderMaterial({
      uniforms: {
        camC: this.shared.camC, sunDir: this.shared.sunDir, planetR: this.shared.planetR,
        invProj: this.skyMat.uniforms.invProj, camRot: this.skyMat.uniforms.camRot,
        magN: { value: pole(80.7, -72.7) }, magS: { value: pole(-80.7, 107.3) },
        aTime: { value: 0 }, aI: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vNdc;
        void main() { vNdc = position.xy; gl_Position = vec4( position.xy, 1.0, 1.0 ); }`,
      fragmentShader: /* glsl */ `
        varying vec2 vNdc;
        uniform mat4 invProj, camRot;
        uniform vec3 camC, sunDir, magN, magS;
        uniform float planetR, aTime, aI;
        vec2 rs( vec3 ro, vec3 rd, float r ) {
          float b = dot( ro, rd ), c = dot( ro, ro ) - r * r, d = b * b - c;
          if ( d < 0.0 ) return vec2( 1e30, -1e30 );
          d = sqrt( d );
          return vec2( - b - d, - b + d );
        }
        float h1( float n ) { return fract( sin( n ) * 43758.5453 ); }
        float n1( float x ) { float i = floor( x ), f = fract( x ); return mix( h1( i ), h1( i + 1.0 ), f * f * ( 3.0 - 2.0 * f ) ); }
        void main() {
          vec4 v = invProj * vec4( vNdc, -1.0, 1.0 );
          v /= v.w;
          vec3 dir = normalize( ( camRot * vec4( v.xyz, 0.0 ) ).xyz );
          float R0 = planetR + 95000.0, R1 = planetR + 320000.0;
          vec2 o = rs( camC, dir, R1 );
          if ( o.y < 0.0 || o.x > o.y ) discard;
          float t0 = max( o.x, 0.0 ), t1 = o.y;
          vec2 pl = rs( camC, dir, planetR );
          if ( pl.x < pl.y && pl.x > 0.0 ) t1 = min( t1, pl.x );
          if ( t1 <= t0 ) discard;
          vec3 col = vec3( 0.0 );
          const int N = 40;
          float dt = ( t1 - t0 ) / float( N );
          // 刻みの始まりを画素ごとにずらす（横縞の段差を細かいざらつきに変える）
          float jit = fract( sin( dot( gl_FragCoord.xy, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
          for ( int i = 0; i < N; i ++ ) {
            vec3 p = camC + dir * ( t0 + ( float( i ) + jit ) * dt );
            float r = length( p );
            if ( r < R0 || r > R1 ) continue;
            vec3 u = p / r;
            // 夜側だけ（昼の空には見えない）
            float night = smoothstep( 0.05, -0.15, dot( u, sunDir ) );
            if ( night <= 0.0 ) continue;
            // 磁気緯度（北・南の近い方）
            float mn = asin( clamp( dot( u, magN ), -1.0, 1.0 ) ), ms = asin( clamp( dot( u, magS ), -1.0, 1.0 ) );
            float ml = max( mn, ms );
            vec3 mp = mn > ms ? magN : magS;
            // 磁気の経度（カーテンのうねりと縦の筋に使う）
            vec3 e1 = normalize( cross( mp, vec3( 0.0, 1.0, 0.001 ) ) ), e2 = cross( mp, e1 );
            float mlon = atan( dot( u, e2 ), dot( u, e1 ) );
            float center = radians( 67.0 ) + ( n1( mlon * 3.0 + aTime * 0.05 ) - 0.5 ) * radians( 4.0 );
            float band = exp( - pow( ( ml - center ) / radians( 2.2 ), 2.0 ) );
            if ( band < 0.01 ) continue;
            float hgt = ( r - R0 ) / ( R1 - R0 ); // 0 = 下の縁（緑）、1 = 上（赤）
            float rays = 0.4 + 0.9 * n1( mlon * 120.0 + aTime * 0.3 ) * n1( mlon * 37.0 - aTime * 0.2 );
            vec3 c = mix( vec3( 0.15, 1.0, 0.4 ), vec3( 0.8, 0.2, 0.45 ), smoothstep( 0.15, 0.6, hgt ) ) * exp( - hgt * 2.5 );
            col += c * band * rays * night * dt;
          }
          gl_FragColor = vec4( col * aI * 1.5e-5, 1.0 );
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    });
    const m = new THREE.Mesh(g, this.auroraMat);
    m.frustumCulled = false;
    m.renderOrder = 10;
    m.visible = false;
    this.auroraMesh = m;
    this.scene.add(m);
  }

  // オーロラの強さ（0 = 出さない）
  setAurora(k) {
    this.auroraMat.uniforms.aI.value = k;
    this.auroraMesh.visible = k > 0;
  }

  // ---- 操作 ----
  #setupControls() {
    const c = this.canvas;
    let drag = null;
    // 画面に触れている指（タッチ）。2 本のときはつまんで寄る・ひねって向き・そろえて上下で傾き
    const touches = new Map();
    let pinch = null;
    const pinchState = () => {
      const [a, b] = [...touches.values()];
      return { d: Math.hypot(b.x - a.x, b.y - a.y), ang: Math.atan2(b.y - a.y, b.x - a.x), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    };
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => {
      this.flight = null;
      try {
        c.setPointerCapture(e.pointerId);
      } catch {}
      if (e.pointerType === 'touch') {
        touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (touches.size === 2) {
          drag = null;
          pinch = pinchState();
          return;
        }
        if (touches.size > 2) return;
      }
      drag = { x: e.clientX, y: e.clientY, rotate: e.button === 2 || e.button === 1 || e.shiftKey || e.ctrlKey };
    });
    c.addEventListener('pointermove', (e) => {
      const v = this.view;
      if (touches.has(e.pointerId)) {
        touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pinch && touches.size === 2) {
          const p = pinchState();
          // つまむ・広げる：指の間隔の比だけ寄る（指の中ほどへ少し寄せる）
          const k = pinch.d / Math.max(1, p.d);
          if (k < 1) {
            const hit = this.pick(p.mx, p.my);
            if (hit) {
              const f = 1 - k;
              v.lat += (hit.lat - v.lat) * f;
              v.lon += wrapLon(hit.lon - v.lon) * f;
            }
          }
          v.range = THREE.MathUtils.clamp(v.range * k, 60, 6e7);
          // ひねる：向き。2 本そろえて上下：傾き
          let da = p.ang - pinch.ang;
          if (da > Math.PI) da -= 2 * Math.PI;
          if (da < -Math.PI) da += 2 * Math.PI;
          v.heading = (v.heading - (da * 180) / Math.PI + 360) % 360;
          v.tilt = THREE.MathUtils.clamp(v.tilt + (p.my - pinch.my) * 0.25, 0, this.#maxTilt());
          pinch = p;
          return;
        }
      }
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX;
      drag.y = e.clientY;
      if (drag.rotate) {
        v.heading = (v.heading + dx * 0.3 + 360) % 360;
        v.tilt = THREE.MathUtils.clamp(v.tilt + dy * 0.25, 0, this.#maxTilt());
      } else {
        this.#pan(-dx, dy);
      }
    });
    const up = (e) => {
      touches.delete(e.pointerId);
      if (touches.size < 2) pinch = null;
      // 2 本から 1 本に戻ったら、残った指でそのまま動かせるように
      if (touches.size === 1) {
        const [p] = touches.values();
        drag = { x: p.x, y: p.y, rotate: false };
      } else drag = null;
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.flight = null;
        const k = Math.exp(Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 200) * 0.0015);
        // 寄るときは、カーソルの先へ少し寄せる
        if (k < 1) {
          const hit = this.pick(e.clientX, e.clientY);
          if (hit) {
            const f = 1 - k;
            this.view.lat += (hit.lat - this.view.lat) * f;
            this.view.lon += wrapLon(hit.lon - this.view.lon) * f;
          }
        }
        this.view.range = THREE.MathUtils.clamp(this.view.range * k, 60, 6e7);
        this.view.tilt = Math.min(this.view.tilt, this.#maxTilt());
      },
      { passive: false },
    );
    c.addEventListener('dblclick', (e) => {
      const hit = this.pick(e.clientX, e.clientY);
      if (hit) this.flyTo({ lat: hit.lat, lon: hit.lon, range: this.view.range / 3 });
    });
    this.keys = new Set();
    this.onKey = (e, down) => {
      if (e.target instanceof HTMLInputElement) return false;
      const k = e.key.toLowerCase();
      if (!['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'w', 'a', 's', 'd', 'q', 'e', 'r', 'f', '+', '-', '='].includes(k)) return false;
      if (down) this.keys.add(k);
      else this.keys.delete(k);
      return true;
    };
  }

  #maxTilt() {
    const r = Math.log10(Math.max(1, this.view.range));
    return 86 - 76 * THREE.MathUtils.clamp((r - 5) / 1.8, 0, 1);
  }

  // 画面の向きで地表をずらす（dx, dy: 画素）
  #pan(dx, dy) {
    const v = this.view;
    const mpp = (v.range * 2 * Math.tan((this.camera.fov * D2R) / 2)) / Math.max(1, this.canvas.clientHeight);
    const H = v.heading * D2R;
    const right = dx * mpp, fwd = dy * mpp;
    const dn = fwd * Math.cos(H) - right * Math.sin(H);
    const de = fwd * Math.sin(H) + right * Math.cos(H);
    v.lat = THREE.MathUtils.clamp(v.lat + (dn / GLOBE_R) / D2R, -89.5, 89.5);
    v.lon = wrapLon(v.lon + (de / (GLOBE_R * Math.max(0.05, Math.cos(v.lat * D2R)))) / D2R);
  }

  // 画面の点の先の地表（海面の球との交わり）の経緯度
  pick(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const d = ray.ray.direction;
    const o = this.camEcef;
    const b = o[0] * d.x + o[1] * d.y + o[2] * d.z;
    const cc = o[0] ** 2 + o[1] ** 2 + o[2] ** 2 - GLOBE_R ** 2;
    const disc = b * b - cc;
    if (disc < 0) return null;
    const t = -b - Math.sqrt(disc);
    if (t < 0) return null;
    const ll = toLatLon(o[0] + d.x * t, o[1] + d.y * t, o[2] + d.z * t);
    return { lat: ll.lat, lon: ll.lon };
  }

  // 見ている所へ飛ぶ（途中は少し高く上がる）
  flyTo({ lat, lon, range = this.view.range, heading = this.view.heading, tilt }) {
    const v = this.view;
    const from = { ...v };
    const to = { lat, lon: from.lon + wrapLon(lon - from.lon), range, heading, tilt: tilt ?? Math.min(v.tilt, 45) };
    // 離れている所ほど高く上がる
    const ang = Math.acos(Math.min(1, Math.max(-1, dot3(enu(from.lat, from.lon).up, enu(lat, lon).up))));
    const peak = Math.max(from.range, to.range, ang * GLOBE_R * 1.2);
    this.flight = { from, to, peak, start: performance.now(), dur: 1200 + Math.min(3500, ang * 2500) };
  }

  // ---- 地表の高さ（読み込み済みのいちばん細かいタイルから） ----
  heightAt(lat, lon) {
    for (let z = GLOBE_MAX_ZOOM; z >= 0; z--) {
      const l = locateTile(lat, lon, z);
      const t = this.tiles.get(`${z}/${l.x}/${l.y}`);
      if (t?.state === 'ready') return gridAt(t.grid, l.u, l.v);
    }
    return 0;
  }

  surfaceAt(lat, lon) {
    return Math.max(0, this.heightAt(lat, lon)) * this.exag;
  }

  setExaggeration(k) {
    this.exag = k;
    this.shared.exag.value = k;
    for (const t of this.tiles.values()) t.bounds = null;
    this.capsDirty = true;
  }

  // ---- 毎コマ ----
  #frame() {
    const now = performance.now();
    const raw = (now - (this.lastT ?? now)) / 1000;
    const dt = Math.min(0.1, raw);
    this.lastT = now;
    if (this.running) this.#adaptQuality(raw);
    this.frameNo++;
    this.#keys(dt);
    this.#flight(now);
    const v = this.view;
    // 見ている所の地面の高さ（少しずつ追う）
    this.targetH += (this.surfaceAt(v.lat, v.lon) - this.targetH) * 0.2;
    const cam = orbitCamera(v, this.targetH);
    // 地面より下へは潜らない
    const cl = toLatLon(...cam.pos);
    const floor = GLOBE_R + this.surfaceAt(cl.lat, cl.lon) + 12;
    if (cl.r < floor) for (let k = 0; k < 3; k++) cam.pos[k] *= floor / cl.r;
    this.camEcef = cam.pos;
    const C = cam.pos;
    this.camera.position.set(0, 0, 0);
    this.camera.up.set(...cam.up);
    this.camera.lookAt(cam.target[0] - C[0], cam.target[1] - C[1], cam.target[2] - C[2]);
    // 近い所ほど near を大きくして、深度の精度を上げる
    const alt = cl.r - GLOBE_R;
    this.camera.near = THREE.MathUtils.clamp(alt * 0.02, 0.5, 2000);
    this.camera.far = 1e9;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();

    this.shared.camC.value.set(C[0], C[1], C[2]);
    this.shared.cloudTime.value += dt * 0.02;
    if (this.auroraMat) this.auroraMat.uniforms.aTime.value += dt;
    this.shared.sunDir.value.copy(this.#sunDir());
    this.skyMat.uniforms.invProj.value.copy(this.camera.projectionMatrixInverse);
    this.skyMat.uniforms.camRot.value.copy(this.camera.matrixWorld);

    this.#select();
    if (this.capsDirty || (this.caps && this.capsExag !== this.exag)) this.#buildCaps();
    for (const m of this.caps ?? []) {
      const c = m.userData.center;
      m.position.set(c[0] - C[0], c[1] - C[1], c[2] - C[2]);
    }
    this.renderer.render(this.scene, this.camera);
    if (this.frameNo % 6 === 0) this.#report(cl, alt);
  }

  #keys(dt) {
    if (!this.keys.size) return;
    const k = this.keys;
    const sp = 500 * dt;
    if (k.has('arrowup') || k.has('w')) this.#pan(0, sp);
    if (k.has('arrowdown') || k.has('s')) this.#pan(0, -sp);
    if (k.has('arrowleft') || k.has('a')) this.#pan(-sp, 0);
    if (k.has('arrowright') || k.has('d')) this.#pan(sp, 0);
    if (k.has('q')) this.view.heading = (this.view.heading - 60 * dt + 360) % 360;
    if (k.has('e')) this.view.heading = (this.view.heading + 60 * dt) % 360;
    if (k.has('r')) this.view.tilt = Math.min(this.#maxTilt(), this.view.tilt + 40 * dt);
    if (k.has('f')) this.view.tilt = Math.max(0, this.view.tilt - 40 * dt);
    if (k.has('+') || k.has('=')) this.view.range = Math.max(60, this.view.range * Math.exp(-1.5 * dt));
    if (k.has('-')) this.view.range = Math.min(6e7, this.view.range * Math.exp(1.5 * dt));
    this.flight = null;
  }

  #flight(now) {
    const f = this.flight;
    if (!f) return;
    const a = Math.min(1, (now - f.start) / f.dur);
    const e = a * a * (3 - 2 * a);
    const v = this.view;
    v.lat = f.from.lat + (f.to.lat - f.from.lat) * e;
    v.lon = wrapLon(f.from.lon + (f.to.lon - f.from.lon) * e);
    v.heading = f.from.heading + wrapLon(f.to.heading - f.from.heading) * e;
    v.tilt = f.from.tilt + (f.to.tilt - f.from.tilt) * e;
    // 高さ：対数で補間し、途中で山なりに上がる
    const l0 = Math.log(f.from.range), l1 = Math.log(f.to.range), lp = Math.log(f.peak);
    const base = l0 + (l1 - l0) * e;
    const bump = Math.max(0, lp - Math.max(l0, l1)) * 4 * e * (1 - e);
    v.range = Math.exp(base + bump);
    if (a >= 1) this.flight = null;
  }

  setSunMode(mode) {
    this.sunMode = mode;
    if (mode === 'lapse') {
      this.lapseBase = Date.now();
      this.lapseT0 = performance.now();
    }
  }

  // 太陽の日時（'real' はいま、'lapse' は早送り中の日時。'follow' では null）
  sunDate() {
    if (this.sunMode === 'real') return new Date();
    if (this.sunMode === 'lapse') return new Date(this.lapseBase + (performance.now() - this.lapseT0) * (86400 / 40));
    return null;
  }

  #sunDir() {
    if (this.sunMode === 'real' || this.sunMode === 'lapse') {
      const s = subsolarPoint(this.sunDate());
      return new THREE.Vector3(...ecef(s.lat, s.lon, 1));
    }
    // 見ている所での太陽の高さ・方位（シーンの太陽）
    const f = enu(this.view.lat, this.view.lon);
    const d = sunDirection(this.sceneSun.elevation, this.sceneSun.azimuth); // x = 東, y = 上, z = 南
    return new THREE.Vector3(
      f.east[0] * d[0] + f.up[0] * d[1] - f.north[0] * d[2],
      f.east[1] * d[0] + f.up[1] * d[1] - f.north[1] * d[2],
      f.east[2] * d[0] + f.up[2] * d[1] - f.north[2] * d[2],
    ).normalize();
  }

  // 四分木をたどって、描くタイルを選ぶ
  #select() {
    const C = this.camEcef;
    const frustum = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse),
    );
    const sphere = new THREE.Sphere();
    const draw = [];
    const need = [];
    const visible = (t) => {
      const b = this.#boundsOf(t);
      if (behindHorizon(C, b.center, b.radius)) return false;
      sphere.center.set(b.center[0] - C[0], b.center[1] - C[1], b.center[2] - C[2]);
      sphere.radius = b.radius;
      return frustum.intersectsSphere(sphere);
    };
    const visit = (t) => {
      t.used = this.frameNo;
      const b = this.#boundsOf(t);
      const d = Math.max(0, Math.hypot(b.center[0] - C[0], b.center[1] - C[1], b.center[2] - C[2]) - b.radius);
      const split = t.z < MIN_ZOOM || (t.z < GLOBE_MAX_ZOOM && d < SPLIT * t.info.width);
      if (split) {
        const kids = [];
        let ready = true;
        for (let k = 0; k < 4; k++) {
          const c = this.#tile(t.z + 1, t.x * 2 + (k & 1), t.y * 2 + (k >> 1));
          if (!visible(c)) continue;
          c.used = this.frameNo;
          kids.push(c);
          if (c.state !== 'ready') {
            ready = false;
            need.push({ t: c, d });
          }
        }
        if (ready) {
          for (const c of kids) visit(c);
          return;
        }
      }
      draw.push(t);
    };
    const root = this.#tile(0, 0, 0);
    if (root.state === 'ready') visit(root);
    else this.#request(root);

    // 描くタイルだけを場面に置く
    const C0 = C;
    for (const m of this.drawn ?? []) m.visible = false;
    this.drawn = [];
    for (const t of draw) {
      if (!t.mesh || t.meshExag !== this.exag) this.#buildMesh(t);
      if (!t.mesh.parent) this.scene.add(t.mesh);
      t.mesh.visible = true;
      t.mesh.position.set(t.center[0] - C0[0], t.center[1] - C0[1], t.center[2] - C0[2]);
      this.#bindImagery(t);
      this.drawn.push(t.mesh);
    }
    // 取り寄せ：粗いもの・近いものから
    need.sort((a, b) => a.t.z - b.t.z || a.d - b.d);
    for (const { t } of need) this.#request(t);
    this.drawCount = draw.length;
    this.needCount = need.length;
    // 見えなくなった所の注文は取り消す
    if (this.frameNo % 30 === 0) this.worker.postMessage({ cancel: true, keep: need.map((x) => x.t.key) });
    this.#evict();
    this.#evictImages();
  }

  #evict() {
    const ready = [];
    for (const t of this.tiles.values()) {
      if (t.state === 'ready' && t.z > MIN_ZOOM) ready.push(t);
      else if (t.state === 'none' && t.used < this.frameNo - 600) this.tiles.delete(t.key);
    }
    if (ready.length <= MAX_TILES) return;
    ready.sort((a, b) => a.used - b.used);
    for (const t of ready.slice(0, ready.length - MAX_TILES)) {
      if (t.used >= this.frameNo) break;
      this.#disposeTile(t);
    }
  }

  #report(cl, alt) {
    this.onInfo({
      lat: this.view.lat, lon: this.view.lon, camLat: cl.lat, camLon: cl.lon, alt,
      range: this.view.range, heading: this.view.heading, tilt: this.view.tilt, ground: this.heightAt(this.view.lat, this.view.lon),
      sunDate: this.sunDate(),
      tiles: this.drawCount, loading: this.loading + (this.needCount ?? 0) > 0 ? this.loading : 0,
    });
  }

  // 1 秒ほどの平均の描画間隔を見て、解像度の倍率を上げ下げする（目安 30〜50 fps）
  #adaptQuality(dt) {
    const q = this.quality;
    if (dt <= 0 || dt > 0.5) return; // 画面が隠れていた・止まっていた間は数えない
    q.frames++;
    q.sum += dt;
    if (q.sum < 1) return;
    const avg = q.sum / q.frames;
    q.frames = 0;
    q.sum = 0;
    let next = q.ratio;
    if (avg > 1 / 28) next = Math.max(0.5, q.ratio * 0.85);
    else if (avg < 1 / 50) next = Math.min(this.maxRatio, q.ratio * 1.12);
    if (Math.abs(next - q.ratio) > 0.02) {
      q.ratio = next;
      this.renderer.setPixelRatio(next);
      this.#resize();
    }
  }

  #resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // 1 コマだけ進めて描く（画面が隠れていて自動では描かれないとき・書き出し）
  step() {
    this.#frame();
  }

  async capture() {
    this.#frame();
    return new Promise((res) => this.canvas.toBlob(res, 'image/png'));
  }

  dispose() {
    this.stop();
    this.worker.terminate();
    for (const t of [...this.tiles.values()]) this.#disposeTile(t);
    this.renderer.dispose();
    this.canvas.remove();
  }
}

function wrapLon(l) {
  return ((((l + 180) % 360) + 360) % 360) - 180;
}

function dot3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
