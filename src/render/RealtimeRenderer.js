import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { Water } from 'three/addons/objects/Water.js';
import { touches } from '../core/schema.js';
import { t } from '../i18n/index.js';
import { sunDirection, sunLight, hazeColor, nightFactor, NIGHT_SKY } from '../core/sun.js';
import { TerrainService, fieldKeyOf } from '../three/TerrainService.js';
import { createColorTexture } from '../three/terrainMesh.js';
import { GpuTerrain, ORIGIN_STEP } from './GpuTerrain.js';
import { createCurveUniforms, curvePoint } from './curvatureGLSL.js';
import { createWaterDisc, curveWater } from './waterDisc.js';
import { planetRadius } from '../core/schema.js';
import { WalkControls } from './WalkControls.js';
import { WalkAudio } from './WalkAudio.js';
import { Buildings } from './Buildings.js';
import { Precipitation } from './Precipitation.js';
import { RealtimeTrees } from './RealtimeTrees.js';
import { decodePng } from '../core/png16.js';
import { decodePhoto } from '../io/photo.js';
import { createWaterNormals } from '../three/waterNormals.js';
import { TextureService } from '../three/TextureService.js';
import { ObjectLayer } from '../three/objectLayer.js';
import { RealtimeAtmosphere } from './RealtimeAtmosphere.js';
import { atmosphereParams } from './atmosphereParams.js';
import { createCloudUniforms, patchStandardMaterial, patchWaterMaterial } from './cloudShadowPatch.js';

const R2D = 180 / Math.PI;

// リアルタイム表示モード。ストアのシーンを購読し、変わった部分だけ作り直す。
// 将来の「歩き回るモード」はここに操作系を足す。高画質書き出しは別の描画器が同じシーンを読む。
//
// 数千 km の大地のための精度対策：
//   ・描くときだけ、世界全体を「カメラの近くの原点（65536 m ごと）」へずらす（this.world を動かす）。
//     GPU には原点からの相対座標しか渡らないので、カメラの近くは何千 km 離れても細かく正確に描ける
//   ・深度は対数（logarithmicDepthBuffer）。足元 1 m から地平線の 1 万 km 先まで前後を取り違えない
//   ・水面はカメラについて動く円盤（近くは細かく、遠くは粗い同心円）
export class RealtimeRenderer {
  constructor(canvas, store, { onStatus, selection } = {}) {
    this.store = store;
    this.selection = selection; // 画面上の選択（シーンデータではない UI 状態）: { selected: id|null }
    this.onStatus = onStatus ?? (() => {});

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', logarithmicDepthBuffer: true });
    // 画質（解像度の倍率）。重いときは自動で下げ、軽いときは上げる（#adaptQuality）
    this.maxRatio = Math.min(window.devicePixelRatio, 2);
    this.quality = { ratio: this.maxRatio, frames: 0, sum: 0 };
    renderer.setPixelRatio(this.maxRatio);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer = renderer;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0xffffff, 0);
    this.camera = new THREE.PerspectiveCamera(50, 1, 1, 1e8);
    // 世界に置く物はすべてここへ（描くときだけ原点をずらす）
    this.world = new THREE.Group();
    this.world.name = 'World';
    this.scene.add(this.world);
    this.origin = new THREE.Vector2(); // いまの原点（世界座標の x, z）
    this.curveUniforms = createCurveUniforms();

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.minDistance = 4;
    this.controls.zoomToCursor = true;
    // 視点を動かし終えたらシーンへ書き戻す（自分由来の変更なので再構築はしない）
    this.controls.addEventListener('end', () => this.#commitCamera());
    // 自分で視点を動かし始めたら、進行中の移動（F / Home）はやめる
    this.controls.addEventListener('start', () => {
      this.flight?.onEnd?.();
      this.flight = null;
    });

    // 空
    this.sky = new Sky();
    this.sky.scale.setScalar(200000);
    this.scene.add(this.sky);
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.envScene = new THREE.Scene();
    this.envTarget = null;
    this.envDirty = true;

    // 太陽光
    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048); // 影の範囲はカメラの見ている辺りだけなので 2048 で足りる
    this.sun.shadow.bias = -0.0002;
    this.world.add(this.sun, this.sun.target);
    // 夜の光（月明かり・星明かり）。太陽が沈むと強くなる
    this.nightLight = new THREE.HemisphereLight(new THREE.Color(...NIGHT_SKY).multiplyScalar(8), 0x101014, 0);
    this.world.add(this.nightLight);

    // 水
    this.water = new Water(createWaterDisc(2e7), {
      textureWidth: 512, // 映り込みは波で揺らぐので半分の細かさで十分（軽くする）
      textureHeight: 512,
      waterNormals: createWaterNormals(),
      sunDirection: new THREE.Vector3(0, 1, 0),
      sunColor: 0xffffff,
      waterColor: 0x0f3a4a,
      distortionScale: 3.7,
      fog: true,
    });
    this.water.rotation.x = -Math.PI / 2;
    this.water.frustumCulled = false;
    // 雲の影（全素材で共有する uniform）
    this.cloudUniforms = createCloudUniforms();
    this.cloudUniforms.cloudSunDir.value = new THREE.Vector3(0, 1, 0);
    this.shared = { ...this.cloudUniforms, ...this.curveUniforms };
    patchWaterMaterial(this.water.material, this.cloudUniforms);
    curveWater(this.water.material, this.curveUniforms, this.cloudUniforms.cloudOrigin.value);
    // 景色は物理的な明るさ（露出で 1/8 ほどに下げて表示）なので、水面の色・映り込みも同じ明るさの尺度へ上げる。
    // そのままでは水面だけが 1/8 の暗さになり、真っ黒に見える
    this.water.material.uniforms.kWaterGain = { value: 1 };
    this.water.material.fragmentShader = this.water.material.fragmentShader
      .replace('uniform vec3 waterColor;', 'uniform vec3 waterColor;\nuniform float kWaterGain;')
      .replace(/vec3 albedo = mix\([^;]*\);/, (m) => `${m}\nalbedo *= kWaterGain;`);
    // Water シェーダは霧をトーンマップの「後」に混ぜる。霧の色は物理的な明るさ（1 を超える）なので、
    // そのままでは遠くの水面が白く飛ぶ。霧を先に混ぜてから、ほかの物体と同じようにトーンマップする
    const wfs = this.water.material.fragmentShader;
    const fogInc = '#include <fog_fragment>';
    const toneInc = '#include <tonemapping_fragment>';
    if (wfs.includes(fogInc) && wfs.includes(toneInc)) {
      this.water.material.fragmentShader = wfs.replace(fogInc, '').replace(toneInc, `${fogInc}\n${toneInc}`);
      this.water.material.needsUpdate = true;
    }
    this.world.add(this.water);

