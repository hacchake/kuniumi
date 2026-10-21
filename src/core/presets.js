import { createObject } from './objects.js';

// 星のひな形。既定シーンへの差分として持つ（足りない項目は既定値で埋まる）。
// 地形・空だけでなく、季節・天気・夜（月・オーロラ・天の川）・霧・星の大きさ・空の天体まで変えて、
// 選ぶたびに違う景色になるようにしている。天体（物体）を含むものは、選ぶたびに作り直すよう scene を getter にする。

// 空に浮かぶ天体（遠景のかすみを受けない）
function celestial(type, position, size, material, name, rotation = [0, 0, 0], scale = null) {
  const o = createObject(type, { position, size, material, name });
  o.celestial = true;
  o.castShadow = false;
  o.rotation = rotation;
  if (scale) o.scale = scale;
  return o;
}

export const PRESETS = [
  {
    id: 'azure',
    name: '碧の星 — 午後の大陸',
    scene: {
      meta: { name: '碧の星' },
      terrain: { heightScale: 1400, baseHeight: -250, noise: { seed: 1207 } },
      sun: { elevation: 32, azimuth: 160 },
      atmosphere: { turbidity: 4, rayleigh: 1.8, haze: 0.3, exposure: 0.112, clouds: 0.35 },
      water: { level: 0, color: '#0f3a4a' },
    },
  },
  {
    id: 'fuji-lake',
    name: '富士の見える湖',
    scene: {
      meta: { name: '富士の見える湖' },
      terrain: {
        size: 24000,
        heightScale: 700,
        baseHeight: -90,
        // 丸みのある低い山並みに、手彫りの「富士山形の山」を 1 つ（半径 9 km・高さ 3.4 km）
        noise: { seed: 2236, frequency: 2.4, ridged: 0.2, warp: 0.6, valley: 1.8, falloff: 0, erosion: 0.6, round: 0.8 },
        // 手前は湖（手彫りで掘る）
        sculpt: [{ x: 0, z: -4000, r: 9000, cone: 3400 }, { x: 1000, z: 8600, r: 3000, h: -380 }, { x: -1500, z: 9400, r: 2200, h: -300 }],
        // 雪は上の 3 分の 1 ほど（雪線は「水面〜起伏の高さ」に対する割合なので、富士の高さに合わせて大きく）
        // 富士の中腹は森の群落のすき間も暗い低木の色に（「高地」の色が山のほぼ全体に出るので、明るい色だと森のすき間が黄土色の斑に見える）
        palette: { snowLine: 4.1, high: '#37402d', rock: '#3e3a36' },
      },
      vegetation: { trees: 0.8, conifer: 0.5 },
      sun: { elevation: 24, azimuth: 135 },
      atmosphere: { turbidity: 3, rayleigh: 2.4, haze: 0.3, clouds: 0.25, cloudAltitude: 2400, rays: 0.6, exposure: 0.11 },
      water: { level: 0, color: '#123c4c', distortion: 1.2 },
      camera: { position: [800, 90, 11200], target: [0, 1500, -4000], fov: 45 },
    },
  },
  {
    id: 'misty-valley',
    name: '霧の朝の渓谷',
    scene: {
      meta: { name: '霧の朝の渓谷' },
      terrain: {
        heightScale: 1700,
        baseHeight: -150,
        season: 'spring',
        noise: { seed: 3310, frequency: 2.6, ridged: 0.65, warp: 0.5, valley: 2.3, falloff: 0.15, erosion: 0.8, round: 0.5 },
      },
      vegetation: { trees: 0.95, conifer: 0.7, treeHeight: 20 },
      sun: { elevation: 11, azimuth: 95 },
      // 谷霧：濃い霧を低く（250 m で薄まる）たまらせ、峰だけが霧の海から突き出る（霧を山の高さまで厚くすると、全体が一様にかすむだけ）
      atmosphere: { turbidity: 5, rayleigh: 2.4, mieCoefficient: 0.012, haze: 4, fogHeight: 250, rays: 0.85, clouds: 0.2, exposure: 0.13 },
      water: { level: 0, color: '#1c3a3e' },
      camera: { position: [-4800, 1500, 5200], target: [200, 300, -200], fov: 45 },
    },
  },
  {
    id: 'autumn-village',
    name: '紅葉の山里',
    scene: {
      meta: { name: '紅葉の山里' },
      terrain: {
        heightScale: 1100,
        baseHeight: -120,
        season: 'autumn',
        noise: { seed: 5150, frequency: 2.8, ridged: 0.35, warp: 0.45, valley: 1.8, falloff: 0.25, erosion: 0.7 },
      },
      vegetation: { trees: 1, conifer: 0.15, treeHeight: 18 },
      sun: { elevation: 18, azimuth: 235 },
      atmosphere: { turbidity: 5, rayleigh: 2.0, haze: 0.35, clouds: 0.4, rays: 0.7, exposure: 0.12 },
      water: { level: 0, color: '#183a40' },
      camera: { position: [3800, 1100, 4600], target: [-300, 250, 0], fov: 45 },
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
        noise: { seed: 4441, frequency: 3.4, ridged: 0.3, warp: 0.6, valley: 2.2, falloff: 0.5, round: 0.3 },
        palette: { shore: '#d6c194', low: '#3f6a34', high: '#5d6b3a' },
      },
      sun: { elevation: 3.5, azimuth: 38 },
      atmosphere: { turbidity: 9, rayleigh: 2.6, mieCoefficient: 0.009, haze: 0.45, exposure: 0.137, clouds: 0.45 },
      water: { level: 0, color: '#123a4e', distortion: 2.5 },
      camera: { position: [-4300, 650, 4100], target: [300, 40, -200], fov: 45 },
    },
  },
  {
    id: 'atoll',
    name: '熱帯の環礁',
    scene: {
      meta: { name: '熱帯の環礁' },
      terrain: {
        heightScale: 160,
        baseHeight: -45,
        noise: { seed: 808, frequency: 1.5, octaves: 7, ridged: 0.1, warp: 0.9, valley: 1.2, falloff: 0.85, erosion: 0.2 },
        palette: { shore: '#f1e7c9', low: '#4f8a3a', high: '#6b9a44', rock: '#9a8a6a' },
      },
      vegetation: { trees: 0.55, conifer: 0, treeHeight: 14, tropical: 0.75 },
      sun: { elevation: 62, azimuth: 150 },
      atmosphere: { turbidity: 2.5, rayleigh: 2.4, haze: 0.18, clouds: 0.35, cloudAltitude: 1200, exposure: 0.1 },
      water: { level: 0, color: '#13a0a6', distortion: 1.8, waveScale: 1.4 },
      camera: { position: [-2600, 900, 3000], target: [0, 0, 0], fov: 50 },
    },
  },
  {
    id: 'rainbow',
    name: '雨上がりの虹',
    scene: {
      meta: { name: '雨上がりの虹' },
      terrain: { heightScale: 1300, baseHeight: -200, noise: { seed: 7272, frequency: 2.4, ridged: 0.4, falloff: 0.4 } },
      vegetation: { trees: 0.75 },
      // 太陽は見ている向きの真後ろ・低め（虹は太陽と反対側の空に出る）
      sun: { elevation: 9, azimuth: 221 },
      atmosphere: { turbidity: 6, rayleigh: 2.2, haze: 0.5, clouds: 0.45, cloudDensity: 0.7, precip: 'rain', rays: 0.6, exposure: 0.13 },
      water: { level: 0, color: '#123c48' },
      // 低い所から少し見上げる（虹は太陽と反対の点から 42° の輪なので、空の高い所に出る）
      camera: { position: [-5600, 450, 6400], target: [0, 1600, 0], fov: 60 },
    },
  },
  {
    id: 'thunderstorm',
    name: '雷雨の山脈',
    scene: {
      meta: { name: '雷雨の山脈' },
      terrain: {
        size: 12000,
        heightScale: 2600,
        baseHeight: -200,
        noise: { seed: 9091, frequency: 2.1, ridged: 0.75, warp: 0.4, valley: 1.6, falloff: 0.2, round: 0.35 },
      },
      vegetation: { trees: 0.6, conifer: 0.8 },
      sun: { elevation: 14, azimuth: 300 },
      atmosphere: { turbidity: 9, rayleigh: 1.6, haze: 0.85, clouds: 1, cloudDensity: 1, cloudThickness: 2500, cloudAltitude: 2600, precip: 'storm', rays: 0.15, exposure: 0.16 },
      water: { level: 0, color: '#16303a' },
      camera: { position: [-6500, 2200, 7000], target: [0, 700, 0], fov: 50 },
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
        // 切り立った岩壁が多いので格子を細かく（257 だと 1 マス 47 m で、一枚絵の崖が縦に引き伸ばされた筋になる）
        resolution: 513,
        noise: { seed: 913, frequency: 1.6, ridged: 0.85, warp: 0.9, valley: 2.6, falloff: 0, round: 0.35 },
        palette: { shore: '#a8673f', low: '#8a4a2b', high: '#b0703f', rock: '#5a3424', snow: '#e8d6c4', snowLine: 0.92, rockSlope: 0.6 },
      },
      vegetation: { trees: 0, grass: 0 },
      sun: { elevation: 18, azimuth: 120 },
      atmosphere: { turbidity: 18, rayleigh: 0.4, mieCoefficient: 0.02, mieDirectionalG: 0.9, haze: 0.6, exposure: 0.105, clouds: 0.1 },
      water: { enabled: false },
      camera: { position: [-5200, 1600, 5600], target: [0, 500, 0], fov: 50 },
    },
  },
  {
    id: 'dunes',
    name: '砂丘と昼の月',
    get scene() {
      return {
        meta: { name: '砂丘と昼の月' },
        terrain: {
          heightScale: 260,
          baseHeight: 0,
          // 砂丘：風上はなめらかな長い斜面、稜線は鋭く（尾根の鋭さを上げ、細部の段を減らす）。
          // 稜線が格子より鋭いので、粗い格子では稜線が段になってギザギザに見える。細かい格子にする
          resolution: 1025,
          detail: 0.12,
          noise: { seed: 4242, frequency: 3.2, octaves: 3, persistence: 0.3, ridged: 0.7, warp: 0.9, valley: 1.0, falloff: 0, erosion: 0 },
          // 砂の急斜面（滑落面）は岩肌にしない
          palette: { shore: '#e3c28a', low: '#d9b277', high: '#e8c690', rock: '#b88a56', snow: '#f4e6c8', snowLine: 1.2, rockSlope: 2.5, forest: '#b8915c' },
        },
        vegetation: { trees: 0, grass: 0 },
        sun: { elevation: 14, azimuth: 250 },
        // 砂ぼこりで淡い空。濁りを強くしすぎると、太陽と反対側の空が青みのない暗い灰色になる
        atmosphere: { turbidity: 7, rayleigh: 1.8, mieCoefficient: 0.01, haze: 0.5, clouds: 0, exposure: 0.11 },
        water: { enabled: false },
        camera: { position: [-3800, 700, 4200], target: [0, 120, 0], fov: 45 },
        // 昼の空に浮かぶ大きな月
        objects: [celestial('sphere', [9000, 6500, -12000], 5200, 'moon', '昼の月')],
      };
    },
  },
  {
    id: 'volcanic',
    name: '黒い火山島の夕暮れ',
    scene: {
      meta: { name: '黒い火山島の夕暮れ' },
      terrain: {
        heightScale: 2100,
        baseHeight: -450,
        noise: { seed: 6661, frequency: 1.2, octaves: 9, ridged: 0.45, warp: 0.25, valley: 0.9, falloff: 0.95, erosion: 0.9 },
        palette: { shore: '#3a3532', low: '#3e4a2c', high: '#2f2a28', rock: '#1f1c1b', snow: '#c9c3bd', snowLine: 0.95, rockSlope: 0.55, forest: '#1c2a16' },
      },
      vegetation: { trees: 0.35, conifer: 0.4 },
      sun: { elevation: 2.5, azimuth: 285 },
      atmosphere: { turbidity: 14, rayleigh: 2.8, mieCoefficient: 0.012, haze: 0.6, clouds: 0.5, rays: 0.8, exposure: 0.16 },
      water: { level: 0, color: '#0c2c3c', distortion: 3 },
      camera: { position: [5200, 900, 4800], target: [0, 600, 0], fov: 45 },
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
        season: 'winter',
        winterSnow: 300,
        noise: { seed: 2718, frequency: 2.0, octaves: 9, persistence: 0.5, ridged: 0.95, warp: 0.3, valley: 1.4, falloff: 0.1, round: 0.3 },
        palette: { shore: '#9aa6ad', low: '#6f7f86', high: '#8c979c', rock: '#3e464d', snow: '#f4f8ff', snowLine: 0.32, rockSlope: 0.95 },
      },
      vegetation: { trees: 0.3, conifer: 1 },
      sun: { elevation: 9, azimuth: 115 },
      atmosphere: { turbidity: 2, rayleigh: 3.2, haze: 0.25, exposure: 0.1, clouds: 0.25 },
      water: { level: 0, color: '#0d2c3a' },
      camera: { position: [-6500, 2400, 7600], target: [0, 1200, 0], fov: 45 },
    },
  },
  {
    id: 'snow-moon',
    name: '雪原の満月',
    scene: {
      meta: { name: '雪原の満月' },
      terrain: {
        heightScale: 900,
        baseHeight: -60,
        season: 'winter',
        winterSnow: -50,
        noise: { seed: 1414, frequency: 2.0, ridged: 0.3, warp: 0.6, valley: 1.6, falloff: 0.1 },
      },
      vegetation: { trees: 0.6, conifer: 0.9 },
      // 日没後しばらく：満月が東の空に昇る
      sun: { elevation: -11, azimuth: 250, moonAge: 14.8 },
      atmosphere: { turbidity: 2, rayleigh: 2.4, haze: 0.2, clouds: 0.1, exposure: 0.45 },
      water: { level: 0, color: '#0e2632' },
      camera: { position: [-4200, 800, -3200], target: [800, 200, 1200], fov: 50 },
    },
  },
  {
    id: 'aurora-fjord',
    name: 'オーロラの峡湾',
    scene: {
      meta: { name: 'オーロラの峡湾' },
      terrain: {
        size: 12000,
        heightScale: 1900,
        baseHeight: -700,
        season: 'winter',
        winterSnow: 250,
        noise: { seed: 6402, frequency: 2.4, ridged: 0.9, warp: 0.55, valley: 2.0, falloff: 0.15, erosion: 0.9, round: 0.4 },
      },
      vegetation: { trees: 0.4, conifer: 1 },
      sun: { elevation: -16, azimuth: 200, moonAge: 1 },
      atmosphere: { turbidity: 2, rayleigh: 2.2, haze: 0.15, clouds: 0.05, aurora: 1, exposure: 0.3 },
      water: { level: 0, color: '#0a2230' },
      // 北（−Z）の空を見る
      camera: { position: [0, 900, 5200], target: [0, 600, -2000], fov: 55 },
    },
  },
  {
    id: 'milky-lake',
    name: '天の川の湖',
    scene: {
      meta: { name: '天の川の湖' },
      terrain: {
        heightScale: 700,
        baseHeight: -90,
        noise: { seed: 2025, frequency: 2.2, ridged: 0.25, warp: 0.5, valley: 1.9, falloff: 0 },
      },
      vegetation: { trees: 0.8, conifer: 0.6 },
      // 新月の夏の夜：月明かりが無く、星と天の川がよく見える
      sun: { elevation: -20, azimuth: 300, moonAge: 0.5 },
      atmosphere: { turbidity: 1.5, rayleigh: 2.2, haze: 0.12, clouds: 0, exposure: 0.4 },
      water: { level: 0, color: '#06161c', distortion: 1 },
      // 天の川の濃い所（銀河の中心の向き）を、湖越しに見る
      camera: { position: [-1500, 350, 1800], target: [-3500, 1100, 1000], fov: 65 },
    },
  },
  {
    id: 'tiny-planet',
    name: '小さな星',
    scene: {
      meta: { name: '小さな星' },
      // 半径 8 km の星：少し離れると地平線が丸く沈み、星の形が分かる
      planet: { radius: 8000, curvature: true },
      terrain: {
        size: 5000,
        heightScale: 500,
        baseHeight: -120,
        noise: { seed: 3141, frequency: 3.0, ridged: 0.5, warp: 0.6, valley: 1.5, falloff: 0.3 },
      },
      vegetation: { trees: 0.7 },
      sun: { elevation: 25, azimuth: 140 },
      atmosphere: { turbidity: 3, rayleigh: 2.6, haze: 0.2, clouds: 0.3, cloudAltitude: 900, cloudThickness: 400, exposure: 0.115 },
      water: { level: 0, color: '#124058' },
      camera: { position: [-2600, 1600, 3000], target: [0, 0, 0], fov: 55 },
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
        noise: { seed: 6060, frequency: 4.0, octaves: 7, ridged: 0.15, warp: 1.2, valley: 3.0, falloff: 0, round: 0.4 },
        palette: { shore: '#8fd6c0', low: '#6a3f86', high: '#a05a9a', rock: '#2f2a44', snow: '#d9fff4', snowLine: 0.8, rockSlope: 0.7, forest: '#2a1a3a' },
      },
      sun: { elevation: 22, azimuth: 80 },
      atmosphere: { turbidity: 1.5, rayleigh: 5.5, mieCoefficient: 0.002, haze: 0.4, exposure: 0.125 },
      water: { level: 0, color: '#08524a', distortion: 1.5 },
      camera: { position: [-2600, 600, 2900], target: [0, 60, 0], fov: 50 },
    },
  },
  {
    id: 'ringed-sky',
    name: '環のある惑星の空',
    get scene() {
      return {
        meta: { name: '環のある惑星の空' },
        terrain: {
          size: 10000,
          heightScale: 1600,
          baseHeight: -300,
          noise: { seed: 7777, frequency: 1.8, ridged: 0.8, warp: 0.8, valley: 2.4, falloff: 0.3, round: 0.4 },
          palette: { shore: '#c9b8a0', low: '#5a6a7a', high: '#8a7a8a', rock: '#3a3448', snow: '#e8f0ff', snowLine: 0.85, rockSlope: 0.8, forest: '#2a3040' },
        },
        vegetation: { trees: 0.25, conifer: 1 },
        sun: { elevation: 7, azimuth: 250 },
        atmosphere: { turbidity: 3, rayleigh: 1.2, mieCoefficient: 0.008, haze: 0.3, clouds: 0.15, exposure: 0.12 },
        water: { level: 0, color: '#1a2a40' },
        camera: { position: [-5200, 1400, 6000], target: [0, 1800, 0], fov: 55 },
        // 空の大部分を占めるガス惑星と、少し傾いた環
        objects: [
          celestial('sphere', [14000, 13000, -26000], 16000, 'gas-giant', 'ガス惑星'),
          celestial('ring', [14000, 13000, -26000], 34000, 'rings', '惑星の環', [14, 0, -20]),
        ],
      };
    },
  },
];
