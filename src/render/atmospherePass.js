import * as THREE from 'three';

// 一枚絵の「空気」を GPU（WebGL）で計算する。パストレースの結果に、あとから重ねる。
//
//  1. 雲の影：地表の各点から太陽へ向かい、雲の層（空の雲と同じ式）をどれだけ通るかで、日なたの光を減らす
//  2. 立体的な霧：カメラから各画素へ光線を少しずつ進め、霧が散乱する日光と空の光を足し合わせる。
//     途中の点が地形や雲の影に入っていれば日光は届かないので、光の筋（薄明光線）ができる
//
// 雲は「カメラから見て空の雲と同じ位置に見える」高さ Hc の層として扱う（Sky シェーダの雲は方向だけで決まるので、
// カメラの真上から Hrel = Hc − カメラ高度 の層に置けば、見た目がぴったり重なる）。

const CLOUD_GLSL = /* glsl */ `
  uniform float cloudScale, cloudCoverage, cloudDensity, cloudElevation, cloudHrel, cloudHc;
  uniform vec3 camPos;
  vec2 gradient2( vec2 i ) {
    vec3 p = fract( i.xyx * vec3( 0.1031, 0.1030, 0.0973 ) );
    p += dot( p, p.yzx + 33.33 );
    return fract( ( p.xx + p.yz ) * p.zy ) * 2.0 - 1.0;
  }
  float gnoise( vec2 p ) {
    vec2 i = floor( p ); vec2 f = fract( p );
    vec2 u = f * f * f * ( f * ( f * 6.0 - 15.0 ) + 10.0 );
    float a = dot( gradient2( i ), f );
    float b = dot( gradient2( i + vec2( 1.0, 0.0 ) ), f - vec2( 1.0, 0.0 ) );
    float c = dot( gradient2( i + vec2( 0.0, 1.0 ) ), f - vec2( 0.0, 1.0 ) );
    float d = dot( gradient2( i + vec2( 1.0, 1.0 ) ), f - vec2( 1.0, 1.0 ) );
    return mix( mix( a, b, u.x ), mix( c, d, u.x ), u.y ) * 1.6;
  }
  float gfbm( vec2 p ) {
    float r = 0.0; float a = 1.0;
    for ( int i = 0; i < 4; i ++ ) { r += a * gnoise( p ); a *= 0.5; p = p * 2.0; }
    return r;
  }
  // 点 p から太陽方向 s に進んで雲の層を抜けるときの、日光の透過率
  float cloudTransmit( vec3 p, vec3 s ) {
    if ( cloudCoverage <= 0.0 || s.y <= 0.01 || p.y >= cloudHc ) return 1.0;
    vec3 q = p + s * ( ( cloudHc - p.y ) / s.y );
    float elevation = mix( 1.0, 0.1, cloudElevation );
    vec2 uv = ( q.xz - camPos.xz ) / ( cloudHrel * elevation ) * cloudScale;
    float n = clamp( gfbm( uv * 1000.0 ) * 0.7 + 0.5, 0.0, 1.0 );
    float region = gnoise( uv * 300.0 ) * 0.37 + 0.5;
    float cov = clamp( cloudCoverage + ( region - 0.5 ) * 0.6, 0.0, 1.0 );
    float th = 1.0 - cov;
    float depth = max( 0.0, n - th );
    float alpha = 1.0 - exp( depth * cloudDensity * -12.0 );
    return 1.0 - alpha * 0.9;
  }
`;

const SHADOW_GLSL = /* glsl */ `
  uniform sampler2D shadowMap;
  uniform mat4 shadowMatrix; // 世界座標 → 影の地図（0..1）と深さ
  uniform float shadowBias;
  float sunVisible( vec3 p ) {
    vec4 c = shadowMatrix * vec4( p, 1.0 );
    if ( c.x < 0.0 || c.x > 1.0 || c.y < 0.0 || c.y > 1.0 ) return 1.0;
    float d = texture2D( shadowMap, c.xy ).r;
    return c.z - shadowBias > d ? 0.0 : 1.0;
  }
`;