    // 地形（高さ場はワーカーから届き、形と色は GPU が作る）
    this.gpuTerrain = new GpuTerrain({
      curveUniforms: this.curveUniforms,
      patchMaterial: (m) => patchStandardMaterial(m, this.shared),
    });
    this.terrain = null; // 最初の高さ場が届いたら gpuTerrain.mesh
    this.colorTexture = null; // 書き出し用に焼いた地表の色
    this.colorKey = null;
    this.terrainData = null; // { field, res }
    this.terrainService = new TerrainService(
      (r) => this.#onTerrain(r),
      (err) => this.onStatus(t('地形の生成に失敗: {msg}', { msg: err }), 'error'),
    );

    // 物体（球・立方体など）と、その模様テクスチャ
    this.textureService = new TextureService((key) => this.objects.onTexture(key));
    this.objects = new ObjectLayer(this.world, this.textureService, { patchMaterial: (m) => patchStandardMaterial(m, this.shared) });
    // 木（一枚絵と同じ所に同じ木。カメラの周りだけ）
    this.trees = new RealtimeTrees(this.world, (m) => patchStandardMaterial(m, this.shared));
    this.treeTerrain = {
      sample: (x, z) => this.#terrainAt(x, z).sample(x, z),
      groundAt: (x, z) => this.#terrainAt(x, z).groundAt(x, z),
    };

    // 霧・光の筋・厚みのある雲（画面全体で計算して重ねる）
    this.atmosphere = new RealtimeAtmosphere(renderer);
    this.shadowDirty = true;
    this.shadowFor = null; // 霧の影の地図を作ったときのカメラの周り { center, radius }
    this.#setupGizmo(canvas);
    // 歩き回るモード（一人称）。足元は地形と水面の高い方
    this.audio = new WalkAudio();
    // 雨・雪（カメラの周りだけ）
    this.precip = new Precipitation(this.scene);
    // 建物（地球から取り込んだ景観で、地面に近いとき）
    this.buildings = new Buildings(this.world, (m) => patchStandardMaterial(m, this.shared));
    this.walk = new WalkControls(this.camera, canvas, {
      groundAt: (x, z) => {
        const s = this.store.get();
        const g = this.#terrainAt(x, z).groundAt(x, z);
        return s.water.enabled ? Math.max(g, s.water.level + 0.2) : g;
      },
      onModeChange: (mode) => this.onWalk?.(mode, this.walk.speedScale),
      collide: (p) => this.trees.pushOut(p) | this.buildings?.pushOut(p),
    });

    this.timer = new THREE.Timer();
    this.#resize();
    new ResizeObserver(() => this.#resize()).observe(canvas.parentElement);

    store.subscribe((s, changed, meta) => this.#apply(s, changed, meta));
    this.#apply(store.get(), ['*'], {});
    renderer.setAnimationLoop(() => this.#frame());
  }

  // 書き出しなどで「いまの地形」を確実に使うための待ち合わせ
  async ready() {
    await this.terrainService.idle();
    // 地表の色のテクスチャは書き出しのときだけ焼く（シーンが変わっていれば焼き直す）
    const s = this.store.get();
    const ck = colorKeyOf(s);
    if (this.colorKey !== ck) {
      this.pendingColorKey = ck;
      this.terrainService.request(s, { withColors: true });
      await this.terrainService.idle();
    }
    await this.objects.ready();
    // 衛星写真の色を使う地形なら、書き出す地表の色も写真にする（行 0 = 北。焼いた色と同じ向き）
    let colorTexture = this.colorTexture;
    const photo = s.terrain.mode === 'heightmap' && s.terrain.photo !== false ? s.terrain.heightmap?.photo : null;
    if (photo) {
      if (this.exportPhoto?.url !== photo) {
        const bmp = await createImageBitmap(await (await fetch(photo)).blob());
        const canvas = document.createElement('canvas');
        canvas.width = bmp.width;
        canvas.height = bmp.height;
        canvas.getContext('2d').drawImage(bmp, 0, 0);
        bmp.close?.();
        const tex = new THREE.CanvasTexture(canvas);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 8;
        tex.name = 'TerrainPhoto';
        tex.userData.mimeType = 'image/jpeg'; // 写真は JPEG のまま書き出す（PNG にすると glb が何倍にもなる）
        this.exportPhoto?.tex.dispose();
        this.exportPhoto = { url: photo, tex };
      }
      colorTexture = this.exportPhoto.tex;
    }
    return {
      field: this.terrainData.field,
      res: this.terrainData.res,
      colorTexture,
      objectMeshes: this.objects.exportMeshes(),
      buildingMeshes: this.buildings?.exportMeshes() ?? [],
    };
  }

  // ---- 物体の置き場所 ----

  // 画面中央の先にある地面（地形か水面）の点。無ければ視線の先 size*6 の点
  // offset を渡すと、視線を平行にずらした先で探す
  groundPoint(offset = null) {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(0, 0), this.camera);
    if (offset) ray.ray.origin.add(offset);
    const s = this.store.get();
    const { origin, direction } = ray.ray;
    // 地形（高さ場を光線でたどる）と水面のうち近いほう
    const far = Math.max(s.terrain.size * 3, 100000);
    let hit = this.gpuTerrain.raycast(origin, direction, far);
    if (!hit && this.surround?.ready) hit = this.surround.terrain.raycast(origin, direction, Math.max(far, this.surround.size * 2));
    if (s.water.enabled && Math.abs(direction.y) > 1e-6) {
      const tw = (s.water.level - origin.y) / direction.y;
      if (tw > 0 && (!hit || tw < hit.distanceTo(origin))) hit = origin.clone().addScaledVector(direction, tw);
    }
    if (hit) return hit;
    return ray.ray.at(Math.min(s.terrain.size * 0.3, this.camera.position.distanceTo(this.controls.target) * 2 + 100), new THREE.Vector3());
  }

  // 画面の右向き（水平）の単位ベクトル
  sideVector() {
    const fwd = new THREE.Vector3();
    this.camera.getWorldDirection(fwd);
    const side = new THREE.Vector3(-fwd.z, 0, fwd.x);
    return side.lengthSq() < 1e-6 ? new THREE.Vector3(1, 0, 0) : side.normalize();
  }

  // 空に浮かぶ天体の置き場所：視線の向きの遠く、画面の上寄り（できれば地平線より上）
  skyPoint(diameter) {
    const fwd = new THREE.Vector3();
    this.camera.getWorldDirection(fwd);
    const flat = new THREE.Vector3(fwd.x, 0, fwd.z);
    if (flat.lengthSq() < 1e-6) flat.set(0, 0, -1);
    flat.normalize();
    const pitch = Math.asin(THREE.MathUtils.clamp(fwd.y, -1, 1));
    const half = this.camera.fov / 2 / R2D;
    let angle = pitch + half * 0.55;
    if (angle < 4 / R2D) angle = Math.min(4 / R2D, pitch + half * 0.85);
    const dist = Math.max(diameter * 3, this.store.get().terrain.size * 4);
    const dir = flat.multiplyScalar(Math.cos(angle)).setY(Math.sin(angle));
    return this.camera.position.clone().addScaledVector(dir, dist);
  }

  // ---- 視点の移動（なめらかに）----

  // 選んだ物体に寄る（向きは今のまま、物体が画面に収まる距離まで）
  frameObject(id) {
    const mesh = this.objects.meshOf(id);
    if (!mesh) return false;
    const box = new THREE.Box3().setFromObject(mesh);
    const center = box.getCenter(new THREE.Vector3());
    const r = box.getSize(new THREE.Vector3()).length() / 2;
    const dist = r / Math.sin(((this.camera.fov / 2) * Math.PI) / 180) * 1.3;
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.#flyTo(center.clone().addScaledVector(dir, dist), center);
    return true;
  }

  // 大地全体を見渡す（今の方角から、斜め上より）
  frameAll() {
    const t = this.store.get().terrain;
    const center = new THREE.Vector3(0, t.baseHeight + t.heightScale * 0.35, 0);
    const flat = this.camera.position.clone().sub(this.controls.target).setY(0);
    if (flat.lengthSq() < 1) flat.set(-1, 0, 1);
    flat.normalize();
    const dist = t.size * 0.95;
    // 大陸ほどの大きさでは、丸みで手前が沈むので真上寄りから見下ろす
    const R = planetRadius(this.store.get());
    const k = R > 0 ? THREE.MathUtils.clamp(t.size / (R * 0.4), 0, 1) : 0;
    const angle = 0.42 + k * 0.75;
    const pos = center.clone().addScaledVector(flat, dist * Math.cos(angle)).setY(center.y + dist * Math.sin(angle));
    this.#flyTo(pos, center);
  }

  #flyTo(position, target) {
    this.flight = {
      p0: this.camera.position.clone(),
      t0: this.controls.target.clone(),
      p1: position,
      t1: target,
      start: performance.now(),
      dur: 700,
    };
  }

