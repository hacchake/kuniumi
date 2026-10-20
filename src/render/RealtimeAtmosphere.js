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
      sunScreen: { value: new THREE.Vector3(0, 0, 0) }, // 太陽の画面上の位置（uv）と、カメラの前にあるか（1/0）
      pixel: { value: new THREE.Vector2(1, 1) }, // 1 画素の uv の大きさ
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
      spaceW: { value: 0 }, // 宇宙から眺める度合い（0 = 地上、1 = 宇宙）
      atmoH: { value: 8000 }, // 大気の厚みの目安（スケールハイト）
      atmoTop: { value: 100000 }, // 大気の上端
      starI: { value: 8 }, // 星の明るさ
      nightSky: { value: new THREE.Vector3() }, // 夜空のほのかな明るさ（地平線ほど明るい）
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
        uniform float maxDist, frame, logDepthK, spaceW, atmoH, atmoTop;
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
          vec4 o = vec4( fg.rgb + cl.rgb * fg.a, cl.a * fg.a );
          // 宇宙から眺めるとき：大気の層の厚み（視線が通る空気の量）で、空は黒く・縁は青く光り、地表は青くかすむ
          if ( spaceW > 0.0 && cloudPlanetR > 0.0 ) {
            vec3 so = camPos - kSphereC();
            vec2 T = kSphereT( so, dir, length( so ) - cloudPlanetR, atmoTop );
            float od = 0.0;
            if ( T.x <= T.y && T.y > 0.0 ) {
              float t0 = max( 0.0, T.x ), t1 = sky ? T.y : min( dist, T.y );
              float dt = max( 0.0, t1 - t0 ) / 12.0;
              for ( int i = 0; i < 12; i ++ ) {
                vec3 p = camPos + dir * ( t0 + ( float( i ) + j ) * dt );
                od += exp( - max( 0.0, kAlt( p ) ) / atmoH ) * dt;
              }
            }
            float n = od / atmoH; // 真上を見上げたときの空気の量 = 1
            // 空気の散乱（レイリー）の青。明るさは空の光に合わせる
            vec3 blue = vec3( 0.28, 0.52, 1.0 ) * dot( ambient, vec3( 0.2126, 0.7152, 0.0722 ) ) * 1.6;
            if ( sky ) {
              // 空気の無い方向は真っ暗な宇宙。太陽の円盤は残す
              float keep = max( 1.0 - exp( - n * 0.8 ), smoothstep( 0.99985, 0.99997, dot( dir, sunDir ) ) );
              float k = mix( 1.0, keep, spaceW );
              o = vec4( o.rgb * k + blue * ( 1.0 - exp( - n * 0.25 ) ) * spaceW * 0.7, o.a * k );
            } else {
              float ext = exp( - n * 0.05 );
              o = vec4( o.rgb * mix( 1.0, ext, spaceW ) + blue * ( 1.0 - ext ) * spaceW * 0.6, o.a * mix( 1.0, ext, spaceW ) );
            }
          }
          gl_FragColor = o;
        }`,
    });

    this.compMat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      depthTest: false,
      depthWrite: false,
      vertexShader: vs,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        uniform sampler2D sceneTex, atmTex, depthTex;
        uniform vec2 atmTexel;
        uniform mat4 invProj, camWorld;
        uniform float starI, logDepthK;
        uniform vec3 nightSky, sunDir, sunE, ambient, sunScreen;
        uniform vec2 pixel;
        // 視線方向の距離（対数の深度から）
        float viewDist( vec2 uv ) { return exp2( texture2D( depthTex, uv ).r * logDepthK ) - 1.0; }
        float sHash( vec3 p ) { p = fract( p * 0.3183099 + 0.1 ); p *= 17.0; return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) ); }
        // 天の川：天球の大円（極 MW_POLE）に沿った淡い光の帯。銀河の中心（MW_CENTER）の側ほど明るく太い
        const vec3 MW_POLE = vec3( 0.42, 0.55, -0.72 );
        const vec3 MW_CENTER = vec3( -0.62, 0.2, -0.24 );
        float mwNoise( vec3 p ) {
          vec3 i = floor( p ), f = fract( p );
          f = f * f * ( 3.0 - 2.0 * f );
          return mix( mix( mix( sHash( i ), sHash( i + vec3( 1, 0, 0 ) ), f.x ), mix( sHash( i + vec3( 0, 1, 0 ) ), sHash( i + vec3( 1, 1, 0 ) ), f.x ), f.y ),
                      mix( mix( sHash( i + vec3( 0, 0, 1 ) ), sHash( i + vec3( 1, 0, 1 ) ), f.x ), mix( sHash( i + vec3( 0, 1, 1 ) ), sHash( i + 1.0 ), f.x ), f.y ), f.z );
        }
        float milkyBand( vec3 d ) {
          float lat = dot( d, normalize( MW_POLE ) );
          float core = max( 0.0, dot( d, normalize( MW_CENTER ) ) );
          float w = 0.12 + 0.1 * core; // 帯の太さ
          return exp( - lat * lat / ( w * w ) ) * ( 0.35 + 0.65 * core * core );
        }
        vec3 milkyWay( vec3 d ) {
          float b = milkyBand( d );
          if ( b < 0.01 ) return vec3( 0.0 );
          float n = mwNoise( d * 9.0 ) * 0.55 + mwNoise( d * 23.0 ) * 0.3 + mwNoise( d * 61.0 ) * 0.15;
          // 暗い筋（塵の帯）：帯の中央を走る、まだらな影
          float lat = dot( d, normalize( MW_POLE ) );
          float rift = 1.0 - 0.7 * exp( - pow( ( lat - 0.02 ) / 0.035, 2.0 ) ) * smoothstep( 0.35, 0.65, mwNoise( d * 14.0 + 3.1 ) );
          return vec3( 0.85, 0.82, 0.78 ) * b * ( 0.4 + 0.9 * n * n ) * rift;
        }
        // 星：方向を細かい格子に分け、まれな格子に 1 つずつ点を置く（明るさと色は格子ごとの乱数）
        vec3 stars( vec3 d ) {
          vec3 s = vec3( 0.0 );
          for ( int l = 0; l < 2; l ++ ) {
            float sc = l == 0 ? 180.0 : 520.0;
            vec3 q = d * sc;
            vec3 c = floor( q );
            float h = sHash( c );
            float th = l == 0 ? 0.988 : 0.975 - 0.02 * milkyBand( d ); // 天の川の中は星が多い
            if ( h > th ) {
              vec3 pos = c + vec3( sHash( c + 1.37 ), sHash( c + 2.11 ), sHash( c + 3.73 ) );
              float dd = length( q - pos );
              float b = pow( ( h - th ) / ( 1.0 - th ), 3.0 ) * ( l == 0 ? 1.0 : 0.35 );
              float tint = sHash( c + 7.7 );
              s += mix( vec3( 1.0, 0.78, 0.6 ), vec3( 0.7, 0.82, 1.0 ), tint ) * b * exp( - dd * dd * 30.0 );
            }
          }
          return s;
        }
        void main() {
          vec4 c = texture2D( sceneTex, vUv );
          // 半分の解像度の計算結果を、少しぼかして拾う（ざらつきを均す）
          vec4 a = texture2D( atmTex, vUv ) * 0.4
            + texture2D( atmTex, vUv + vec2( atmTexel.x, 0.0 ) ) * 0.15 + texture2D( atmTex, vUv - vec2( atmTexel.x, 0.0 ) ) * 0.15
            + texture2D( atmTex, vUv + vec2( 0.0, atmTexel.y ) ) * 0.15 + texture2D( atmTex, vUv - vec2( 0.0, atmTexel.y ) ) * 0.15;
          vec4 vv = invProj * vec4( vUv * 2.0 - 1.0, -1.0, 1.0 ); vv /= vv.w;
          vec3 dirV = normalize( ( camWorld * vec4( vv.xyz, 0.0 ) ).xyz );
          float dC = texture2D( depthTex, vUv ).r;
          // くぼみの陰：周りの画素が手前にあるほど（谷・岩の割れ目・木の根もと）少し暗く。
          // 遠すぎる差（物の輪郭の向こう側）は数えない
          float ao = 1.0;
          if ( dC < 0.99999 && c.a > 0.5 ) {
            float w0 = viewDist( vUv ), occ = 0.0;
            for ( int i = 0; i < 8; i ++ ) {
              float ang = float( i ) * 0.7853982 + 0.39;
              for ( int r = 0; r < 2; r ++ ) {
                vec2 o = vec2( cos( ang ), sin( ang ) ) * ( r == 0 ? 5.0 : 14.0 ) * pixel;
                float wn = viewDist( vUv + o );
                float dd = ( w0 - wn ) / w0;
                occ += clamp( dd * 6.0, 0.0, 1.0 ) * ( 1.0 - smoothstep( 0.06, 0.15, dd ) );
              }
            }
            ao = 1.0 - clamp( occ / 16.0 * 1.3, 0.0, 0.45 );
          }
          vec3 col = c.rgb * ao * a.a + a.rgb;
          // 天体：手前の空気越しに見える（空の明るさを重ね、空気の厚みのぶん暗く）。昼は淡く、夜はくっきり
          if ( c.a < 0.5 ) col = c.rgb * exp( - 0.12 / max( 0.06, dirV.y + 0.04 ) ) + ambient * 0.2;
          // 太陽のまぶしさ（光のにじみ）：太陽が見えている（山に隠れていない）ときだけ
          if ( sunScreen.z > 0.5 ) {
            float vis = 0.0;
            for ( int i = 0; i < 5; i ++ ) {
              vec2 o = i == 0 ? vec2( 0.0 ) : vec2( cos( float( i ) * 1.5708 ), sin( float( i ) * 1.5708 ) ) * 6.0 * pixel;
              vis += texture2D( depthTex, sunScreen.xy + o ).r >= 0.99999 ? 0.2 : 0.0;
            }
            // 雲や霧に隠れているほど弱く（太陽の向きの光の通りやすさ）
            vis *= texture2D( atmTex, sunScreen.xy ).a;
            float cs = max( dot( dirV, sunDir ), 0.0 );
            col += sunE * vis * ( 0.01 * pow( cs, 1500.0 ) + 0.0012 * pow( cs, 90.0 ) + 0.00015 * pow( cs, 8.0 ) );
          }
          // 空が暗いとき（夜・宇宙）だけ星が見える
          if ( starI > 0.0 && texture2D( depthTex, vUv ).r >= 0.99999 && c.a > 0.5 ) {
            vec4 v = invProj * vec4( vUv * 2.0 - 1.0, -1.0, 1.0 ); v /= v.w;
            vec3 d = normalize( ( camWorld * vec4( v.xyz, 0.0 ) ).xyz );
            float lum = dot( col, vec3( 0.2126, 0.7152, 0.0722 ) );
            col += ( stars( d ) + milkyWay( d ) * 0.07 ) * starI * exp( - lum * 6.0 );
            col += nightSky * a.a * ( 0.35 + 0.65 * ( 1.0 - clamp( d.y, 0.0, 1.0 ) ) );
          }
          gl_FragColor = vec4( col, 1.0 );
          #include <tonemapping_fragment>
          // 仕上げ：彩りを少し強め、四隅をわずかに暗く（写真のレンズの周辺減光の近似）
          gl_FragColor.rgb = max( mix( vec3( dot( gl_FragColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) ) ), gl_FragColor.rgb, 1.1 ), 0.0 );
          gl_FragColor.rgb *= 1.0 - 0.2 * smoothstep( 0.4, 1.0, length( ( vUv - 0.5 ) * vec2( 1.3, 1.0 ) ) * 1.4 );
          #include <colorspace_fragment>
        }`,
    });

    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.marchMat);
    this.quad.frustumCulled = false;
    // 画面の明るさを測る（自動露出用）：重ね合わせた後・トーンマップ前の明るさの対数を 16×16 に縮めて読む
    this.lumRT = new THREE.WebGLRenderTarget(16, 16, { type: THREE.FloatType });
    this.lumMat = new THREE.ShaderMaterial({
      uniforms: { sceneTex: this.uniforms.sceneTex, atmTex: this.uniforms.atmTex, exposure: { value: 1 } },
      depthTest: false,
      depthWrite: false,
      vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D sceneTex, atmTex;
        uniform float exposure;
        void main() {
          // 区画の中の 4 点の平均（ちらつきを抑える）
          float s = 0.0;
          for ( int i = 0; i < 4; i ++ ) {
            vec2 o = vec2( float( i % 2 ), float( i / 2 ) ) * 0.5 - 0.25;
            vec2 uv = vUv + o / 16.0;
            vec4 c = texture2D( sceneTex, uv ), a = texture2D( atmTex, uv );
            vec3 col = c.rgb * a.a + a.rgb;
            s += log( 1e-4 + dot( col, vec3( 0.2126, 0.7152, 0.0722 ) ) * exposure );
          }
          gl_FragColor = vec4( s * 0.25, 0.0, 0.0, 1.0 );
        }`,
    });
    this.lumPx = new Float32Array(16 * 16 * 4);
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

  // 画面の明るさの対数平均（露出 exposure を掛けた値）。直前の render の結果から測る
  measureKey(exposure) {
    const gl = this.gl;
    this.lumMat.uniforms.exposure.value = exposure;
    const prev = this.quad.material;
    this.quad.material = this.lumMat;
    gl.setRenderTarget(this.lumRT);
    gl.render(this.fsScene, this.fsCam);
    gl.setRenderTarget(null);
    this.quad.material = prev;
    gl.readRenderTargetPixels(this.lumRT, 0, 0, 16, 16, this.lumPx);
    let s = 0;
    for (let i = 0; i < 256; i++) s += this.lumPx[i * 4];
    return Math.exp(s / 256);
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
    // 太陽の画面上の位置（まぶしさを出す・山に隠れているか見る）
    const sv = u.sunDir.value.clone().transformDirection(camera.matrixWorldInverse);
    if (sv.z < 0) {
      const p = u.sunDir.value.clone().multiplyScalar(1e6).add(camera.position).project(camera);
      u.sunScreen.value.set(p.x * 0.5 + 0.5, p.y * 0.5 + 0.5, Math.abs(p.x) < 1.3 && Math.abs(p.y) < 1.3 ? 1 : 0);
    } else u.sunScreen.value.z = 0;
    u.pixel.value.set(1 / Math.max(1, this.size.x), 1 / Math.max(1, this.size.y));

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
