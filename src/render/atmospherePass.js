import * as THREE from 'three';
import { CLOUD_UNIFORMS_GLSL, CLOUD_FUNCS_GLSL, CLOUD_MARCH_GLSL, FOG_MARCH_GLSL } from './atmosphereGLSL.js';

// 一枚絵の「空気」を GPU（WebGL）で計算する。パストレースの結果に、あとから重ねる。
//
//  1. 厚みのある雲：雲の層の中を光線で進み、自分の影・太陽側の縁の明るさ・遠くの雲のかすみを計算する
//  2. 雲の影：地表の各点から太陽へ向かい、雲の層をどれだけ通るかで、日なたの光を減らす
//  3. 立体的な霧：カメラから各画素へ光線を進め、霧が散乱する日光と空の光を足す。
//     途中の点が地形や雲の影に入っていれば日光は届かないので、光の筋（薄明光線）ができる

// 太陽から見た「一番手前の面までの深さ」の地図（影の判定用）。リアルタイム表示でも使う
export const SHADOW_GLSL = /* glsl */ `
  uniform sampler2D shadowMap;
  uniform mat4 shadowMatrix; // 世界座標 → 影の地図（0..1）と深さ
  uniform float shadowBias;
  float sunVisible( vec3 p ) {
    vec4 c = shadowMatrix * vec4( p, 1.0 );
    if ( c.x < 0.0 || c.x > 1.0 || c.y < 0.0 || c.y > 1.0 ) return 1.0;
    return c.z - shadowBias > texture2D( shadowMap, c.xy ).r ? 0.0 : 1.0;
  }
`;

const depthMaterial = (lightMatrix) =>
  new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    uniforms: { lightMatrix: { value: lightMatrix } },
    vertexShader: /* glsl */ `
      varying float vD;
      uniform mat4 lightMatrix;
      void main() {
        mat4 m = modelMatrix;
        #ifdef USE_INSTANCING
          m = modelMatrix * instanceMatrix;
        #endif
        vec4 w = m * vec4( position, 1.0 );
        vD = ( lightMatrix * w ).z;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      varying float vD;
      void main() { gl_FragColor = vec4( vD, 0.0, 0.0, 1.0 ); }`,
  });

// 形だけ借りた複製を作る（元の場所・インスタンスの並びはそのまま）
function proxy(src, mat) {
  const c = src.isInstancedMesh ? new THREE.InstancedMesh(src.geometry, mat, src.count) : new THREE.Mesh(src.geometry, mat);
  if (src.isInstancedMesh) c.instanceMatrix = src.instanceMatrix;
  c.matrixAutoUpdate = false;
  c.matrix.copy(src.matrixWorld);
  c.matrixWorld.copy(src.matrixWorld);
  c.frustumCulled = false;
  return c;
}

