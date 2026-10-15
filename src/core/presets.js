// 星のひな形。既定シーンへの差分として持つ（足りない項目は既定値で埋まる）
export const PRESETS = [
  {
    id: 'azure',
    name: '碧の星 — 午後の大陸',
    scene: {
      meta: { name: '碧の星' },
      terrain: { heightScale: 1400, baseHeight: -250, noise: { seed: 1207 } },
      sun: { elevation: 32, azimuth: 160 },
      atmosphere: { turbidity: 4, rayleigh: 1.8, haze: 0.3, exposure: 0.112 },
      water: { level: 0, color: '#0f3a4a' },
    },
  },
  {
    id: 'dusk-archipelago',
    name: '黄昏の群島',
    scene: {
      meta: { name: '黄昏の群島' },
      terrain: {
        heightScale: 900,
        baseHeight: -380,
        noise: { seed: 4441, frequency: 3.4, ridged: 0.3, warp: 0.6, valley: 2.2, falloff: 0.5 },
        palette: { shore: '#d6c194', low: '#3f6a34', high: '#5d6b3a' },
      },
      sun: { elevation: 3.5, azimuth: 38 },
      atmosphere: { turbidity: 9, rayleigh: 2.6, mieCoefficient: 0.009, haze: 0.45, exposure: 0.137 },
      water: { level: 0, color: '#123a4e', distortion: 2.5 },
      camera: { position: [-4300, 650, 4100], target: [300, 40, -200], fov: 45 },
    },
  },
  {
    id: 'rust-waste',
    name: '赤錆の荒野',
    scene: {
      meta: { name: '赤錆の荒野' },
      terrain: {
        size: 12000,
        heightScale: 2200,
        baseHeight: -100,
        noise: { seed: 913, frequency: 1.6, ridged: 0.85, warp: 0.9, valley: 2.6, falloff: 0 },
        palette: { shore: '#a8673f', low: '#8a4a2b', high: '#b0703f', rock: '#5a3424', snow: '#e8d6c4', snowLine: 0.92, rockSlope: 0.6 },
      },
      sun: { elevation: 18, azimuth: 120 },
      atmosphere: { turbidity: 18, rayleigh: 0.4, mieCoefficient: 0.02, mieDirectionalG: 0.9, haze: 0.6, exposure: 0.105 },
      water: { enabled: false },
      camera: { position: [-5200, 1600, 5600], target: [0, 500, 0], fov: 50 },
    },
  },
  {
    id: 'ice-giants',
    name: '氷の巨峰',
    scene: {
      meta: { name: '氷の巨峰' },
      terrain: {
        size: 16000,
        heightScale: 4200,
        baseHeight: -300,
        noise: { seed: 2718, frequency: 2.0, octaves: 9, persistence: 0.5, ridged: 0.95, warp: 0.3, valley: 1.4, falloff: 0.1 },
        palette: { shore: '#9aa6ad', low: '#6f7f86', high: '#8c979c', rock: '#3e464d', snow: '#f4f8ff', snowLine: 0.32, rockSlope: 0.95 },
      },
      sun: { elevation: 9, azimuth: 115 },
      atmosphere: { turbidity: 2, rayleigh: 3.2, haze: 0.25, exposure: 0.1 },
      water: { level: 0, color: '#0d2c3a' },
      camera: { position: [-6500, 2400, 7600], target: [0, 1200, 0], fov: 45 },
    },
  },
  {
    id: 'otherworld',
    name: '異界の湿原',
    scene: {
      meta: { name: '異界の湿原' },
      terrain: {
        heightScale: 700,
        baseHeight: -60,
        noise: { seed: 6060, frequency: 4.0, octaves: 7, ridged: 0.15, warp: 1.2, valley: 3.0, falloff: 0 },
        palette: { shore: '#8fd6c0', low: '#6a3f86', high: '#a05a9a', rock: '#2f2a44', snow: '#d9fff4', snowLine: 0.8, rockSlope: 0.7 },
      },
      sun: { elevation: 22, azimuth: 80 },
      atmosphere: { turbidity: 1.5, rayleigh: 5.5, mieCoefficient: 0.002, haze: 0.4, exposure: 0.125 },
      water: { level: 0, color: '#08524a', distortion: 1.5 },
      camera: { position: [-2600, 600, 2900], target: [0, 60, 0], fov: 50 },
    },
  },
];
