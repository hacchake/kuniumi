import * as THREE from 'three';
import { TERRAIN_SHADING_GLSL, createTerrainShadingUniforms, updateTerrainShadingUniforms } from './terrainShadingGLSL.js';
import { CURVE_GLSL, curvePoint } from './curvatureGLSL.js';
import { detailBaseWavelength, detailHeight, shoreFade, SHORE_FADE } from '../core/terrainDetail.js';
import { PHOTO_ALBEDO } from '../io/photo.js';

// リアルタイム表示の地形：近くは細かく、遠くは粗く（CDLOD）。数 km の島から数千 km の大陸まで同じ仕組みで描く。
//
// ・大地全体を四分木に分け、カメラに近い区画ほど細かく分ける。どの区画も同じ 32×32 の格子を使い回す（インスタンス描画）
// ・高さは GPU が高さ場のテクスチャから引く。格子より細かい所は小さな起伏（core/terrainDetail.js と同じ式）を足す
// ・区画の境目は、遠い側の格子へ頂点を滑らかに寄せてつなぐ（moprh）。わずかな隙間はスカート（下へ垂らした縁）で隠す
// ・地表の色は GPU で塗る（core/terrainColor.js と同じ規則）。テクスチャの解像度に縛られず、足元まで細かい
// ・座標は「65536 m ごとの原点」からの相対で計算する（何千 km 離れても、足元の精度が落ちない）
// ・星の丸み（curvatureGLSL.js）で、遠くの地面は地平線の向こうへ沈む

const N = 32; // 1 区画の格子の数
const K = 2.3; // 区画の大きさ × K より近ければ 4 つに分ける
const MAX_NODES = 4000;
export const ORIGIN_STEP = 65536;

// 高さ場を引く部品（頂点と画素の両方で使う）
const FIELD_GLSL = /* glsl */ `
  uniform sampler2D tHeightTex;
  uniform float tRes, tSize, tBase;
  uniform vec2 tOriginUV; // 原点の位置（大地の 0..1）
  float tFetch( sampler2D t, ivec2 c, float res ) { return texelFetch( t, clamp( c, ivec2( 0 ), ivec2( int( res ) - 1 ) ), 0 ).r; }
  // 手で双一次補間する（GPU の補間は細かさが 1/256 しかなく、大きな格子では段々になる）
  float tBilinear( sampler2D t, vec2 uv, float res ) {
    vec2 g = clamp( uv, 0.0, 1.0 ) * ( res - 1.0 );
    vec2 i = floor( g ); vec2 f = g - i; ivec2 c = ivec2( i );
    return mix( mix( tFetch( t, c, res ), tFetch( t, c + ivec2( 1, 0 ), res ), f.x ),
                mix( tFetch( t, c + ivec2( 0, 1 ), res ), tFetch( t, c + ivec2( 1, 1 ), res ), f.x ), f.y );
  }
  vec2 tUV( vec2 local ) { return tOriginUV + local / tSize; }
  float tCoarseH( vec2 local ) { return tBase + tBilinear( tHeightTex, tUV( local ), tRes ) * tHeightScale; }
  // 高さ場の傾き（格子 1 つぶんの幅の中心差分。区画の細かさに関係なく同じ値）
  vec2 tCoarseGrad( vec2 local ) {
    float e = tSize / ( tRes - 1.0 );
    return vec2( tCoarseH( local + vec2( e, 0.0 ) ) - tCoarseH( local - vec2( e, 0.0 ) ),
                 tCoarseH( local + vec2( 0.0, e ) ) - tCoarseH( local - vec2( 0.0, e ) ) ) / ( 2.0 * e );
  }
`;

