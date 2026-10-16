import * as THREE from 'three';
import { CLOUD_UNIFORMS_GLSL, CLOUD_FUNCS_GLSL, CLOUD_MARCH_GLSL, FOG_MARCH_GLSL } from './atmosphereGLSL.js';
import { SHADOW_GLSL, buildSunShadowMap } from './atmospherePass.js';

// リアルタイム表示の「空気」：一枚絵と同じ式の雲（厚みのある立体）と霧（光の筋つき）を、軽くして毎フレーム描く。
//   1. シーンを HDR のまま画面外に描く（深度つき）
//   2. 半分の解像度で、各画素の光線に沿って雲と霧を計算する（歩数を減らし、ゆらぎで粗さを散らす）
//   3. 元の解像度で重ね合わせ、トーンマップして画面へ
// 影の地図（地形・物体が太陽を遮るか）は、地形や太陽が変わったときだけ作り直す。

export class RealtimeAtmosphere {
  constructor(renderer) {
    this.gl = renderer;
    this.enabled = true;
    this.shadow = null;
    this.size = new THREE.Vector2(1, 1);

    this.sceneRT = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      samples: 4,
      depthTexture: new THREE.DepthTexture(1, 1, THREE.FloatType),
    });
    this.atmRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });

    this.uniforms = {
      depthTex: { value: this.sceneRT.depthTexture },
      sceneTex: { value: this.sceneRT.texture },
      atmTex: { value: this.atmRT.texture },
      invProj: { value: new THREE.Matrix4() },
      camWorld: { value: new THREE.Matrix4() },
      camPos: { value: new THREE.Vector3() },
      sunDir: { value: new THREE.Vector3(0, 1, 0) },
      sunE: { value: new THREE.Vector3() },
      ambient: { value: new THREE.Vector3() },
      maxDist: { value: 60000 },
      frame: { value: 0 },
      atmTexel: { value: new THREE.Vector2(1, 1) },
      shadowMap: { value: null },
      shadowMatrix: { value: new THREE.Matrix4() },
      shadowBias: { value: 0 },
      hasShadow: { value: 0 },
      cloudScale: { value: 0.0002 },
      cloudCoverage: { value: 0 },
      cloudDensity: { value: 0.5 },
      cloudElevation: { value: 0.5 },
      cloudBase: { value: 2200 },
      cloudThick: { value: 900 },
      fogDensity: { value: 0 },
      fogHeight: { value: 900 },
      fogBase: { value: 0 },
      fogG: { value: 0.6 },
      logDepthK: { value: Math.log2(1e8 + 1) }, // 対数深度：log2(far + 1)
      cloudOrigin: { value: new THREE.Vector2() },
      cloudPlanetR: { value: 0 },
      cloudCam: { value: new THREE.Vector3() },
    };

    const vs = /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }`;
    this.marchMat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      depthTest: false,
      depthWrite: false,
      vertexShader: vs,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D depthTex, sceneTex;
        uniform mat4 invProj, camWorld;
        uniform vec3 camPos, sunDir, sunE, ambient;
        uniform float maxDist, frame, logDepthK;
        uniform int hasShadow;
        ${CLOUD_UNIFORMS_GLSL}
        ${CLOUD_FUNCS_GLSL}
        ${SHADOW_GLSL}
        // 雲の影は雲を描く距離まで（それより遠くは模様が細かすぎて粒になる）
        float lit( vec3 p ) { return ( hasShadow == 1 ? sunVisible( p ) : 1.0 ) * ( distance( p, camPos ) < CLOUD_FAR ? cloudShadow( p, sunDir, 1 ) : 1.0 ); }
        ${FOG_MARCH_GLSL}
        ${CLOUD_MARCH_GLSL}
        // 画素ごとのゆらぎ（Interleaved Gradient Noise）。歩数の少なさによる縞を目立たないざらつきにする
        float ign( vec2 p ) { return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) ); }
        void main() {
          // 深度は対数（何千 km 先まで精度を保つため）。視線方向の距離 w に戻してから位置を出す
          float depth = texture2D( depthTex, vUv ).r;
          float w = exp2( depth * logDepthK ) - 1.0;
          vec4 v = invProj * vec4( vUv * 2.0 - 1.0, -1.0, 1.0 ); v /= v.w; // 手前の面の点（奥の面は遠すぎて精度が出ない）
          vec3 vp = v.xyz * ( w / max( 1e-6, - v.z ) );
          vec3 wp = ( camWorld * vec4( vp, 1.0 ) ).xyz;
          vec3 dir = normalize( wp - camPos );
          bool sky = depth >= 0.99999;
          // かすみを受けない天体（色の a = 0 で印を付けてある）
          if ( texture2D( sceneTex, vUv ).a < 0.5 ) { gl_FragColor = vec4( 0.0, 0.0, 0.0, 1.0 ); return; }
          float dist = sky ? maxDist : distance( wp, camPos );
          float j = ign( gl_FragCoord.xy + frame * 5.588238 );
          vec4 cl = marchClouds( camPos, dir, sky ? 1e9 : dist, sunDir, sunE, ambient * 1.4, 28, 3, j );
          float tc = sky ? ( dir.y > 0.01 ? ( cloudBase - camPos.y ) / dir.y : maxDist ) : dist;
          float far = 1.0 - exp( - max( 0.0, tc ) / 70000.0 );
          cl.rgb = mix( cl.rgb, ambient * ( 1.0 - cl.a ), far );
          vec4 fg = marchFog( camPos, dir, dist, sunDir, sunE, ambient, 20, j );
          gl_FragColor = vec4( fg.rgb + cl.rgb * fg.a, cl.a * fg.a );
        }`,
    });

    this.compMat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      depthTest: false,
      depthWrite: false,
      vertexShader: vs,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        uniform sampler2D sceneTex, atmTex;
        uniform vec2 atmTexel;
        void main() {
          vec4 c = texture2D( sceneTex, vUv );
          // 半分の解像度の計算結果を、少しぼかして拾う（ざらつきを均す）
          vec4 a = texture2D( atmTex, vUv ) * 0.4
            + texture2D( atmTex, vUv + vec2( atmTexel.x, 0.0 ) ) * 0.15 + texture2D( atmTex, vUv - vec2( atmTexel.x, 0.0 ) ) * 0.15
            + texture2D( atmTex, vUv + vec2( 0.0, atmTexel.y ) ) * 0.15 + texture2D( atmTex, vUv - vec2( 0.0, atmTexel.y ) ) * 0.15;
          gl_FragColor = vec4( c.rgb * a.a + a.rgb, 1.0 );
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });

    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.marchMat);
    this.quad.frustumCulled = false;
    this.fsScene = new THREE.Scene();
    this.fsScene.add(this.quad);
    this.fsCam = new THREE.OrthographicCamera();
  }

  setSize(w, h) {
    if (this.size.x === w && this.size.y === h) return;
    this.size.set(w, h);
    this.sceneRT.setSize(w, h);
    const aw = Math.max(1, Math.round(w / 2)), ah = Math.max(1, Math.round(h / 2));
    this.atmRT.setSize(aw, ah);
    this.uniforms.atmTexel.value.set(1 / aw, 1 / ah);
  }

  // atm: { sunDir, sunE, ambient, fog:{density,height,base,g,maxDist}, clouds:{coverage,density,scale,elevation,base,thickness} }
  // 描く座標の原点（世界座標の x, z）、星の半径（0 = 平ら）、曲げの中心（描く座標の x, z）
  setView(origin, planetR, center) {
    this.uniforms.cloudOrigin.value.copy(origin);
    this.uniforms.cloudPlanetR.value = planetR;
    this.uniforms.cloudCam.value.set(center.x, 0, center.y);
  }

  setParams(atm) {
    const u = this.uniforms;
    u.sunDir.value.set(...atm.sunDir).normalize();
    u.sunE.value.set(...atm.sunE);
    u.ambient.value.set(...atm.ambient);
    u.maxDist.value = atm.fog.maxDist;
    u.fogDensity.value = atm.fog.density;
    u.fogHeight.value = atm.fog.height;
    u.fogBase.value = atm.fog.base;
    u.fogG.value = atm.fog.g;
    u.cloudScale.value = atm.clouds.scale;
    u.cloudCoverage.value = atm.clouds.coverage;
    u.cloudDensity.value = atm.clouds.density;
    u.cloudElevation.value = atm.clouds.elevation;
    u.cloudBase.value = atm.clouds.base;
    u.cloudThick.value = atm.clouds.thickness;
  }

  // 影の地図を作り直す（地形・物体・太陽が変わったとき）
  // bounds: { center, radius } 地図にする範囲（カメラの周り）
  updateShadow(objects, sunDir, bounds = null) {
    this.shadow?.dispose();
    this.shadow = objects.length ? buildSunShadowMap(this.gl, objects, sunDir, 2048, bounds) : null;
    const u = this.uniforms;
    u.hasShadow.value = this.shadow ? 1 : 0;
    if (this.shadow) {
      u.shadowMap.value = this.shadow.texture;
      u.shadowMatrix.value.copy(this.shadow.matrix);
      u.shadowBias.value = this.shadow.bias;
    }
  }

  render(scene, camera) {
    const gl = this.gl;
    const u = this.uniforms;
    camera.updateMatrixWorld();
    u.logDepthK.value = Math.log2(camera.far + 1);
    u.invProj.value.copy(camera.projectionMatrixInverse);
    u.camWorld.value.copy(camera.matrixWorld);
    u.camPos.value.copy(camera.position);
    u.frame.value = (u.frame.value + 1) % 64;

    gl.setRenderTarget(this.sceneRT);
    gl.render(scene, camera);

    this.quad.material = this.marchMat;
    gl.setRenderTarget(this.atmRT);
    gl.render(this.fsScene, this.fsCam);

    this.quad.material = this.compMat;
    gl.setRenderTarget(null);
    gl.render(this.fsScene, this.fsCam);
  }
}