// 太陽からの影の地図を作る。objects: 影を落とす物（Mesh / InstancedMesh）
// 戻り値: { texture, matrix, bias, dispose() }
export function buildSunShadowMap(gl, objects, sunDir, size = 4096) {
  const sun = new THREE.Vector3(...sunDir).normalize();
  const box = new THREE.Box3();
  for (const o of objects) box.expandByObject(o);
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(1, box.getSize(new THREE.Vector3()).length() / 2);
  const cam = new THREE.OrthographicCamera(-radius, radius, radius, -radius, 0.1, radius * 4);
  cam.position.copy(center).addScaledVector(sun, radius * 2);
  cam.up.set(0, 1, 0);
  if (Math.abs(sun.y) > 0.99) cam.up.set(0, 0, -1);
  cam.lookAt(center);
  cam.updateMatrixWorld();
  cam.updateProjectionMatrix();
  // 世界 → NDC → 0..1
  const toTex = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
  const matrix = new THREE.Matrix4().multiplyMatrices(toTex, new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));

  const rt = new THREE.WebGLRenderTarget(size, size, { type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
  const mat = depthMaterial(matrix);
  const scene = new THREE.Scene();
  for (const o of objects) scene.add(proxy(o, mat));
  const prev = gl.getRenderTarget();
  const prevColor = gl.getClearColor(new THREE.Color());
  const prevAlpha = gl.getClearAlpha();
  gl.setRenderTarget(rt);
  gl.setClearColor(new THREE.Color(2, 0, 0), 1); // 何もない所 = 光源の範囲より遠い
  gl.clear();
  gl.render(scene, cam);
  gl.setRenderTarget(prev);
  gl.setClearColor(prevColor, prevAlpha);
  mat.dispose();
  // 地図 1 画素ぶんの高さの差は影にしない（深さは 0..1 に縮めてある）
  const bias = ((2 * radius) / size) * 2.5 / (radius * 4);
  return { texture: rt.texture, matrix, bias, dispose: () => rt.dispose() };
}

// カメラから見た各画素の「面までの距離」と「面の向き」。空 = 0、かすみを受けない天体 = −1
const gbufferMaterial = (flag) =>
  new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      varying vec3 vW; varying vec3 vN;
      void main() {
        mat4 m = modelMatrix;
        #ifdef USE_INSTANCING
          m = modelMatrix * instanceMatrix;
        #endif
        vec4 w = m * vec4( position, 1.0 );
        vW = w.xyz;
        vN = normalize( mat3( m ) * normal );
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vW; varying vec3 vN;
      void main() {
        vec3 n = normalize( vN );
        if ( dot( n, vW - cameraPosition ) > 0.0 ) n = -n; // 裏から見ていれば向きを返す
        gl_FragColor = vec4( ${flag ? '-1.0' : 'distance( vW, cameraPosition )'}, n );
      }`,
  });

// 雲・霧の uniform（一枚絵・リアルタイム共通の値の組み立て）
export function cloudFogUniformValues(atm) {
  return {
    cloudScale: atm.clouds.scale,
    cloudCoverage: atm.clouds.coverage,
    cloudDensity: atm.clouds.density,
    cloudElevation: atm.clouds.elevation,
    cloudBase: atm.clouds.base,
    cloudThick: atm.clouds.thickness,
    fogDensity: atm.fog.density,
    fogHeight: atm.fog.height,
    fogBase: atm.fog.base,
    fogG: atm.fog.g,
  };
}

// meshes: [{ object(Mesh|InstancedMesh), celestial: bool, noShadow: bool（影を落とさない・水面など） }]
// atm: { sunDir, sunE:[r,g,b], skyE, ambient:[r,g,b], fog:{density,height,base,g,maxDist}, clouds:{coverage,density,scale,elevation,base,thickness} }
// 戻り値: { surface: Float32Array(W*H)（地表に掛ける雲の影の倍率）, inscatter: Float32Array(W*H*4)（rgb = 雲と霧の光, a = 透過率） }
export function computeAtmosphere(gl, meshes, camera, W, H, atm) {
  const shadow = buildSunShadowMap(
    gl,
    meshes.filter((m) => !m.celestial && !m.noShadow).map((m) => m.object),
    atm.sunDir,
  );

  // 画素ごとの距離と向き
  const solid = gbufferMaterial(false), sky = gbufferMaterial(true);
  const gScene = new THREE.Scene();
  for (const m of meshes) gScene.add(proxy(m.object, m.celestial ? sky : solid));
  const gRT = new THREE.WebGLRenderTarget(W, H, { type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
  const prev = gl.getRenderTarget();
  const prevColor = gl.getClearColor(new THREE.Color());
  const prevAlpha = gl.getClearAlpha();
  gl.setRenderTarget(gRT);
  gl.setClearColor(0x000000, 0);
  gl.clear();
  gl.render(gScene, camera);

  const uniforms = {
    gbuf: { value: gRT.texture },
    shadowMap: { value: shadow.texture },
    shadowMatrix: { value: shadow.matrix },
    shadowBias: { value: shadow.bias },
    invProj: { value: camera.projectionMatrixInverse.clone() },
    camWorld: { value: camera.matrixWorld.clone() },
    camPos: { value: camera.position.clone() },
    sunDir: { value: new THREE.Vector3(...atm.sunDir).normalize() },
    sunE: { value: new THREE.Vector3(...atm.sunE) },
    skyE: { value: atm.skyE },
    ambient: { value: new THREE.Vector3(...atm.ambient) },
    maxDist: { value: atm.fog.maxDist },
    mode: { value: 0 },
  };
  for (const [k, v] of Object.entries(cloudFogUniformValues(atm))) uniforms[k] = { value: v };

  const quad = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.ShaderMaterial({
      uniforms,
      depthTest: false,
      depthWrite: false,
      vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D gbuf;
        uniform mat4 invProj, camWorld;
        uniform vec3 camPos, sunDir, sunE, ambient;
        uniform float skyE, maxDist;
        uniform int mode;
        ${CLOUD_UNIFORMS_GLSL}
        ${CLOUD_FUNCS_GLSL}
        ${SHADOW_GLSL}
        float lit( vec3 p ) { return sunVisible( p ) * cloudShadow( p, sunDir, 3 ); }
        ${FOG_MARCH_GLSL}
        ${CLOUD_MARCH_GLSL}
        float hash( vec2 p ) { return fract( sin( dot( p, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ); }
        void main() {
          vec4 g = texture2D( gbuf, vUv );
          vec4 v = invProj * vec4( vUv * 2.0 - 1.0, 1.0, 1.0 ); v /= v.w;
          vec3 dir = normalize( ( camWorld * vec4( v.xyz, 0.0 ) ).xyz );

          if ( mode == 1 ) {
            // 地表に掛ける雲の影：日なたの光（直射）の割合だけ、雲の透過率で減らす
            if ( g.r <= 0.0 ) { gl_FragColor = vec4( 1.0 ); return; }
            vec3 p = camPos + dir * g.r;
            vec3 n = g.gba;
            float direct = dot( sunE, vec3( 0.2126, 0.7152, 0.0722 ) ) * max( 0.0, dot( n, sunDir ) ) * sunVisible( p + n * 0.5 );
            float f = direct / max( 1e-4, direct + skyE * ( 0.5 + 0.5 * n.y ) );
            gl_FragColor = vec4( 1.0 - f * ( 1.0 - cloudShadow( p, sunDir, 6 ) ) );
            return;
          }

          if ( g.r < 0.0 ) { gl_FragColor = vec4( 0.0, 0.0, 0.0, 1.0 ); return; } // 天体は霧も雲も受けない
          float dist = g.r > 0.0 ? g.r : maxDist;
          float j = hash( gl_FragCoord.xy );
          // 雲（面より手前の部分だけ）
          vec4 cl = marchClouds( camPos, dir, g.r > 0.0 ? g.r : 1e9, sunDir, sunE, ambient * 1.4, 96, 6, j );
          // 遠くの雲ほど空の色に溶ける（大気の厚み）
          float tc = g.r > 0.0 ? g.r : ( dir.y > 0.01 ? ( cloudBase - camPos.y ) / dir.y : maxDist );
          float far = 1.0 - exp( - max( 0.0, tc ) / 70000.0 );
          cl.rgb = mix( cl.rgb, ambient * ( 1.0 - cl.a ), far );
          // 霧
          vec4 fg = marchFog( camPos, dir, dist, sunDir, sunE, ambient, 96, j );
          // 合成：手前の霧 → 雲 → その奥（パストレースの結果）
          gl_FragColor = vec4( fg.rgb + cl.rgb * fg.a, cl.a * fg.a );
        }`,
    }),
  );
  const fsScene = new THREE.Scene();
  fsScene.add(quad);
  const fsCam = new THREE.OrthographicCamera();
  const outRT = new THREE.WebGLRenderTarget(W, H, { type: THREE.FloatType });

  const read = (mode) => {
    uniforms.mode.value = mode;
    gl.setRenderTarget(outRT);
    gl.setClearColor(0x000000, 0);
    gl.clear();
    gl.render(fsScene, fsCam);
    const px = new Float32Array(W * H * 4);
    gl.readRenderTargetPixels(outRT, 0, 0, W, H, px);
    return flipY(px, W, H);
  };
  const surfacePx = read(1);
  const inscatter = read(0);

  gl.setRenderTarget(prev);
  gl.setClearColor(prevColor, prevAlpha);
  shadow.dispose();
  for (const t of [gRT, outRT]) t.dispose();
  solid.dispose();
  sky.dispose();
  quad.geometry.dispose();
  quad.material.dispose();

  const surface = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) surface[i] = surfacePx[i * 4];
  return { surface, inscatter };
}

// WebGL の読み出しは下の行から。上から並べ直す
function flipY(px, W, H) {
  const out = new Float32Array(px.length);
  for (let y = 0; y < H; y++) out.set(px.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
  return out;
}
