import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// 自分のモデルで植物を置き換える（UltraScenery の Alienator にあたる）。
// glb を読み、すべての形を 1 つにまとめ、素材の色（模様があればその平均の色）を頂点の色に焼き込む。
// 根元の中心を原点に、高さ 1（岩は最も長い辺 1）に揃えるので、いつもの植物と同じ大きさで置ける。

const cache = new Map(); // glb の dataURL → 揃えた形

export async function loadPlantModel(dataUrl, { unitBy = 'height' } = {}) {
  const key = `${unitBy}:${dataUrl}`;
  if (cache.has(key)) return cache.get(key);
  const buf = await (await fetch(dataUrl)).arrayBuffer();
  const gltf = await new GLTFLoader().parseAsync(buf, '');
  gltf.scene.updateMatrixWorld(true);
  const parts = [];
  gltf.scene.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    let g = o.geometry.clone();
    if (o.isSkinnedMesh) g.deleteAttribute('skinIndex'), g.deleteAttribute('skinWeight');
    g.applyMatrix4(o.matrixWorld);
    g = g.index ? g.toNonIndexed() : g;
    if (!g.attributes.normal) g.computeVertexNormals();
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    // 素材ごとの色（材質グループがあればグループごと）
    const colorOf = (m) => {
      const c = (m?.color ?? new THREE.Color(1, 1, 1)).clone();
      const avg = averageTextureColor(m?.map);
      if (avg) c.multiply(avg);
      return c;
    };
    if (g.groups?.length && mats.length > 1) {
      for (const gr of g.groups) {
        const c = colorOf(mats[gr.materialIndex]);
        for (let i = gr.start; i < Math.min(n, gr.start + gr.count); i++) col.set([c.r, c.g, c.b], i * 3);
      }
    } else {
      const c = colorOf(mats[0]);
      for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
    }
    // 頂点の色がもともとあれば掛け合わせる
    const vc = g.attributes.color;
    if (vc) for (let i = 0; i < n; i++) (col[i * 3] *= vc.getX(i)), (col[i * 3 + 1] *= vc.getY(i)), (col[i * 3 + 2] *= vc.getZ(i));
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', g.attributes.position);
    out.setAttribute('normal', g.attributes.normal);
    out.setAttribute('color', new THREE.BufferAttribute(col, 3));
    parts.push(out);
  });
  if (!parts.length) throw new Error('形の入っていない glb です');
  const geo = mergeGeometries(parts, false);
  geo.computeBoundingBox();
  const b = geo.boundingBox;
  const size = b.getSize(new THREE.Vector3());
  const unit = unitBy === 'max' ? Math.max(size.x, size.y, size.z) : size.y;
  if (!(unit > 0)) throw new Error('大きさの無い形です');
  geo.translate(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2);
  geo.scale(1 / unit, 1 / unit, 1 / unit);
  geo.computeBoundingSphere();
  const r = { geometry: geo, triangles: geo.attributes.position.count / 3 };
  cache.set(key, r);
  return r;
}

// 模様の平均の色（読めなければ null）。模様は sRGB なので線形の色へ直す
function averageTextureColor(tex) {
  const img = tex?.image;
  if (!img || !(img.width > 0)) return null;
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 16;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0, 16, 16);
    const d = g.getImageData(0, 0, 16, 16).data;
    let r = 0, gg = 0, bb = 0, w = 0;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3] / 255; // 透けた所（葉の模様の外）は数えない
      r += d[i] * a;
      gg += d[i + 1] * a;
      bb += d[i + 2] * a;
      w += a;
    }
    if (!(w > 0)) return null;
    return new THREE.Color().setRGB(r / w / 255, gg / w / 255, bb / w / 255, THREE.SRGBColorSpace);
  } catch {
    return null;
  }
}
