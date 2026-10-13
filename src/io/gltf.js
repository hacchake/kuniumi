import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { buildPortableScene } from '../three/portableScene.js';
import { normalizeScene } from '../core/schema.js';
import { anglesFromDirection } from '../core/sun.js';
import { fieldToHeightmap } from './heightmap.js';

// glTF (.glb) の書き出し：地形（色テクスチャ付き）・水面・太陽・カメラ + シーン設定を extras に格納
export async function exportGlb(scene, terrainData) {
  const root = buildPortableScene(scene, terrainData);
  // シーン JSON を glTF の scene.extras に入れる（埋め込みハイトマップは重いので除く。高さはメッシュが持つ）
  const settings = structuredClone(scene);
  if (settings.terrain.heightmap) settings.terrain.heightmap = { ...settings.terrain.heightmap, png: null };
  root.userData = { kuniumi: settings };
  const result = await new GLTFExporter().parseAsync(root, { binary: true });
  root.traverse((o) => {
    if (o.isMesh) {
      o.geometry.dispose();
      if (o.material.map !== terrainData.colorTexture) o.material.dispose();
    }
  });
  return new Blob([result], { type: 'model/gltf-binary' });
}

// glTF (.glb / 埋め込み .gltf) の読み込み。
// - KUNIUMI が書いた extras があれば設定を復元
// - 地形は常に「メッシュの形」から取り込む（Blender での編集が反映される）。他ソフトの地形メッシュもこれで入る
// - 太陽（平行光源）とカメラがあればそれも反映
export async function importGlb(buffer, { renderer, current, resolution }) {
  const gltf = await new GLTFLoader().parseAsync(buffer, '');
  const root = gltf.scene;
  root.updateMatrixWorld(true);

  let extras = root.userData?.kuniumi ?? gltf.parser.json.scenes?.[0]?.extras?.kuniumi ?? null;
  if (typeof extras === 'string') {
    try {
      extras = JSON.parse(extras);
    } catch {
      extras = null;
    }
  }
  const next = extras ? normalizeScene(extras) : structuredClone(current);
  if (extras?.terrain?.heightmap && !extras.terrain.heightmap.png) next.terrain.heightmap = null;

  // 地形メッシュを探す。名前に Terrain/地形 があるものを優先、なければ水以外の全メッシュ
  const meshes = [];
  root.traverse((o) => o.isMesh && meshes.push(o));
  const isWater = (o) => /water|水/i.test(o.name) || /water|水/i.test(o.parent?.name ?? '');
  let terrainMeshes = meshes.filter((o) => /terrain|地形/i.test(o.name) || /terrain|地形/i.test(o.parent?.name ?? ''));
  if (!terrainMeshes.length) terrainMeshes = meshes.filter((o) => !isWater(o));
  if (!terrainMeshes.length) throw new Error('地形にできるメッシュが見つかりません');

  const box = new THREE.Box3();
  for (const m of terrainMeshes) box.expandByObject(m);
  const center = box.getCenter(new THREE.Vector3());
  const offset = new THREE.Vector3(center.x, 0, center.z); // 地形の中心を原点へ寄せる
  const size = Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
  const res = extras?.terrain?.resolution ?? resolution;

  const raw = rasterizeHeights(renderer, terrainMeshes, box, size, res);
  let min = Infinity, max = -Infinity;
  for (const v of raw) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = Math.max(max - min, 1e-3);
  const field = new Float32Array(raw.length);
  for (let k = 0; k < raw.length; k++) field[k] = (raw[k] - min) / span;

  next.terrain.size = round(size);
  next.terrain.resolution = res;
  next.terrain.baseHeight = round(min);
  next.terrain.heightScale = round(span);
  next.terrain.mode = 'heightmap';
  next.terrain.heightmap = await fieldToHeightmap(field, res, 'glb から取り込み');

  // 水面
  const waterMesh = meshes.find(isWater);
  if (waterMesh) {
    const wb = new THREE.Box3().setFromObject(waterMesh);
    next.water.enabled = true;
    next.water.level = round(wb.max.y);
  } else if (!extras) {
    next.water.enabled = false;
  }

  // 太陽：光は自身の -Z 方向へ進むので、+Z（getWorldDirection）が太陽のある向き
  let light = null;
  root.traverse((o) => {
    if (!light && o.isDirectionalLight) light = o;
  });
  if (light) {
    const d = light.getWorldDirection(new THREE.Vector3());
    const { elevation, azimuth } = anglesFromDirection(d.toArray());
    next.sun.elevation = round(elevation, 100);
    next.sun.azimuth = round(azimuth, 100);
  }

  // カメラ
  const cam = gltf.cameras?.[0];
  if (cam) {
    const pos = cam.getWorldPosition(new THREE.Vector3()).sub(offset);
    const dir = cam.getWorldDirection(new THREE.Vector3());
    // 注視点までの距離は、KUNIUMI の設定があればそれを使い、なければ原点までの距離
    const ec = extras?.camera;
    const dist = ec ? Math.hypot(...ec.position.map((v, i) => v - ec.target[i])) : Math.max(100, pos.length());
    next.camera.position = pos.toArray().map((v) => round(v));
    next.camera.target = pos.clone().addScaledVector(dir, dist).toArray().map((v) => round(v));
    if (cam.isPerspectiveCamera) next.camera.fov = round(cam.fov, 10);
  }

  const summary = {
    fromKuniumi: !!extras,
    meshes: terrainMeshes.length,
    hasLight: !!light,
    hasCamera: !!cam,
  };
  return { scene: next, summary };
}