// 光源側から見た「太陽に一番近い面までの深さ」。0..1
const depthMaterial = (shadowMatrixFn) =>
  new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      varying float vD;
      uniform mat4 lightMatrix;
      void main() {
        vec4 w = modelMatrix * vec4( position, 1.0 );
        #ifdef USE_INSTANCING
          w = modelMatrix * instanceMatrix * vec4( position, 1.0 );
        #endif
        vec4 c = lightMatrix * w;
        vD = c.z;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      varying float vD;
      void main() { gl_FragColor = vec4( vD, 0.0, 0.0, 1.0 ); }`,
    uniforms: { lightMatrix: { value: shadowMatrixFn } },
  });

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

// meshes: [{ object(Mesh|InstancedMesh), celestial: bool, noShadow: bool（影を落とさない・水面など） }]
// atm: { sunDir:[x,y,z], sunE:[r,g,b], skyE: number, ambient:[r,g,b](霧に当たる空の光), fog: { density, height, base, g }, clouds: {...} }
// 戻り値: { surface: Float32Array(W*H)（地表に掛ける雲の影の倍率）, inscatter: Float32Array(W*H*4)（rgb = 霧の光, a = 透過率） }
export function computeAtmosphere(gl, meshes, camera, W, H, atm) {
  const sun = new THREE.Vector3(...atm.sunDir).normalize();

  // ---- 影の地図：太陽の方向から正射影で、見えている物の範囲を撮る ----
  const box = new THREE.Box3();
  for (const m of meshes) if (!m.celestial && !m.noShadow) box.expandByObject(m.object);
  const center = box.getCenter(new THREE.Vector3());
  const radius = box.getSize(new THREE.Vector3()).length() / 2;
  const lightCam = new THREE.OrthographicCamera(-radius, radius, radius, -radius, 0.1, radius * 4);
  lightCam.position.copy(center).addScaledVector(sun, radius * 2);
  lightCam.up.set(0, 1, 0);
  if (Math.abs(sun.y) > 0.99) lightCam.up.set(0, 0, -1);
  lightCam.lookAt(center);
  lightCam.updateMatrixWorld();
  lightCam.updateProjectionMatrix();
  // 世界 → NDC → 0..1
  const toTex = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
  const shadowMatrix = new THREE.Matrix4().multiplyMatrices(toTex, new THREE.Matrix4().multiplyMatrices(lightCam.projectionMatrix, lightCam.matrixWorldInverse));

  const SM = 4096;
  const shadowRT = new THREE.WebGLRenderTarget(SM, SM, { type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
  const shadowScene = new THREE.Scene();
  const dMat = depthMaterial(shadowMatrix);
  const solid = gbufferMaterial(false), sky = gbufferMaterial(true);
  const gScene = new THREE.Scene();
  for (const m of meshes) {
    const src = m.object;
    const mk = (mat) => {
      const c = src.isInstancedMesh ? new THREE.InstancedMesh(src.geometry, mat, src.count) : new THREE.Mesh(src.geometry, mat);
      if (src.isInstancedMesh) c.instanceMatrix = src.instanceMatrix;
      c.matrixAutoUpdate = false;
      c.matrix.copy(src.matrixWorld);
      c.matrixWorld.copy(src.matrixWorld);
      c.frustumCulled = false;
      return c;
    };
    if (!m.celestial && !m.noShadow) shadowScene.add(mk(dMat));
    gScene.add(mk(m.celestial ? sky : solid));
  }

  const prev = gl.getRenderTarget();
  const prevColor = gl.getClearColor(new THREE.Color());
  const prevAlpha = gl.getClearAlpha();
  gl.setClearColor(0x000000, 0);

  gl.setRenderTarget(shadowRT);
  gl.setClearColor(new THREE.Color(2, 0, 0), 1); // 何もない所 = 光源の範囲より遠い
  gl.clear();
  gl.render(shadowScene, lightCam);

  // 画素ごとの距離と向き
  const gRT = new THREE.WebGLRenderTarget(W, H, { type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
  gl.setRenderTarget(gRT);
  gl.setClearColor(0x000000, 0);
  gl.clear();
  gl.render(gScene, camera);

  // ---- 画面全体の計算 ----
  const texelWorld = (2 * radius) / SM;
  const uniforms = {
    gbuf: { value: gRT.texture },
    shadowMap: { value: shadowRT.texture },
    shadowMatrix: { value: shadowMatrix },
    shadowBias: { value: 0 },
    invProj: { value: camera.projectionMatrixInverse.clone() },
    camWorld: { value: camera.matrixWorld.clone() },
    camPos: { value: camera.position.clone() },
    sunDir: { value: sun },
    sunE: { value: new THREE.Vector3(...atm.sunE) },
    skyE: { value: atm.skyE },
    ambient: { value: new THREE.Vector3(...atm.ambient) },
    fogDensity: { value: atm.fog.density },
    fogHeight: { value: atm.fog.height },
    fogBase: { value: atm.fog.base },
    fogG: { value: atm.fog.g },
    maxDist: { value: atm.fog.maxDist },
    mode: { value: 0 },
    cloudScale: { value: atm.clouds.scale },
    cloudCoverage: { value: atm.clouds.coverage },
    cloudDensity: { value: atm.clouds.density },
    cloudElevation: { value: atm.clouds.elevation },
    cloudHrel: { value: atm.clouds.hrel },
    cloudHc: { value: atm.clouds.hc },
  };
  // 影の判定の深さのずれ（光源方向の深さは 0..1 なので、地図 1 画素ぶんの高さの差を許す）
  uniforms.shadowBias.value = (texelWorld * 2.5) / (radius * 4);

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
        uniform vec3 sunDir, sunE, ambient;
        uniform float skyE, fogDensity, fogHeight, fogBase, fogG, maxDist;
        uniform int mode;
        ${CLOUD_GLSL}
        ${SHADOW_GLSL}
        float hash( vec2 p ) { return fract( sin( dot( p, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ); }
        float hg( float c, float g ) { float g2 = g * g; return ( 1.0 - g2 ) / ( 12.566370614 * pow( 1.0 + g2 - 2.0 * g * c, 1.5 ) ); }
        float sigma( float y ) { return fogDensity * exp( - max( 0.0, y - fogBase ) / fogHeight ); }
        void main() {
          vec4 g = texture2D( gbuf, vUv );
          vec4 ndc = vec4( vUv * 2.0 - 1.0, 1.0, 1.0 );
          vec4 v = invProj * ndc; v /= v.w;
          vec3 dir = normalize( ( camWorld * vec4( v.xyz, 0.0 ) ).xyz );

          if ( mode == 1 ) {
            // 地表に掛ける雲の影：日なたの光（直射）の割合だけ、雲の透過率で減らす
            if ( g.a == 0.0 && g.r == 0.0 || g.r < 0.0 ) { gl_FragColor = vec4( 1.0 ); return; }
            vec3 p = camPos + dir * g.r;
            vec3 n = g.gba;
            float ndl = max( 0.0, dot( n, sunDir ) );
            float vis = sunVisible( p + n * 0.5 );
            float direct = dot( sunE, vec3( 0.2126, 0.7152, 0.0722 ) ) * ndl * vis;
            float skyLight = skyE * ( 0.5 + 0.5 * n.y );
            float f = direct / max( 1e-4, direct + skyLight );
            float ct = cloudTransmit( p, sunDir );
            gl_FragColor = vec4( 1.0 - f * ( 1.0 - ct ) );
            return;
          }

          // 霧：カメラから面（空なら maxDist）まで光線を進め、散乱光を足す
          if ( g.r < 0.0 ) { gl_FragColor = vec4( 0.0, 0.0, 0.0, 1.0 ); return; } // 天体は霧を受けない
          float dist = g.r > 0.0 ? g.r : maxDist;
          const int STEPS = 96;
          float j = hash( gl_FragCoord.xy );
          vec3 L = vec3( 0.0 );
          float T = 1.0;
          float phase = mix( 1.0 / 12.566370614, hg( dot( dir, sunDir ), fogG ), 0.8 );
          // 近くを細かく、遠くを粗く刻む（距離の 2 乗で配分）
          float tPrev = 0.0;
          for ( int i = 1; i <= STEPS; i ++ ) {
            float k = ( float( i ) - 1.0 + j ) / float( STEPS );
            float t = dist * k * k;
            float dt = t - tPrev;
            tPrev = t;
            vec3 p = camPos + dir * t;
            float s = sigma( p.y );
            if ( s < 1e-9 ) continue;
            float lit = sunVisible( p ) * cloudTransmit( p, sunDir );
            vec3 inS = sunE * phase * lit + ambient;
            float a = exp( - s * dt );
            L += T * inS * ( 1.0 - a );
            T *= a;
          }
          gl_FragColor = vec4( L, T );
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
  for (const t of [shadowRT, gRT, outRT]) t.dispose();
  dMat.dispose();
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