  // カメラの道すじを再生する（Catmull-Rom でなめらかに）。onEnd: 終わったとき・途中で止めたとき
  playPath(onEnd) {
    const s = this.store.get();
    const path = s.camera.path ?? [];
    if (path.length < 2) return false;
    if (this.walk.active) this.setWalk(null);
    const P = path.map((k) => new THREE.Vector3(...k.position));
    const T = path.map((k) => new THREE.Vector3(...k.target));
    this.flight = { kind: 'path', P, T, start: performance.now(), dur: (path.length - 1) * Math.max(0.5, s.camera.pathSeconds ?? 5) * 1000, onEnd };
    return true;
  }

  #updateFlight() {
    const f = this.flight;
    if (!f) return;
    if (f.kind === 'path') {
      const k = Math.min(1, (performance.now() - f.start) / f.dur);
      const n = f.P.length - 1;
      // 全体を始めと終わりでゆっくりに
      const e = k * k * (3 - 2 * k) * n;
      const i = Math.min(n - 1, Math.floor(e)), u = e - i;
      const cr = (A, out) => {
        const p0 = A[Math.max(0, i - 1)], p1 = A[i], p2 = A[i + 1], p3 = A[Math.min(n, i + 2)];
        const u2 = u * u, u3 = u2 * u;
        return out.set(0, 0, 0)
          .addScaledVector(p0, -0.5 * u3 + u2 - 0.5 * u)
          .addScaledVector(p1, 1.5 * u3 - 2.5 * u2 + 1)
          .addScaledVector(p2, -1.5 * u3 + 2 * u2 + 0.5 * u)
          .addScaledVector(p3, 0.5 * u3 - 0.5 * u2);
      };
      cr(f.P, this.camera.position);
      cr(f.T, this.controls.target);
      if (k >= 1) {
        this.flight = null;
        this.#commitCamera();
        f.onEnd?.();
      }
      return;
    }
    const k = Math.min(1, (performance.now() - f.start) / f.dur);
    const e = k * k * (3 - 2 * k);
    this.camera.position.lerpVectors(f.p0, f.p1, e);
    this.controls.target.lerpVectors(f.t0, f.t1, e);
    if (k >= 1) {
      this.flight = null;
      this.#commitCamera();
    }
  }

  setGizmoMode(mode) {
    this.gizmo.setMode(mode);
  }

  // ---- 選択とギズモ ----

  #setupGizmo(canvas) {
    this.gizmo = new TransformControls(this.camera, canvas);
    this.gizmo.setSize(0.9);
    const helper = this.gizmo.getHelper();
    this.scene.add(helper);
    // 水面の映り込みにはギズモを描かない
    const waterBefore = this.water.onBeforeRender;
    this.water.onBeforeRender = (...args) => {
      const vis = helper.visible;
      helper.visible = false;
      // 映り込みの中では空の雲（2D）を描く。画面の雲は立体として後から重ねるので、映り込みにも雲が要る
      const cov = this.sky.material.uniforms.cloudCoverage;
      const saved = cov.value;
      cov.value = this.reflectClouds ?? saved;
      // 映り込みの地形は細部の起伏を省いて軽くする（揺らぐ水面では見分けがつかない）
      const det = this.gpuTerrain.uniforms.tDetailAmt;
      const detO = this.surround?.terrain.uniforms.tDetailAmt;
      const savedDetO = detO?.value;
      if (detO) detO.value = 0;
      const savedDet = det.value;
      det.value = 0;
      // 映り込みには木を描かない（揺らぐ水面では見分けがつかず、重い）
      const treesVis = this.trees.group.visible;
      this.trees.group.visible = false;
      const bVis = this.buildings?.group.visible;
      if (this.buildings) this.buildings.group.visible = false;
      waterBefore.apply(this.water, args);
      this.trees.group.visible = treesVis;
      if (this.buildings) this.buildings.group.visible = bVis;
      det.value = savedDet;
      if (detO) detO.value = savedDetO;
      cov.value = saved;
      helper.visible = vis;
    };
    this.gizmo.addEventListener('dragging-changed', (e) => {
      this.controls.enabled = !e.value;
      if (!e.value) this.#commitGizmo();
    });

    // ドラッグではなく「クリック」したときだけ選択を切り替える
    let down = null;
    canvas.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
    canvas.addEventListener('pointerup', (e) => {
      if (!down || e.button !== 0 || this.gizmo.dragging || this.walk?.active) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > 4) return;
      const rect = canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, this.camera);
      const hit = ray.intersectObjects(this.objects.meshes, false)[0];
      this.selection?.set('selected', hit ? hit.object.userData.kuniumiId : null);
    });
    this.selection?.subscribe(() => this.#attachGizmo());
  }

  #attachGizmo() {
    const mesh = this.objects.meshOf(this.selection?.get().selected);
    if (mesh) this.gizmo.attach(mesh);
    else this.gizmo.detach();
  }

  // ギズモで動かし終えたら、その物体の位置・回転・大きさをシーンへ書き戻す
  #commitGizmo() {
    const mesh = this.gizmo.object;
    if (!mesh) return;
    const id = mesh.userData.kuniumiId;
    const objs = this.store.get().objects.map((o) =>
      o.id === id
        ? {
            ...o,
            position: mesh.position.toArray().map(round1),
            rotation: [mesh.rotation.x, mesh.rotation.y, mesh.rotation.z].map((r) => round1(r * R2D)),
            scale: mesh.scale.toArray().map(round1),
          }
        : o,
    );
    this.store.set('objects', objs, { source: 'view' });
  }

  #apply(s, changed, meta) {
    const has = (p) => touches(changed, p);

    // 高さ場そのもの（ノイズ・ハイトマップ・解像度）が変わったときだけワーカーで計算し直す。
    // 大きさ・起伏・色・水位などは GPU の値を変えるだけなので即座に反映される
    if (has('terrain')) {
      const key = fieldKeyOf(s.terrain);
      if (key !== this.fieldKey) {
        this.fieldKey = key;
        this.terrainService.request(s, { withColors: false });
      }
    }
    if (has('terrain') || has('water') || has('vegetation')) {
      this.gpuTerrain.setScene(s);
      this.gpuTerrain.setSeason(s.terrain.season, s.terrain.winterSnow);
      this.trees.setSeason(s.terrain.season);
      this.surround?.terrain.setSeason(s.terrain.season, s.terrain.winterSnow);
      this.#updatePhotos(s);
      this.#updateSurround(s);
      this.shadowDirty = true;
    }
    if (has('planet')) {
      const R = planetRadius(s);
      this.curveUniforms.kPlanetR.value = R;
      this.cloudUniforms.cloudPlanetR.value = R;
      this.shadowDirty = true;
    }

    if (has('sun') || has('atmosphere')) {
      const u = this.sky.material.uniforms;
      const a = s.atmosphere;
      u.turbidity.value = a.turbidity;
      u.rayleigh.value = a.rayleigh;
      u.mieCoefficient.value = a.mieCoefficient;
      u.mieDirectionalG.value = a.mieDirectionalG;
      // 雲は厚みのある立体として RealtimeAtmosphere が描くので、Sky の 2D の雲は消しておく（水面の映り込みでだけ使う）
      u.cloudCoverage.value = this.atmosphere.enabled ? 0 : a.clouds;
      u.cloudDensity.value = a.cloudDensity;
      u.cloudScale.value = a.cloudScale;
      u.cloudElevation.value = a.cloudElevation;
      u.time.value = 0;
      this.reflectClouds = a.clouds;
      const dir = new THREE.Vector3(...sunDirection(s.sun.elevation, s.sun.azimuth));
      u.sunPosition.value.copy(dir);
      this.water.material.uniforms.sunDirection.value.copy(dir).normalize();

      // 太陽光の強さ・色は空の物理モデルから（空の明るさとの釣り合いが静止画と同じになる）
      const { color, strength } = sunLight(s.sun, a);
      this.sun.color.setRGB(...color);
      this.sun.intensity = strength;
      // 照り返しは強すぎると遠くの波が粒状にちらつくので控えめに
      this.water.material.uniforms.sunColor.value.setRGB(...color).multiplyScalar(Math.min(1, strength / 25) * 0.35);
      // 水面の明るさを景色の尺度へ（昼は露出の逆数ほど、夜は暗く）
      this.water.material.uniforms.kWaterGain.value = (0.75 / Math.max(0.02, a.exposure)) * Math.max(0.03, Math.min(1, strength / 25));

      this.nightLight.intensity = nightFactor(s.sun.elevation) * Math.PI * 0.15;
      this.precip.set(a.precip);
      this.gpuTerrain.uniforms.tWet.value = a.precip === 'rain' ? 1 : 0;
      if (this.surround) this.surround.terrain.uniforms.tWet.value = a.precip === 'rain' ? 1 : 0;
      this.precipLight = 1 - nightFactor(s.sun.elevation) * 0.8;
      this.#applyLights();
      this.atmosphere.uniforms.nightSky.value.set(...NIGHT_SKY).multiplyScalar(nightFactor(s.sun.elevation));
      this.renderer.toneMappingExposure = a.exposure;
      this.scene.environmentIntensity = a.ambient;
      const hz = hazeColor(s.sun, a);
      this.scene.fog.color.setRGB(...hz);
      // 霧は RealtimeAtmosphere が立体的に計算する（使えないときだけ従来の霧）
      this.scene.fog.density = this.atmosphere.enabled ? 0 : a.haze * 2.2e-4;
      this.envDirty = true;
      this.shadowDirty = true;
    }
    if (has('sun') || has('atmosphere') || has('water') || has('terrain')) {
      const atm = atmosphereParams(s);
      this.atmosphere.setParams(atm);
      const cu = this.cloudUniforms;
      cu.cloudSunDir.value.set(...atm.sunDir).normalize();
      cu.cloudScale.value = atm.clouds.scale;
      cu.cloudCoverage.value = atm.clouds.coverage;
      cu.cloudDensity.value = atm.clouds.density;
      cu.cloudElevation.value = atm.clouds.elevation;
      cu.cloudBase.value = atm.clouds.base;
      cu.cloudThick.value = atm.clouds.thickness;
    }

    if (has('water')) {
      const w = s.water;
      this.water.visible = w.enabled;
      const u = this.water.material.uniforms;
      u.waterColor.value.set(w.color);
      u.distortionScale.value = w.distortion;
      u.size.value = w.waveScale;
      u.kWaterLevel.value = w.level;
    }

    if (has('objects')) {
      this.objects.sync(s.objects);
      this.#attachGizmo();
      this.shadowDirty = true;
    }

    if (has('camera') && meta.source !== 'view') {
      const c = s.camera;
      this.camera.position.fromArray(c.position);
      this.controls.target.fromArray(c.target);
      this.camera.fov = c.fov;
      this.camera.updateProjectionMatrix();
      this.controls.update();
    }
  }

  #onTerrain({ field, res, wear, fieldChanged, colors, texSize }) {
    const s = this.store.get();
    if (colors) {
      this.colorTexture = createColorTexture(colors, texSize, this.colorTexture);
      this.colorKey = this.pendingColorKey;
    }
    if (fieldChanged || !this.terrainData) {
      this.terrainData = { field, res };
      this.gpuTerrain.setField(field, res, wear);
      if (!colors) this.colorKey = null;
      // 周りの地形を範囲の高さ場に合わせ直す（以前の取り込みの標高の幅を求めるにも高さ場が要る）
      this.#updateSurround(s);
    }
    // 計算中に起伏や大きさが変わっていても、最新のシーンで合わせる
    this.gpuTerrain.setScene(s);
    if (!this.terrain) {
      this.terrain = this.gpuTerrain.mesh;
      this.world.add(this.terrain);
    }
    this.shadowDirty = true;
    this.onStatus(null);
  }

  // その地点を受け持つ地形（取り込んだ範囲の外なら周りの地形）
  #terrainAt(x, z) {
    const half = this.store.get().terrain.size / 2;
    if (this.surround?.ready && (Math.abs(x) > half || Math.abs(z) > half)) return this.surround.terrain;
    return this.gpuTerrain;
  }

  // 地球から取り込んだ地形の「周りの地形」（範囲の外も実際の地形が続いて見えるように、粗い高さ場で外側を描く）
  // 地表の衛星写真（範囲と周りの地形）。シーンの「写真の色を使う」が切られていれば外す
  async #updatePhotos(s) {
    const t = s.terrain;
    const hm = t.mode === 'heightmap' ? t.heightmap : null;
    const use = t.photo !== false;
    const inner = use ? hm?.photo ?? null : null;
    const outer = use ? hm?.surround?.photo ?? null : null;
    const waterUrl = hm?.water ?? null;
    const lightsUrl = hm?.lights ?? null;
    const outerLightsUrl = hm?.surround?.lights ?? null;
    const load = async (url, slot) => {
      if (this.photoUrls?.[slot] === url) return;
      this.photoUrls = { ...this.photoUrls, [slot]: url };
      this.photoTex?.[slot]?.dispose();
      let tex = null;
      if (url) {
        try {
          const bmp = await createImageBitmap(await (await fetch(url)).blob(), { imageOrientation: 'none' });
          if (this.photoUrls[slot] !== url) return bmp.close?.();
          tex = new THREE.Texture(bmp);
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.flipY = false; // 行 0 = 北（高さ場と同じ向き）
          tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
          tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
          tex.needsUpdate = true;
        } catch (err) {
          console.warn('衛星写真を読めませんでした', err);
        }
      }
      this.photoTex = { ...this.photoTex, [slot]: tex };
      if (slot === 'lights' || slot === 'outerLights') return this.#applyLights();
      if (slot === 'water') {
        // 印は色ではないので線形のまま
        if (tex) (tex.colorSpace = THREE.NoColorSpace), (tex.needsUpdate = true);
        return this.gpuTerrain.setWaterMask(tex);
      }
      if (slot === 'inner') {
        this.gpuTerrain.setPhoto(tex);
        // 木の配置用に、縮めた画素も持つ
        let px = null;
        if (url) px = await decodePhoto(url, 2048).catch(() => null);
        if (this.photoUrls.inner === url) this.trees.setPhoto(px);
      }
      else this.surround?.terrain.setPhoto(tex);
    };
    await Promise.all([load(inner, 'inner'), load(outer, 'outer'), load(waterUrl, 'water'), load(lightsUrl, 'lights'), load(outerLightsUrl, 'outerLights')]);
  }

  // 夜の街の明かりの強さ：太陽が沈むほど強く（露出の逆数で、景色の明るさの尺度へ）
  #applyLights() {
    const s = this.store.get();
    const k = nightFactor(s.sun.elevation) * (0.35 / Math.max(0.02, s.atmosphere.exposure));
    this.lightsBase = k;
    this.gpuTerrain.setLights(this.photoTex?.lights ?? null, k);
    this.buildings?.setNight(nightFactor(s.sun.elevation) * (0.5 / Math.max(0.02, s.atmosphere.exposure)));
    this.surround?.terrain.setLights(this.photoTex?.outerLights ?? null, k);
  }

  async #updateSurround(s) {
    const t = s.terrain;
    const sur = t.mode === 'heightmap' ? t.heightmap?.surround : null;
    const key = sur ? `${t.heightmap.id}` : null;
    if (!sur) {
      if (this.surround) this.surround.terrain.mesh.visible = false;
      this.surroundKey = null;
      return;
    }
    if (key !== this.surroundKey) {
      this.surroundKey = key;
      const img = await decodePng(await (await fetch(sur.png)).arrayBuffer());
      if (this.surroundKey !== key || !img) return;
      if (!this.surround) {
        const terrain = new GpuTerrain({ curveUniforms: this.curveUniforms, patchMaterial: (m) => patchStandardMaterial(m, this.shared) });
        terrain.mesh.castShadow = false;
        terrain.mesh.name = 'Surround';
        this.world.add(terrain.mesh);
        this.surround = { terrain };
        terrain.setPhoto(this.photoTex?.outer ?? null);
        terrain.setSeason(this.store.get().terrain.season, this.store.get().terrain.winterSnow);
      }
      // 標高 (m) で持ち、本来の地形と同じ「基準の標高・起伏の高さ」で 0..1 に直して使う（色の規則が内外でそろう）
      const m = new Float32Array(img.data.length);
      for (let k = 0; k < m.length; k++) m[k] = sur.min + img.data[k] * (sur.max - sur.min);
      Object.assign(this.surround, { meters: m, res: img.width, size: sur.size, base: null, ready: false });
    }
    const S = this.surround;
    if (!S?.meters) return;
    const cur = this.store.get().terrain;
    // 周りの地形も、範囲の地形と同じ変換で 0..1 に直す：取り込んだときの標高の幅（geo.min / max）が分かれば、
    // 「基準の標高」「起伏の高さ」を変えたとき、範囲と周りがいっしょに動く（範囲だけ浮いたり沈んだりしない）
    let g = cur.heightmap?.geo;
    // 以前に取り込んだ地形には幅が残っていないので、範囲の縁（周りの地形と同じ高さに寄せてある）から求めて、シーンに書き足す
    if (g && !Number.isFinite(g.min) && this.terrainData && !this.terrainService.busy && this.terrainData.res === cur.resolution) {
      const est = estimateGeoRange(this.terrainData.field, this.terrainData.res, cur.size, S.meters, S.res, S.size);
      if (est) {
        g = { ...g, ...est };
        this.store.patch({ 'terrain.heightmap': { ...cur.heightmap, geo: g } }, { source: 'io', history: false });
        return;
      }
    }
    const g0 = Number.isFinite(g?.min) ? g.min : cur.baseHeight;
    const g1 = Number.isFinite(g?.max) ? g.max : cur.baseHeight + cur.heightScale;
    if (S.base !== g0 || S.scale !== g1) {
      const f = new Float32Array(S.meters.length);
      const sc = Math.max(1, g1 - g0);
      for (let k = 0; k < f.length; k++) f[k] = (S.meters[k] - g0) / sc;
      S.terrain.setField(f, S.res, null);
      S.base = g0;
      S.scale = g1;
    }
    S.terrain.setScene(this.store.get(), { size: S.size, clipHalf: cur.size / 2 });
    S.terrain.mesh.visible = true;
    S.ready = true;
  }

  // 太陽の影（平行光源）はカメラの見ている辺りだけを細かく。毎フレーム、注視点について動かす
  #placeSun(s) {
    const dir = new THREE.Vector3(...sunDirection(s.sun.elevation, s.sun.azimuth));
    const t = s.terrain;
    const target = this.controls.target;
    const view = this.camera.position.distanceTo(target);
    const half = THREE.MathUtils.clamp(view * 1.3, 150, Math.max(1500, t.size * 0.75));
    const cam = this.sun.shadow.camera;
    const reach = half * 2 + t.heightScale + Math.abs(t.baseHeight);
    if (Math.abs(cam.right - half) > half * 0.02 || Math.abs(cam.far - reach * 2) > reach * 0.02) {
      cam.left = -half;
      cam.right = half;
      cam.top = half;
      cam.bottom = -half;
      cam.near = 1;
      cam.far = reach * 2;
      cam.updateProjectionMatrix();
      this.sun.shadow.normalBias = ((half * 2) / 2048) * 1.5;
    }
    // 影の地図の格子に合わせて動かす（動かしたときに影の縁がちらつかない）
    const step = (half * 2) / 2048;
    const cx = Math.round(target.x / step) * step, cz = Math.round(target.z / step) * step;
    this.sun.target.position.set(cx, target.y, cz);
    this.sun.position.set(cx, target.y, cz).addScaledVector(dir, reach);
  }

  #commitCamera() {
    this.store.patch(
      {
        'camera.position': this.camera.position.toArray().map(round1),
        'camera.target': this.controls.target.toArray().map(round1),
      },
      { source: 'view' },
    );
  }

  #updateEnvironment() {
    // 空を事前フィルタした環境マップにして、地形の環境光に使う
    // 太陽円盤は平行光源で別に照らすので、環境光からは外す（二重に明るくならないように）
    this.envTarget?.dispose();
    const disc = this.sky.material.uniforms.showSunDisc;
    disc.value = 0;
    this.sky.position.set(0, 0, 0);
    this.envScene.add(this.sky);
    this.envTarget = this.pmrem.fromScene(this.envScene);
    this.scene.add(this.sky);
    disc.value = 1;
    this.scene.environment = this.envTarget.texture;
    this.envDirty = false;
  }

  #resize() {
    const el = this.renderer.domElement.parentElement;
    const w = el.clientWidth, h = el.clientHeight;
    this.renderer.setSize(w, h, false);
    const db = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.atmosphere.setSize(db.x, db.y);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // 一枚絵を描いている間は止めて、GPU をパストレーサに譲る
  set paused(v) {
    this._paused = v;
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

  // 表示中の画面を PNG にする（同じ処理の中で描いてすぐ読み出す）
  // 歩き回るモードの出入り（mode: 'walk' | 'fly' | null）
  get walking() {
    return this.walk.active;
  }

  // (x, z) の地面に立ち、heading（北 = 0、時計回り、度）を向いて歩き始める
  walkAt(x, z, heading = 0) {
    const g = this.gpuTerrain.groundAt(x, z);
    const s = this.store.get();
    const y = Math.max(g, s.water.enabled ? s.water.level : -Infinity) + 1.65;
    const h = THREE.MathUtils.degToRad(heading);
    this.flight = null;
    this.camera.position.set(x, y, z);
    this.controls.target.set(x + Math.sin(h) * 30, y, z - Math.cos(h) * 30);
    this.camera.lookAt(this.controls.target);
    this.setWalk('walk');
  }

  setWalk(mode) {
    if (mode) {
      this.flight = null;
      this.gizmo.detach();
      this.controls.enabled = false;
      this.walk.enter(mode);
      this.audio.start();
    } else if (this.walk.active) {
      this.walk.exit();
      this.audio.stop();
      // 戻るときは、見ていた方向の少し先を中心に回れるようにする
      const fwd = this.walk.forward();
      const s = this.store.get();
      const above = Math.max(5, this.camera.position.y - this.gpuTerrain.groundAt(this.camera.position.x, this.camera.position.z));
      this.controls.target.copy(this.camera.position).addScaledVector(fwd, Math.min(s.terrain.size * 0.3, Math.max(30, above * 3)));
      this.controls.enabled = true;
      this.controls.update();
      this.#commitCamera();
      this.#attachGizmo();
    }
  }

  // 歩いている間の音：高さ・速さ・海の近さ・昼夜から
  #walkSound(dt, p, above) {
    const s = this.store.get();
    const last = this.lastWalkPos ?? p.clone();
    const speed = dt > 0 ? last.distanceTo(p) / dt : 0;
    this.lastWalkPos = p.clone();
    let nearSea = 0;
    if (s.water.enabled && p.y - s.water.level < 60) {
      // 周り 8 方向（80 m 先）のうち、水面より低い所の割合
      let n = 0;
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        if (this.gpuTerrain.heightAt(p.x + Math.cos(a) * 80, p.z + Math.sin(a) * 80) < s.water.level) n++;
      }
      nearSea = Math.min(1, n / 3) * Math.max(0, 1 - (p.y - s.water.level) / 60);
    }
    const day = Math.min(1, Math.max(0, s.sun.elevation / 8));
    // 足音：歩く（飛ばない）とき、地面を進んだ距離が歩幅を超えるごと。走ると歩幅を広く
    const w = this.walk;
    if (w.mode === 'walk') {
      const ground = this.gpuTerrain.groundAt(p.x, p.z);
      const wading = s.water.enabled && ground < s.water.level; // 浅瀬（深い所では水面の上を歩く）
      const snowy = s.atmosphere.precip === 'snow' || (s.terrain.season === 'winter' && ground > (s.terrain.winterSnow ?? 600));
      const surface = wading ? 'water' : snowy ? 'snow' : 'ground';
      if (w.grounded && !this.wasGrounded) {
        this.audio.step(surface, 2); // 着地
        this.stepDist = 0;
      } else if (w.grounded) {
        const horiz = Math.hypot(p.x - last.x, p.z - last.z);
        this.stepDist = (this.stepDist ?? 0) + Math.min(horiz, 5);
        const stride = horiz / Math.max(dt, 1e-3) > 3 ? 1.6 : 0.75;
        if (this.stepDist >= stride) {
          this.stepDist = 0;
          this.audio.step(surface, 1);
        }
      }
      this.wasGrounded = w.grounded;
    } else {
      this.wasGrounded = false;
    }
    this.audio.update(dt, { above, speed: Math.min(speed, 2000), nearSea, day, inForest: (s.vegetation?.trees ?? 0) > 0.3, rain: s.atmosphere.precip === 'rain' });
  }

  capture() {
    if (!this.walk.active) this.controls.update();
    this.#draw();
    return new Promise((r) => this.renderer.domElement.toBlob(r, 'image/png'));
  }

  // 原点を注視点の近くへずらし、星の丸みに合わせてカメラを置き直して描く。終わったら戻す
  #draw() {
    const s = this.store.get();
    const cam = this.camera;
    const target = this.controls.target.clone();
    const ox = Math.round(target.x / ORIGIN_STEP) * ORIGIN_STEP;
    const oz = Math.round(target.z / ORIGIN_STEP) * ORIGIN_STEP;
    if (ox !== this.origin.x || oz !== this.origin.y) {
      this.origin.set(ox, oz);
      this.shadowDirty = true;
    }
    // 世界座標のうちに：水面をカメラの真下へ、太陽の影をカメラの見ている辺りへ
    this.water.position.set(cam.position.x, s.water.level, cam.position.z);
    this.#placeSun(s);
    if (this.terrain) this.trees.update(s, cam.position, this.treeTerrain, this.controls.target.clone().sub(cam.position));
    if (this.terrain) this.buildings.update(s, cam.position, (x, z) => this.gpuTerrain.groundAt(x, z));
    // 夜の街の明かり（衛星から見た街のにじみ）は、地面に近いほど弱く（足元が一面に光らないように。近くは建物の窓が灯る）
    if (this.lightsBase > 0 && this.terrain) {
      const above = cam.position.y - this.gpuTerrain.groundAt(cam.position.x, cam.position.z);
      const f = THREE.MathUtils.clamp((above - 150) / 2500, 0.08, 1);
      this.gpuTerrain.uniforms.tLightsI.value = this.gpuTerrain.uniforms.tLights.value ? this.lightsBase * f : 0;
    }
    const shift = new THREE.Vector3(ox, 0, oz);
    const flatPos = cam.position.clone();
    const flatQuat = cam.quaternion.clone();

    this.world.position.set(-ox, 0, -oz);
    const tgt = target.clone().sub(shift);
    const flat = flatPos.clone().sub(shift);
    const R = this.curveUniforms.kPlanetR.value;
    this.curveUniforms.kCamPos.value.copy(flat);
    this.curveUniforms.kCenter.value.set(tgt.x, tgt.z);
    // 丸みは注視点を中心に曲げる。カメラも同じ式で曲げた位置から注視点を見る
    const c = curvePoint(flat.x, flat.y, flat.z, tgt.x, tgt.z, R);
    cam.position.set(c[0], c[1], c[2]);
    if (R > 0) cam.lookAt(tgt);
    cam.updateMatrixWorld();
    this.sky.position.copy(cam.position);
    this.precip.update(cam.position, flatPos, this.precipLight ?? 1);
    this.cloudUniforms.cloudOrigin.value.copy(this.origin);
    this.cloudUniforms.cloudCam.value.set(tgt.x, 0, tgt.z);
    this.atmosphere.setView(this.origin, R, this.curveUniforms.kCenter.value);
    // 高く昇るほど「宇宙から眺める」表現へ（地表から 15 km〜120 km で切り替える）
    this.atmosphere.uniforms.spaceW.value = R > 0 ? THREE.MathUtils.smoothstep(flatPos.y, 15000, 120000) : 0;
    this.atmosphere.uniforms.starI.value = 8 / Math.max(0.02, s.atmosphere.exposure / 0.12);
    this.scene.updateMatrixWorld();
    // 地名を画面の位置へ（曲げた地形と同じ式で、平らな地図の点を画面へ）
    if (this.labels) {
      const t = s.terrain;
      const v = new THREE.Vector3();
      const W = this.renderer.domElement.clientWidth, Hh = this.renderer.domElement.clientHeight;
      const project = (x, y, z) => {
        const q = curvePoint(x - ox, y, z - oz, tgt.x, tgt.z, R);
        v.set(q[0], q[1], q[2]);
        const dist = v.distanceTo(cam.position);
        v.project(cam);
        return { x: (v.x * 0.5 + 0.5) * W, y: (0.5 - v.y * 0.5) * Hh, front: v.z < 1 && v.z > -1, dist };
      };
      const hm = t.mode === 'heightmap' ? t.heightmap : null;
      this.labels.set(hm?.labels ?? null);
      // 手前の山に隠れていないか：カメラから地名までの間の地面を 16 か所見る（丸みの沈みも足す）
      const blocked = (x, y, z) => {
        const dx = x - flatPos.x, dz = z - flatPos.z, len = Math.hypot(dx, dz);
        for (let k = 1; k < 16; k++) {
          const f = k / 16;
          const sag = R > 0 ? (f * (1 - f) * len * len) / (2 * R) : 0;
          if (this.gpuTerrain.heightAt(flatPos.x + dx * f, flatPos.z + dz * f) > flatPos.y + (y - flatPos.y) * f + sag) return true;
        }
        return false;
      };
      this.labels.update(project, (x, z) => this.gpuTerrain.groundAt(x, z), t.labels !== false && !!this.terrain, blocked);
    }
    this.gpuTerrain.update(cam, this.origin);
    if (this.surround?.ready && this.surround.terrain.mesh.visible) this.surround.terrain.update(cam, this.origin);

    if (this.atmosphere.enabled) {
      // 霧の光の筋のための影の地図：カメラの周りだけ。物を動かしている最中は作り直さない
      const view = cam.position.distanceTo(target.clone().sub(shift));
      // 光の筋は近くの現象なので、範囲は 200 km まで（広げすぎると細かさが足りない）
      const radius = THREE.MathUtils.clamp(view * 3, 3000, THREE.MathUtils.clamp(s.terrain.size * 0.75, 3000, 200000));
      const f = this.shadowFor;
      const moved = f && (f.center.distanceTo(target) > f.radius * 0.25 || Math.abs(Math.log(radius / f.radius)) > 0.4);
      if ((this.shadowDirty || moved) && !this.gizmo.dragging && this.terrain) {
        const casters = [this.terrain, ...this.objects.meshes.filter((m) => !m.userData.celestial)];
        this.atmosphere.updateShadow(casters, this.cloudUniforms.cloudSunDir.value.toArray(), { center: target.clone().sub(shift), radius });
        this.shadowFor = { center: target, radius };
        this.shadowDirty = false;
      }
      this.atmosphere.render(this.scene, cam);
    } else {
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.scene, cam);
    }

    cam.position.copy(flatPos);
    cam.quaternion.copy(flatQuat);
    cam.updateMatrixWorld();
    this.world.position.set(0, 0, 0);
    this.world.updateMatrixWorld(true);
  }

  // 1 コマ進める（画面が隠れて描画の合図が来ないときの確認・テスト用）
  step() {
    this.#frame();
  }

  #frame() {
    if (this._paused) return;
    this.timer.update();
    const dt = this.timer.getDelta();
    this.#adaptQuality(dt);
    if (this.envDirty) this.#updateEnvironment();
    this.water.material.uniforms.time.value += dt * 0.6;
    if (this.walk.active) {
      this.walk.update(dt);
      // 丸みの中心と影の範囲は、見ている方向の少し先
      const p = this.camera.position;
      const above = Math.max(2, p.y - this.gpuTerrain.groundAt(p.x, p.z));
      this.controls.target.copy(p).addScaledVector(this.walk.forward(), Math.max(20, above * 2));
      this.#walkSound(dt, p, above);
    } else {
      this.#updateFlight();
      this.controls.update();
    }
    this.#draw();
  }
}