// 真上からの正射影で「各格子点の最も高い表面の標高」を描き、読み出す
function rasterizeHeights(renderer, meshes, box, size, res) {
  const rtScene = new THREE.Scene();
  const mat = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      varying float vY;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vY = wp.y;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      varying float vY;
      void main() { gl_FragColor = vec4(vY, 0.0, 0.0, 1.0); }`,
  });
  for (const m of meshes) {
    const clone = new THREE.Mesh(m.geometry, mat);
    clone.matrixAutoUpdate = false;
    clone.matrix.copy(m.matrixWorld);
    clone.matrixWorld.copy(m.matrixWorld);
    rtScene.add(clone);
  }
  // 格子点が画素の中心に来るよう半画素ぶん広げる。外周の点がメッシュの縁ちょうどで取りこぼされないよう、ごくわずかに内側を測る
  const half = (size / 2 - size * 1e-4) * (res / (res - 1));
  const cx = (box.min.x + box.max.x) / 2;
  const cz = (box.min.z + box.max.z) / 2;
  const height = box.max.y - box.min.y;
  const cam = new THREE.OrthographicCamera(-half, half, half, -half, 0.1, height + 200);
  cam.up.set(0, 0, -1); // 画面の上 = 北
  cam.position.set(cx, box.max.y + 100, cz);
  cam.lookAt(cx, box.min.y - 10, cz);
  cam.updateMatrixWorld();

  const target = new THREE.WebGLRenderTarget(res, res, {
    type: THREE.FloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
  });
  const prevTarget = renderer.getRenderTarget();
  const prevColor = renderer.getClearColor(new THREE.Color());
  const prevAlpha = renderer.getClearAlpha();
  renderer.setRenderTarget(target);
  renderer.setClearColor(0x000000, 0);
  renderer.clear();
  renderer.render(rtScene, cam);
  const px = new Float32Array(res * res * 4);
  renderer.readRenderTargetPixels(target, 0, 0, res, res, px);
  renderer.setRenderTarget(prevTarget);
  renderer.setClearColor(prevColor, prevAlpha);
  target.dispose();
  mat.dispose();

  // 読み出しは下の行から。下 = 南（j = res-1）。穴は最低点で埋める
  const out = new Float32Array(res * res);
  let lowest = Infinity;
  for (let k = 0; k < res * res; k++) if (px[k * 4 + 3] > 0.5) lowest = Math.min(lowest, px[k * 4]);
  if (!isFinite(lowest)) throw new Error('地形メッシュを真上から捉えられませんでした');
  for (let r = 0; r < res; r++) {
    const j = res - 1 - r;
    for (let i = 0; i < res; i++) {
      const k = (r * res + i) * 4;
      out[j * res + i] = px[k + 3] > 0.5 ? px[k] : lowest;
    }
  }
  return out;
}

const round = (v, f = 1) => Math.round(v * f) / f;
