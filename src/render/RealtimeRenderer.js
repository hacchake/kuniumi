import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { Water } from 'three/addons/objects/Water.js';
import { touches } from '../core/schema.js';
import { t } from '../i18n/index.js';
import { sunDirection, sunLight, hazeColor } from '../core/sun.js';
import { TerrainService, fieldKeyOf } from '../three/TerrainService.js';
import { createColorTexture } from '../three/terrainMesh.js';
import { GpuTerrain, ORIGIN_STEP } from './GpuTerrain.js';
import { createCurveUniforms, curvePoint } from './curvatureGLSL.js';
import { createWaterDisc, curveWater } from './waterDisc.js';
import { planetRadius } from '../core/schema.js';
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
    this.controls.addEventListener('start', () => (this.flight = null));

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
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.0002;
    this.world.add(this.sun, this.sun.target);

    // 水
    this.water = new Water(createWaterDisc(2e7), {
      textureWidth: 1024,
      textureHeight: 1024,
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

    // 霧・光の筋・厚みのある雲（画面全体で計算して重ねる）
    this.atmosphere = new RealtimeAtmosphere(renderer);
    this.shadowDirty = true;
    this.shadowFor = null; // 霧の影の地図を作ったときのカメラの周り { center, radius }
    this.#setupGizmo(canvas);

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
    return {
      field: this.terrainData.field,
      res: this.terrainData.res,
      colorTexture: this.colorTexture,
      objectMeshes: this.objects.exportMeshes(),
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

  #updateFlight() {
    const f = this.flight;
    if (!f) return;
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
      const savedDet = det.value;
      det.value = 0;
      waterBefore.apply(this.water, args);
      det.value = savedDet;
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
      if (!down || e.button !== 0 || this.gizmo.dragging) return;
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
      this.sun.shadow.normalBias = ((half * 2) / 4096) * 1.5;
    }
    // 影の地図の格子に合わせて動かす（動かしたときに影の縁がちらつかない）
    const step = (half * 2) / 4096;
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
  capture() {
    this.controls.update();
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
    this.cloudUniforms.cloudOrigin.value.copy(this.origin);
    this.cloudUniforms.cloudCam.value.set(tgt.x, 0, tgt.z);
    this.atmosphere.setView(this.origin, R, this.curveUniforms.kCenter.value);
    this.scene.updateMatrixWorld();
    this.gpuTerrain.update(cam, this.origin);

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

  #frame() {
    if (this._paused) return;
    this.timer.update();
    const dt = this.timer.getDelta();
    this.#adaptQuality(dt);
    if (this.envDirty) this.#updateEnvironment();
    this.water.material.uniforms.time.value += dt * 0.6;
    this.#updateFlight();
    this.controls.update();
    this.#draw();
  }
}

// 地表の色のテクスチャ（書き出し用）が今のシーンのものか
function colorKeyOf(s) {
  const t = s.terrain;
  return JSON.stringify([fieldKeyOf(t), t.size, t.heightScale, t.baseHeight, t.palette, s.water.level, s.water.enabled, s.vegetation]);
}

const round1 = (v) => Math.round(v * 10) / 10;