// 地表の色のテクスチャ（書き出し用）が今のシーンのものか
function colorKeyOf(s) {
  const t = s.terrain;
  return JSON.stringify([fieldKeyOf(t), t.size, t.heightScale, t.baseHeight, t.palette, s.water.level, s.water.enabled, s.vegetation]);
}

const round1 = (v) => Math.round(v * 10) / 10;

// 範囲の高さ場（0..1）と周りの地形（m）から、取り込んだときの標高の幅を求める。
// 範囲の縁は取り込むときに周りの地形の高さへ寄せてあるので、縁では m = min + f (max − min) が成り立つ（最小二乗）
function estimateGeoRange(field, res, size, meters, mres, msize) {
  const at = (a, r, u, v) => {
    const x = Math.min(r - 1, Math.max(0, u * (r - 1))), y = Math.min(r - 1, Math.max(0, v * (r - 1)));
    const i = Math.min(r - 2, Math.floor(x)), j = Math.min(r - 2, Math.floor(y)), fx = x - i, fy = y - j;
    return (a[j * r + i] * (1 - fx) + a[j * r + i + 1] * fx) * (1 - fy) + (a[(j + 1) * r + i] * (1 - fx) + a[(j + 1) * r + i + 1] * fx) * fy;
  };
  let n = 0, sf = 0, sm = 0, sff = 0, sfm = 0;
  const e = 0.001; // 縁のほんの少し内側
  for (let k = 0; k <= 400; k++) {
    const t = k / 400;
    for (const [u, v] of [[t, e], [t, 1 - e], [e, t], [1 - e, t]]) {
      const f = at(field, res, u, v);
      const x = (u - 0.5) * size, z = (v - 0.5) * size;
      const m = at(meters, mres, x / msize + 0.5, z / msize + 0.5);
      n++, (sf += f), (sm += m), (sff += f * f), (sfm += f * m);
    }
  }
  const den = n * sff - sf * sf;
  if (!(den > 1e-9 * n * n)) return null;
  const span = (n * sfm - sf * sm) / den;
  if (!(span > 1)) return null;
  const min = (sm - span * sf) / n;
  return { min, max: min + span };
}