const VERTEX_GLSL = /* glsl */ `
  attribute vec4 aNode; // 区画の北西の角（原点からの相対 x, z）、一辺、つなぎ目の距離
  uniform sampler2D tWearTex;
  uniform float tWearRes, tGridN, tLodSpacing, tMinCell;
  uniform float tDetailAmt, tDetailL0, tHasWear;
  varying float vTH, vTSlope, vTWear, vTJit, vTClump;
  varying vec2 vTLocal, vTDetGrad;
  ${CURVE_GLSL}
  ${FIELD_GLSL}
  // カメラからの距離に応じた頂点の間隔の目安（区画の境目の両側で同じ値になる）
  float tSpacing( vec2 local, float h ) { return max( tMinCell, distance( vec3( local.x, h, local.y ), kCamPos ) * tLodSpacing ); }

  // 地形の頂点：位置（曲げた後）と法線
  void kTerrainVertex( out vec3 pos, out vec3 nrm ) {
    float n = tGridN;
    vec2 g = position.xz * n;
    vec2 local0 = aNode.xy + position.xz * aNode.z;
    float d = distance( vec3( local0.x, tCoarseH( local0 ), local0.y ), kCamPos );
    // 遠い側（粗い区画）との境目に近いほど、奇数番目の頂点を偶数番目へ寄せる
    float morph = clamp( ( d - aNode.w * 0.72 ) / ( aNode.w * 0.22 ), 0.0, 1.0 );
    g -= fract( g * 0.5 ) * 2.0 * morph;
    vec2 local = aNode.xy + g / n * aNode.z;
    float hc = tCoarseH( local );
    float sp = tSpacing( local, hc );
    // 細部の起伏は値と傾きを一度に出す（法線のために何度も計算しない）
    vec3 dd = tDetailD( local, tDetailL0, sp, tDetailAmt );
    // 海面の近くでは細部を弱める（core/terrainDetail.js の shoreFade と同じ）
    if ( tWater > 0.5 ) dd *= min( 1.0, abs( hc - tSea ) / ${SHORE_FADE.toFixed(1)} );
    float H = hc + dd.x;
    vec2 grad = dd.yz;
    vTDetGrad = dd.yz;
    #ifndef KUNIUMI_NO_NORMAL
      // 高さ場の傾き（中心差分。格子 1 つぶん以上の幅でならす）
      float e = max( sp, tSize / ( tRes - 1.0 ) );
      grad += vec2( tCoarseH( local + vec2( e, 0.0 ) ) - tCoarseH( local - vec2( e, 0.0 ) ),
                    tCoarseH( local + vec2( 0.0, e ) ) - tCoarseH( local - vec2( 0.0, e ) ) ) / ( 2.0 * e );
    #endif
    vTSlope = length( grad );
    vTH = H;
    vTWear = tHasWear > 0.5 ? tBilinear( tWearTex, tUV( local ), tWearRes ) : 0.0;
    vTLocal = local;
    #ifndef KUNIUMI_NO_NORMAL
      vTJit = tJitterCoarse( local, sp );
      vTClump = tClump( local, sp );
    #endif
    // スカート：区画の縁を下へ垂らして、境目のわずかな隙間を隠す（大地の外周には付けない）
    if ( position.y > 0.5 ) {
      vec2 uv = tUV( local );
      float edge = min( min( uv.x, 1.0 - uv.x ), min( uv.y, 1.0 - uv.y ) );
      if ( edge > 0.5 / tRes ) H -= aNode.z / n * 1.5 + 1.0;
    }
    vec3 p = vec3( local.x, H, local.y );
    pos = kCurve( p );
    nrm = kCurveN( p, normalize( vec3( - grad.x, 1.0, - grad.y ) ) );
  }
`;

// 区画の格子（0..1）＋スカート。position.y = 1 がスカートの頂点
function createPatchGeometry() {
  const V = N + 1;
  const border = [];
  for (let i = 0; i < N; i++) border.push([i, 0]);
  for (let j = 0; j < N; j++) border.push([N, j]);
  for (let i = N; i > 0; i--) border.push([i, N]);
  for (let j = N; j > 0; j--) border.push([0, j]);
  const pos = new Float32Array((V * V + border.length) * 3);
  for (let j = 0; j < V; j++) for (let i = 0; i < V; i++) pos.set([i / N, 0, j / N], (j * V + i) * 3);
  border.forEach(([i, j], k) => pos.set([i / N, 1, j / N], (V * V + k) * 3));
  const index = [];
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const a = j * V + i, b = a + 1, c = a + V, d = c + 1;
      index.push(a, c, b, b, c, d);
    }
  }
  const B = border.length;
  for (let k = 0; k < B; k++) {
    const [i0, j0] = border[k], [i1, j1] = border[(k + 1) % B];
    const a = j0 * V + i0, b = j1 * V + i1, a2 = V * V + k, b2 = V * V + ((k + 1) % B);
    // どちらから見ても見えるよう両面
    index.push(a, b, a2, b, b2, a2, a, a2, b, b, a2, b2);
  }
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(index);
  const node = new THREE.InstancedBufferAttribute(new Float32Array(MAX_NODES * 4), 4);
  node.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aNode', node);
  geo.instanceCount = 0;
  return geo;
}

