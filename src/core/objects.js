import { t } from '../i18n/index.js';

// シーンに置く物体（球・立方体など）のデータ定義。Three.js 非依存。
// 物体は scene.objects 配列に入り、描画器はこれを読んで形と素材を作る。

export const SHAPES = [
  { type: 'sphere', label: '球', aspect: 2 },
  { type: 'box', label: '立方体', aspect: 1 },
  { type: 'cylinder', label: '円柱', aspect: 2 },
  { type: 'cone', label: '円錐', aspect: 2 },
  { type: 'pyramid', label: '角錐', aspect: 1 },
  { type: 'torus', label: 'トーラス', aspect: 2 },
  { type: 'ring', label: '環', aspect: 1 },
];

export const shapeOf = (type) => SHAPES.find((s) => s.type === type) ?? SHAPES[0];

// 素材の既定値。模様は core/texgen.js の PATTERNS
export function defaultMaterial() {
  return {
    preset: 'stone',
    pattern: 'rock',
    color: '#8a8278',
    color2: '#5a524a',
    glowColor: '#ff7a2a',
    scale: 4, // 模様の細かさ（一周あたりの繰り返し）
    seed: 1,
    bump: 0.5, // 凹凸
    roughness: 0.85,
    metalness: 0,
    glow: 0, // 発光の強さ
    transmission: 0, // 透け（ガラス・水晶）
    image: null, // 画像模様の dataURL
  };
}

// 素材見本（Bryce のマテリアルライブラリに相当する、すぐ使える組み合わせ）
export const MATERIAL_PRESETS = [
  { id: 'stone', name: '石', m: { pattern: 'rock', color: '#8a8278', color2: '#5a524a', scale: 4, bump: 0.5, roughness: 0.85 } },
  { id: 'mossy', name: '苔むした岩', m: { pattern: 'rock', color: '#3f5a2a', color2: '#6b6458', scale: 3, bump: 0.6, roughness: 0.9 } },
  { id: 'marble', name: '大理石', m: { pattern: 'marble', color: '#efece6', color2: '#6f6a66', scale: 2, bump: 0.05, roughness: 0.25 } },
  { id: 'lava-world', name: '溶岩の星', m: { pattern: 'lava', color: '#1d0f0a', color2: '#ff5a1a', glowColor: '#ff6a20', scale: 5, bump: 0.6, roughness: 0.8, glow: 3 } },
  { id: 'blue-planet', name: '青い惑星', m: { pattern: 'planet', color: '#2f5f8f', color2: '#5e7b3c', scale: 2, bump: 0.3, roughness: 0.6 } },
  { id: 'gas-giant', name: 'ガス惑星', m: { pattern: 'gas', color: '#d8b48a', color2: '#8a5a3a', scale: 2, bump: 0, roughness: 0.9 } },
  { id: 'moon', name: '月', m: { pattern: 'craters', color: '#4a4846', color2: '#b8b4ae', scale: 2, bump: 0.8, roughness: 0.95 } },
  { id: 'ice', name: '氷', m: { pattern: 'cells', color: '#cfe8f5', color2: '#7fb0d0', scale: 4, bump: 0.3, roughness: 0.15, transmission: 0.6 } },
  { id: 'gold', name: '黄金', m: { pattern: 'solid', color: '#e2b84a', color2: '#e2b84a', bump: 0, roughness: 0.25, metalness: 1 } },
  { id: 'chrome', name: '鏡面', m: { pattern: 'solid', color: '#f0f0f0', color2: '#f0f0f0', bump: 0, roughness: 0.02, metalness: 1 } },
  { id: 'glass', name: 'ガラス', m: { pattern: 'solid', color: '#ffffff', color2: '#ffffff', bump: 0, roughness: 0.02, metalness: 0, transmission: 1 } },
  { id: 'star', name: '恒星', m: { pattern: 'cells', color: '#ffd27a', color2: '#ff8a2a', scale: 6, bump: 0, roughness: 1, glow: 4 } },
  { id: 'checker', name: '市松', m: { pattern: 'checker', color: '#e8e2d4', color2: '#2a2622', scale: 4, bump: 0, roughness: 0.4 } },
  { id: 'rings', name: '惑星の環', m: { pattern: 'rings', color: '#3a2e26', color2: '#e8d2b0', scale: 1, bump: 0, roughness: 0.9 } },
  { id: 'stripes', name: '縞瑪瑙', m: { pattern: 'stripes', color: '#c27a4a', color2: '#f2dcc0', scale: 5, bump: 0.15, roughness: 0.35 } },
];

let counter = 0;
export function newId() {
  counter = (counter + 1) % 1e6;
  return `o${Date.now().toString(36)}${counter.toString(36)}`;
}

export function applyMaterialPreset(material, presetId) {
  const p = MATERIAL_PRESETS.find((x) => x.id === presetId);
  if (!p) return material;
  return { ...defaultMaterial(), seed: material.seed, ...p.m, preset: p.id };
}

// 新しい物体。size は代表寸法 (m)
export function createObject(type, { position = [0, 0, 0], size = 300, material = 'stone', name } = {}) {
  const shape = shapeOf(type);
  return {
    id: newId(),
    name: name ?? t(shape.label),
    type: shape.type,
    position,
    rotation: [0, 0, 0], // 度（XYZ）
    scale: [size, size, size],
    celestial: false, // true: 遠景のかすみを受けない（空に浮かぶ天体向け）
    castShadow: true,
    reflect: true, // 水面に映す（false で映り込みから外す）
    material: applyMaterialPreset({ ...defaultMaterial(), seed: Math.floor(Math.random() * 1e5) }, material),
  };
}

// 読み込んだ物体データを既定値で補う
export function normalizeObject(o) {
  const shape = shapeOf(o?.type);
  return {
    id: o?.id ?? newId(),
    name: o?.name ?? shape.label,
    type: shape.type,
    position: vec3(o?.position, 0),
    rotation: vec3(o?.rotation, 0),
    scale: vec3(o?.scale, 100),
    celestial: !!o?.celestial,
    castShadow: o?.castShadow ?? true,
    reflect: o?.reflect ?? true,
    material: { ...defaultMaterial(), ...(o?.material ?? {}) },
  };
}

const vec3 = (v, d) => (Array.isArray(v) && v.length === 3 ? v.map((x) => (Number.isFinite(+x) ? +x : d)) : [d, d, d]);

// 素材のうち、テクスチャの絵に関わる部分だけ（同じなら同じテクスチャを使い回す）
export function textureKey(material, aspect) {
  const { pattern, color, color2, glowColor, scale, seed, bump, image } = material;
  const img = image ? `${image.length}:${image.slice(-32)}` : '';
  return JSON.stringify([pattern, color, color2, glowColor, scale, seed, bump, img, aspect]);
}