export class GpuTerrain {
  constructor({ cloudUniforms, curveUniforms, patchMaterial }) {
    this.curveUniforms = curveUniforms;
    this.uniforms = {
      ...createTerrainShadingUniforms(),
      tHeightTex: { value: null },
      tWearTex: { value: null },
      tRes: { value: 2 },
      tWearRes: { value: 2 },
      tSize: { value: 8000 },
      tBase: { value: 0 },
      tGridN: { value: N },
      tLodSpacing: { value: 1 / (1.6 * K * N) },
      tMinCell: { value: 0.5 },
      tDetailAmt: { value: 1 },
      tDetailL0: { value: 64 },
      tHasWear: { value: 0 },
      tPhoto: { value: null }, // 地表の衛星写真（範囲と同じ正方形、行 0 = 北）
      tWaterMask: { value: null }, // 川・湖の印（OpenStreetMap。白 = 水）
      tLights: { value: null }, // 夜の街の明かり（範囲と同じ正方形）
      tLightsI: { value: 0 }, // 明かりの強さ（夜ほど強く。0 なら描かない）
      tWet: { value: 0 }, // 雨で濡れた地面（0..1）：暗く、少しつややかに
      tSeason: { value: 0 }, // 季節（0 = そのまま、1 = 春、2 = 秋、3 = 冬）
      tWinterSnow: { value: 600 }, // 冬に雪が積もる高さ (m)
      tSnowCover: { value: 0 }, // 降っている雪の積もり具合（0..1）。季節に関係なく、平らな所からまだらに白くなる
      tSnowFloor: { value: 0 }, // これより低い所（水面）には積もらない
      tHasWaterMask: { value: 0 },
      tHasPhoto: { value: 0 },
      tOriginUV: { value: new THREE.Vector2() },
      tOriginW: { value: new THREE.Vector2() }, // 原点（世界座標）
      tClipHalf: { value: 0 },
      ...curveUniforms,
    };
    this.geometry = createPatchGeometry();
    this.material = new THREE.MeshStandardMaterial({ name: 'Terrain', roughness: 0.92, metalness: 0 });
    this.material.defines = { KUNIUMI_NO_CURVE: '', KUNIUMI_VERTEX_CLOUD: '' };
    this.#inject(this.material, 'standard');
    patchMaterial?.(this.material);
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.name = 'Terrain';
    const depth = new THREE.MeshDepthMaterial();
    depth.defines = { KUNIUMI_NO_NORMAL: '' }; // 影には形だけ要る
    this.#inject(depth, 'depth');
    this.mesh.customDepthMaterial = depth;
    // 霧の光の筋のための影の地図（atmospherePass.js）に、この地形を描く代わりの物
    this.mesh.userData.shadowProxy = (lightMatrix) => this.#shadowProxy(lightMatrix);
    this.field = null;
    this.res = 0;
    this.pyramid = null;
    this.terrain = null;
    this.origin = new THREE.Vector2();
    this.frustum = new THREE.Frustum();
    this.ready = false;
  }

  #inject(material, kind) {
    const uniforms = this.uniforms;
    const prev = material.onBeforeCompile;
    material.onBeforeCompile = (shader, renderer) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\n${TERRAIN_SHADING_HEAD}\n${VERTEX_GLSL}`);
      if (kind === 'standard') {
        shader.vertexShader = shader.vertexShader
          .replace('#include <beginnormal_vertex>', 'vec3 objectNormal; vec3 kTP; kTerrainVertex( kTP, objectNormal );')
          .replace('#include <begin_vertex>', 'vec3 transformed = kTP;');
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', `#include <common>\n${TERRAIN_SHADING_GLSL}\nvarying float vTH, vTSlope, vTWear, vTJit, vTClump;\nvarying vec2 vTLocal, vTDetGrad;\nuniform vec2 tOriginW;\nuniform float tClipHalf, tHasPhoto, tHasWaterMask, tSeason, tWinterSnow, tLightsI, tWet, tSnowCover, tSnowFloor;\nuniform sampler2D tPhoto, tWaterMask, tLights;\n${CURVE_GLSL}\n${FIELD_GLSL}`)
          // 面の向きと傾きは画素ごとに高さ場から出す（頂点の補間だと、区画の細かさが変わる所で線が出る）
          .replace(
            '#include <normal_fragment_begin>',
            `#include <normal_fragment_begin>
            vec2 kG = tCoarseGrad( vTLocal ) + vTDetGrad;
            float kSlope = length( kG );
            normal = normalize( ( viewMatrix * vec4( kCurveN( vec3( vTLocal.x, vTH, vTLocal.y ), normalize( vec3( - kG.x, 1.0, - kG.y ) ) ), 0.0 ) ).xyz );
            // 川・湖の水面は平らに（空を映す）
            normal = normalize( mix( normal, normalize( ( viewMatrix * vec4( kCurveN( vec3( vTLocal.x, vTH, vTLocal.y ), vec3( 0.0, 1.0, 0.0 ) ), 0.0 ) ).xyz ), kWm ) );`,
          )
          // 細かい色むらは、画素の大きさ（距離 × 画角）より大きい段だけ
          .replace(
            '#include <map_fragment>',
            // 海面より下は水面が覆うので描かない（遠くの粗い三角形で、浅い海底が水面から顔を出さないように）
            'if ( tWater > 0.5 && vTH < tSea ) discard;\n' +
            // 周りの地形は、本来の地形がある内側を描かない
            'if ( tClipHalf > 0.0 ) { vec2 kw = vTLocal + tOriginW; if ( max( abs( kw.x ), abs( kw.y ) ) < tClipHalf ) discard; }\n' +
            'float kPix = length( vViewPosition ) * 0.0015;\n' +
              'vec2 kG0 = tCoarseGrad( vTLocal ) + vTDetGrad;\n' +
              'float kJ = vTJit + tJitterFine( vTLocal, kPix );\n' +
              'vec3 kTC = terrainColor( vTH, length( kG0 ), vTWear, kJ, vTClump );\n' +
              // 衛星写真があれば、その色を地表の色にする（細かい色むらだけ手続きの色から少し残す）
              `if ( tHasPhoto > 0.5 ) kTC = texture2D( tPhoto, clamp( tUV( vTLocal ), 0.0, 1.0 ) ).rgb * ${PHOTO_ALBEDO.toFixed(3)} * ( 1.0 + kJ * 0.35 );\n` +

              // 川・湖：暗い水の色（写真の色を少し残す）。なめらかさは roughnessmap の後で
              'float kWm = tHasWaterMask > 0.5 ? smoothstep( 0.35, 0.65, texture2D( tWaterMask, clamp( tUV( vTLocal ), 0.0, 1.0 ) ).r ) : 0.0;\n' +
              'kTC = mix( kTC, kTC * 0.35 + vec3( 0.012, 0.03, 0.04 ), kWm );\n' +
              // 季節：秋は森（緑の濃い所）を赤や黄に、春は若葉の明るい緑に、冬は高い所と平らな所に雪
              'if ( tSeason > 0.5 ) {\n' +
              '  float kGr = clamp( ( kTC.g - kTC.r ) / ( kTC.g + kTC.r + 1e-4 ) * 4.0, 0.0, 1.0 );\n' +
              '  float kLm = dot( kTC, vec3( 0.2126, 0.7152, 0.0722 ) );\n' +
              '  if ( tSeason < 1.5 ) kTC = mix( kTC, kTC * vec3( 1.05, 1.25, 0.85 ), kGr * 0.7 );\n' +
              '  else if ( tSeason < 2.5 ) {\n' +
              '    float kN = tValueNoise( vTLocal, 128.0, 77 ) * 0.7 + tValueNoise( vTLocal, 32.0, 78 ) * 0.3;\n' +
              '    vec3 kAut = mix( vec3( 0.62, 0.16, 0.04 ), vec3( 0.72, 0.48, 0.08 ), kN );\n' +
              '    kTC = mix( kTC, kAut * ( kLm * 2.2 + 0.03 ), kGr * 0.85 );\n' +
              '  } else {\n' +
              '    float kSn = smoothstep( tWinterSnow - 150.0, tWinterSnow + 250.0, vTH ) * ( 1.0 - smoothstep( 0.55, 1.0, length( kG0 ) ) );\n' +
              '    kTC = mix( kTC * vec3( 0.95, 0.92, 0.85 ) * mix( 1.0, 0.75, kGr ), vec3( 0.82, 0.85, 0.9 ), kSn * ( 1.0 - kWm ) );\n' +
              '  }\n' +
              '}\n' +
              // 降り積もる雪：まだら（ノイズ）が積もるほど広がり、急な斜面と川・海には積もらない
              'if ( tSnowCover > 0.0 ) {\n' +
              '  float kNs = tValueNoise( vTLocal, 64.0, 91 ) * 0.6 + tValueNoise( vTLocal, 8.0, 92 ) * 0.4;\n' +
              '  float kAc = smoothstep( 1.0 - tSnowCover * 1.15, 1.15 - tSnowCover * 1.15, kNs ) * ( 1.0 - smoothstep( 0.45, 0.9, length( kG0 ) ) );\n' +
              '  kAc *= ( 1.0 - kWm ) * smoothstep( tSnowFloor, tSnowFloor + 0.5, vTH );\n' +
              '  kTC = mix( kTC, vec3( 0.82, 0.85, 0.9 ), kAc );\n' +
              '}\n' +
              'diffuseColor.rgb *= kTC * ( 1.0 - 0.3 * tWet * ( 1.0 - kWm ) );',
          )
          .replace(
            '#include <roughnessmap_fragment>',
            '#include <roughnessmap_fragment>\nroughnessFactor = mix( roughnessFactor, 0.07, kWm );\nroughnessFactor = mix( roughnessFactor, 0.45, tWet * ( 1.0 - smoothstep( 0.3, 0.8, length( tCoarseGrad( vTLocal ) ) ) ) );',
          )
          // 夜の街の明かり（暗い陸の写りは除いて、明かりだけを光らせる）
          .replace(
            '#include <emissivemap_fragment>',
            '#include <emissivemap_fragment>\nif ( tLightsI > 0.0 ) { vec3 kL = texture2D( tLights, clamp( tUV( vTLocal ), 0.0, 1.0 ) ).rgb; totalEmissiveRadiance += max( kL - 0.06, vec3( 0.0 ) ) * vec3( 1.0, 0.8, 0.55 ) * tLightsI * ( 1.0 - kWm ); }',
          );
      } else {
        shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', 'vec3 kTN; vec3 transformed; kTerrainVertex( transformed, kTN );');
      }
      prev?.call(material, shader, renderer);
    };
    material.customProgramCacheKey = () => `gpuTerrain-${kind}`;
  }

  // 霧の光の筋のための影の地図用：地形の形だけを「太陽からの深さ」で描く
  #shadowProxy(lightMatrix) {
    const mat = new THREE.ShaderMaterial({
      side: THREE.DoubleSide,
      uniforms: { ...this.uniforms, lightMatrix: { value: lightMatrix } },
      defines: { KUNIUMI_NO_NORMAL: '' },
      vertexShader: /* glsl */ `
        ${TERRAIN_SHADING_HEAD}
        ${VERTEX_GLSL}
        uniform mat4 lightMatrix;
        varying float vD;
        void main() {
          vec3 p, n;
          kTerrainVertex( p, n );
          vec4 w = modelMatrix * vec4( p, 1.0 );
          vD = ( lightMatrix * w ).z;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */ `
        varying float vD;
        void main() { gl_FragColor = vec4( vD, 0.0, 0.0, 1.0 ); }`,
    });
    // 影の地図はカメラの後ろも要るので、視野で省かずに選び直す（形の格子は共有）
    if (!this.shadowGeo) {
      const g = new THREE.InstancedBufferGeometry();
      g.setIndex(this.geometry.index);
      g.setAttribute('position', this.geometry.attributes.position);
      const node = new THREE.InstancedBufferAttribute(new Float32Array(MAX_NODES * 4), 4);
      node.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('aNode', node);
      this.shadowGeo = g;
    }
    if (this.camW) this.#fill(this.shadowGeo, false);
    const m = new THREE.Mesh(this.shadowGeo, mat);
    m.matrixAutoUpdate = false;
    m.matrix.copy(this.mesh.matrixWorld);
    m.matrixWorld.copy(this.mesh.matrixWorld);
    m.frustumCulled = false;
    m.userData.dispose = () => mat.dispose();
    return m;
  }

  // 高さ場（0..1、行 0 = 北）と侵食の量を受け取る
  setField(field, res, wear) {
    this.field = field;
    this.wear = wear ?? null;
    this.res = res;
    const tex = new THREE.DataTexture(field, res, res, THREE.RedFormat, THREE.FloatType);
    tex.minFilter = tex.magFilter = THREE.NearestFilter;
    tex.needsUpdate = true;
    this.uniforms.tHeightTex.value?.dispose();
    this.uniforms.tHeightTex.value = tex;
    this.uniforms.tRes.value = res;
    this.uniforms.tWearTex.value?.dispose();
    if (wear) {
      const w = new THREE.DataTexture(wear, res, res, THREE.RedFormat, THREE.FloatType);
      w.minFilter = w.magFilter = THREE.NearestFilter;
      w.needsUpdate = true;
      this.uniforms.tWearTex.value = w;
      this.uniforms.tWearRes.value = res;
      this.uniforms.tHasWear.value = 1;
    } else {
      this.uniforms.tWearTex.value = tex; // 使わないが、何か入れておく
      this.uniforms.tHasWear.value = 0;
    }
    this.pyramid = buildPyramid(field, res);
    this.ready = true;
  }

  // 大きさ・起伏・色などシーンの値
  // over.size: 大地の大きさを差し替える（周りの地形用）。over.clipHalf: この半径の正方形の内側は描かない（内側は本来の地形が描く）
  // 地表の衛星写真（THREE.Texture、無ければ null）
  // 川・湖の印（THREE.Texture、無ければ null）
  // 季節（'summer' = そのまま、'spring'、'autumn'、'winter'）と、冬に雪が積もる高さ
  setSeason(season, winterSnow = 600) {
    this.uniforms.tSeason.value = { spring: 1, autumn: 2, winter: 3 }[season] ?? 0;
    this.uniforms.tWinterSnow.value = winterSnow;
  }

  // 夜の街の明かり（THREE.Texture）と強さ（0 = 消す）
  setLights(tex, intensity) {
    this.uniforms.tLights.value = tex;
    this.uniforms.tLightsI.value = tex ? intensity : 0;
  }

  setWaterMask(tex) {
    this.uniforms.tWaterMask.value = tex;
    this.uniforms.tHasWaterMask.value = tex ? 1 : 0;
  }

  setPhoto(tex) {
    this.uniforms.tPhoto.value = tex;
    this.uniforms.tHasPhoto.value = tex ? 1 : 0;
  }

  setScene(s, over = {}) {
    const t = over.size ? { ...s.terrain, size: over.size } : s.terrain;
    this.terrain = t;
    this.clipHalf = over.clipHalf ?? 0;
    this.uniforms.tClipHalf.value = this.clipHalf;
    const u = this.uniforms;
    updateTerrainShadingUniforms(u, s);
    u.tSize.value = t.size;
    u.tBase.value = t.baseHeight;
    u.tDetailAmt.value = t.detail ?? 1;
    const cell = t.size / Math.max(1, (this.res || t.resolution) - 1);
    u.tDetailL0.value = Math.min(ORIGIN_STEP, detailBaseWavelength(cell));
    // 一番細かい区画の格子：だいたい 1 m（小さな島でも大陸でも）
    this.levels = Math.max(1, Math.min(22, Math.ceil(Math.log2(t.size / N / 1.0))));
    u.tMinCell.value = t.size / N / 2 ** this.levels;
    this.detailMargin = (t.detail ?? 1) * u.tDetailL0.value * 0.03 * 1.5;
  }

  // 毎フレーム：カメラに合わせて区画を選ぶ
  // camera: 描くときのカメラ（丸みで曲げた位置。視野の判定に使う）
  // origin: 計算の原点（世界座標、65536 m の倍数）
  // 細かさの判定は平らな地図の上のカメラの位置（kCamPos）、丸みの中心は kCenter（どちらも描くときの座標）
  update(camera, origin) {
    if (!this.ready || !this.terrain) return;
    const t = this.terrain;
    const u = this.uniforms;
    this.origin.copy(origin);
    u.tOriginUV.value.set(origin.x / t.size + 0.5, origin.y / t.size + 0.5);
    u.tOriginW.value.copy(origin);
    u.tOriginI.value.set(Math.round(origin.x / ORIGIN_STEP), Math.round(origin.y / ORIGIN_STEP));
    this.mesh.position.set(origin.x, 0, origin.y);

    camera.updateMatrixWorld();
    this.frustum.setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    // 選ぶ計算は世界座標（倍精度）で行う。描くときの座標なので原点を足す
    const cam = this.curveUniforms.kCamPos.value;
    const ctr = this.curveUniforms.kCenter.value;
    this.camW = [cam.x + origin.x, cam.y, cam.z + origin.y];
    this.centerW = [ctr.x + origin.x, ctr.y + origin.y];
    this.R = this.curveUniforms.kPlanetR.value;
    this.#fill(this.geometry, true);
  }

  // 区画を選んで geometry のインスタンスに詰める（cull = 視野の外を省く）
  #fill(geometry, cull) {
    const t = this.terrain;
    const attr = geometry.attributes.aNode;
    this.sel = { attr: attr.array, count: 0, cull };
    const half = t.size / 2;
    this.#select(-half, -half, t.size, this.levels, 0, 0, 0);
    geometry.instanceCount = this.sel.count;
    attr.clearUpdateRanges();
    attr.addUpdateRange(0, this.sel.count * 4);
    attr.needsUpdate = true;
  }

  #select(x0, z0, size, level, depth, qi, qj) {
    const sel = this.sel;
    if (sel.count >= MAX_NODES) return;
    // 周りの地形：内側にすっぽり入る区画は要らない
    const ch = this.clipHalf;
    if (ch > 0 && x0 >= -ch && z0 >= -ch && x0 + size <= ch && z0 + size <= ch) return;
    const [hmin, hmax] = this.#heightRange(depth, qi, qj);
    const [cx, cy, cz] = this.camW;
    // 箱までの距離（倍精度・平らな地図の上で）
    const dx = Math.max(x0 - cx, 0, cx - (x0 + size));
    const dz = Math.max(z0 - cz, 0, cz - (z0 + size));
    const dy = Math.max(hmin - cy, 0, cy - hmax);
    const dist = Math.hypot(dx, dy, dz);
    // 視野に入るか（丸みで曲げた後の位置で、外接球で判定）
    const mx = x0 + size / 2, mz = z0 + size / 2, my = (hmin + hmax) / 2;
    const c = curvePoint(mx, my, mz, this.centerW[0], this.centerW[1], this.R);
    const rad = Math.hypot(size * 0.7072, (hmax - hmin) / 2) * 1.02 + 1;
    _sphere.center.set(c[0] - this.origin.x, c[1], c[2] - this.origin.y);
    _sphere.radius = rad;
    if (sel.cull && !this.frustum.intersectsSphere(_sphere)) return;
    if (level > 0 && dist < K * size) {
      const h = size / 2;
      this.#select(x0, z0, h, level - 1, depth + 1, qi * 2, qj * 2);
      this.#select(x0 + h, z0, h, level - 1, depth + 1, qi * 2 + 1, qj * 2);
      this.#select(x0, z0 + h, h, level - 1, depth + 1, qi * 2, qj * 2 + 1);
      this.#select(x0 + h, z0 + h, h, level - 1, depth + 1, qi * 2 + 1, qj * 2 + 1);
      return;
    }
    const o = sel.count * 4;
    sel.attr[o] = x0 - this.origin.x;
    sel.attr[o + 1] = z0 - this.origin.y;
    sel.attr[o + 2] = size;
    sel.attr[o + 3] = 2 * K * size;
    sel.count++;
  }

  // 区画の高さの範囲（細部の起伏のぶん少し広げる）
  #heightRange(depth, qi, qj) {
    const p = this.pyramid;
    const t = this.terrain;
    let d = depth, i = qi, j = qj;
    while (d > p.levels.length - 1) {
      d--;
      i >>= 1;
      j >>= 1;
    }
    const L = p.levels[d];
    const n = 1 << d;
    const k = (j * n + i) * 2;
    const m = this.detailMargin + 1;
    return [t.baseHeight + L[k] * t.heightScale - m, t.baseHeight + L[k + 1] * t.heightScale + m];
  }

  // 地点 (x, z)（世界座標）の高さ。細部の起伏は含まない
  heightAt(x, z) {
    const t = this.terrain;
    if (!this.field || !t) return 0;
    const res = this.res;
    const gx = Math.min(1, Math.max(0, x / t.size + 0.5)) * (res - 1);
    const gz = Math.min(1, Math.max(0, z / t.size + 0.5)) * (res - 1);
    const i = Math.min(res - 2, Math.floor(gx)), j = Math.min(res - 2, Math.floor(gz));
    const fx = gx - i, fz = gz - j, f = this.field, k = j * res + i;
    const h = (f[k] * (1 - fx) + f[k + 1] * fx) * (1 - fz) + (f[k + res] * (1 - fx) + f[k + res + 1] * fx) * fz;
    return t.baseHeight + h * t.heightScale;
  }

  // 粗い近似：高さ・傾き・侵食（木を立てる場所の判定用。core/terrainSurface.js の coarse と同じ形）
  sample(x, z) {
    const t = this.terrain;
    const e = t.size / Math.max(1, this.res - 1);
    const gx = (this.heightAt(x + e, z) - this.heightAt(x - e, z)) / (2 * e);
    const gz = (this.heightAt(x, z + e) - this.heightAt(x, z - e)) / (2 * e);
    let wv = 0;
    if (this.wear) {
      const res = this.res;
      const fx = Math.min(1, Math.max(0, x / t.size + 0.5)) * (res - 1), fz = Math.min(1, Math.max(0, z / t.size + 0.5)) * (res - 1);
      wv = this.wear[Math.round(fz) * res + Math.round(fx)];
    }
    return { h: this.heightAt(x, z), slope: Math.hypot(gx, gz), wv };
  }

  // 足元の高さ：細部の起伏まで含めて、GPU が足元に描く形と同じ（歩き回るモード用）
  groundAt(x, z) {
    const t = this.terrain;
    if (!this.field || !t) return 0;
    const cell = t.size / Math.max(1, this.res - 1);
    const h = this.heightAt(x, z);
    const u = this.uniforms;
    const sea = u.tWater.value > 0.5 ? u.tSea.value : null;
    return h + detailHeight(x, z, cell, this.uniforms.tMinCell.value, t.detail ?? 1) * shoreFade(h, sea);
  }

  // 光線と地形の交点（世界座標・平らな地図の上で）。無ければ null
  raycast(origin, dir, maxDist) {
    const t = this.terrain;
    if (!this.field || !t) return null;
    const half = t.size / 2;
    // 大地の箱に入る所から出る所まで
    let t0 = 0, t1 = maxDist;
    for (const a of ['x', 'z']) {
      if (Math.abs(dir[a]) < 1e-12) {
        if (origin[a] < -half || origin[a] > half) return null;
        continue;
      }
      let ta = (-half - origin[a]) / dir[a], tb = (half - origin[a]) / dir[a];
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta);
      t1 = Math.min(t1, tb);
    }
    if (t1 <= t0) return null;
    const cell = t.size / (this.res - 1);
    const p = new THREE.Vector3();
    let prevT = t0, prevD = null;
    for (let s = 0, tt = t0; tt <= t1 && s < 200000; s++) {
      p.copy(origin).addScaledVector(dir, tt);
      const d = p.y - this.heightAt(p.x, p.z);
      if (d <= 0) {
        if (prevD === null) return p.clone();
        // 前の点との間を二分して詰める
        let a = prevT, b = tt;
        for (let k = 0; k < 24; k++) {
          const m = (a + b) / 2;
          p.copy(origin).addScaledVector(dir, m);
          if (p.y - this.heightAt(p.x, p.z) > 0) a = m;
          else b = m;
        }
        return origin.clone().addScaledVector(dir, (a + b) / 2);
      }
      prevT = tt;
      prevD = d;
      // 高さの余裕に応じて歩幅を広げる（格子の半分より細かくはしない）
      tt += Math.max(cell * 0.5, d * 0.3);
    }
    return null;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.customDepthMaterial.dispose();
    this.uniforms.tHeightTex.value?.dispose();
    if (this.uniforms.tWearTex.value !== this.uniforms.tHeightTex.value) this.uniforms.tWearTex.value?.dispose();
  }
}

const _sphere = new THREE.Sphere();

// 頂点シェーダで地面の色の部品のうち、頂点で使う分（細部の起伏・ノイズ）だけ
const TERRAIN_SHADING_HEAD = TERRAIN_SHADING_GLSL.replace(/\/\/ 木の密度[\s\S]*$/, '');

// 区画ごとの高さの最小・最大（四分木の深さ d で 2^d × 2^d 個）。深い所は親の値を使う
function buildPyramid(field, res) {
  const maxD = Math.max(0, Math.min(9, Math.floor(Math.log2(res - 1))));
  const levels = new Array(maxD + 1);
  const n = 1 << maxD;
  const L = new Float32Array(n * n * 2);
  for (let qj = 0; qj < n; qj++) {
    const j0 = Math.floor((qj / n) * (res - 1)), j1 = Math.min(res - 1, Math.ceil(((qj + 1) / n) * (res - 1)));
    for (let qi = 0; qi < n; qi++) {
      const i0 = Math.floor((qi / n) * (res - 1)), i1 = Math.min(res - 1, Math.ceil(((qi + 1) / n) * (res - 1)));
      let lo = Infinity, hi = -Infinity;
      for (let j = j0; j <= j1; j++) {
        const row = j * res;
        for (let i = i0; i <= i1; i++) {
          const v = field[row + i];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
      L[(qj * n + qi) * 2] = lo;
      L[(qj * n + qi) * 2 + 1] = hi;
    }
  }
  levels[maxD] = L;
  for (let d = maxD - 1; d >= 0; d--) {
    const m = 1 << d, c = levels[d + 1], out = new Float32Array(m * m * 2);
    for (let j = 0; j < m; j++) {
      for (let i = 0; i < m; i++) {
        let lo = Infinity, hi = -Infinity;
        for (const [a, b] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
          const k = ((j * 2 + b) * m * 2 + (i * 2 + a)) * 2;
          lo = Math.min(lo, c[k]);
          hi = Math.max(hi, c[k + 1]);
        }
        out[(j * m + i) * 2] = lo;
        out[(j * m + i) * 2 + 1] = hi;
      }
    }
    levels[d] = out;
  }
  return { levels };
}
