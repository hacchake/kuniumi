import * as THREE from 'three';
import { CURVE_GLSL } from './curvatureGLSL.js';

// カメラを中心にした水面の円盤（XY 平面。Water は rotation.x = −90° で水平にする）。
// 近くは細かく、外へ行くほど粗い同心円にして、足元から地平線の先までを少ない頂点で覆う
export function createWaterDisc(maxR) {
  const SEG = 160;
  const radii = [0];
  for (let r = 1.5; r < maxR; r *= 1.09) radii.push(r);
  radii.push(maxR);
  const pos = new Float32Array((1 + (radii.length - 1) * SEG) * 3);
  let v = 1;
  for (let k = 1; k < radii.length; k++) {
    for (let i = 0; i < SEG; i++, v++) {
      const a = (i / SEG) * Math.PI * 2;
      pos[v * 3] = Math.cos(a) * radii[k];
      pos[v * 3 + 1] = Math.sin(a) * radii[k];
    }
  }
  const index = [];
  for (let i = 0; i < SEG; i++) index.push(0, 1 + i, 1 + ((i + 1) % SEG));
  for (let k = 1; k < radii.length - 1; k++) {
    const a0 = 1 + (k - 1) * SEG, b0 = 1 + k * SEG;
    for (let i = 0; i < SEG; i++) {
      const i1 = (i + 1) % SEG;
      index.push(a0 + i, b0 + i, b0 + i1, a0 + i, b0 + i1, a0 + i1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const nrm = new Float32Array(pos.length);
  for (let i = 2; i < nrm.length; i += 3) nrm[i] = 1;
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setIndex(index);
  return g;
}

// Water の頂点を星の丸みにそって曲げ、波の模様は世界座標（原点を足し戻した座標）で引く
export function curveWater(material, curveUniforms, origin) {
  Object.assign(material.uniforms, curveUniforms, { kWaterOrigin: { value: origin }, kWaterLevel: { value: 0 } });
  const vs = material.vertexShader;
  const body = /mirrorCoord = modelMatrix \* vec4\( position, 1\.0 \);[\s\S]*?vec4 mvPosition =\s*modelViewMatrix \* vec4\( position, 1\.0 \);/;
  if (!body.test(vs)) return false;
  material.vertexShader = vs.replace('#include <common>', `#include <common>\n${CURVE_GLSL}\nvarying vec3 vKFlat;`).replace(
    body,
    `vec4 kWP = modelMatrix * vec4( position, 1.0 );
    // 星を一周しきらない所で止める（円盤が裏側へ回り込まないように）
    if ( kPlanetR > 0.0 ) {
      vec2 kr = kWP.xz - kCenter; float kd = length( kr ), km = 3.14159 * kPlanetR * 0.999;
      if ( kd > km ) kWP.xz = kCenter + kr * ( km / kd );
    }
    vKFlat = kWP.xyz;
    kWP.xyz = kCurve( kWP.xyz );
    worldPosition = kWP;
    mirrorCoord = textureMatrix * kWP;
    vec4 mvPosition = viewMatrix * kWP;`,
  );
  // 波の向きは平らな地図の上で作ってから、丸みの分だけ傾ける。
  // 遠くの波は画素より細かくなり白い粒になるので、遠いほど滑らかな水面へ寄せる
  const noiseLine = /vec4 noise = getNoise\( worldPosition\.xz \* size \);\s*vec3 surfaceNormal = normalize\( noise\.xzy \* vec3\( 1\.5, 1\.0, 1\.5 \) \);/;
  material.fragmentShader = material.fragmentShader
    .replace('uniform sampler2D mirrorSampler;', `uniform sampler2D mirrorSampler;\nuniform vec2 kWaterOrigin;\nuniform float kWaterLevel;\nvarying vec3 vKFlat;\n${CURVE_GLSL}`)
    // 丸い星では、水面の三角形（弦）は本当の球面より内側にたわむ。遠くでは数百 m になり、海岸と前後を取り違えて縞になる。
    // そこで画素ごとに視線と海の球面の交点を求め、その深さを書く
    .replace(
      '#include <logdepthbuf_fragment>',
      `#include <logdepthbuf_fragment>
      #if defined( USE_LOGARITHMIC_DEPTH_BUFFER )
      if ( kPlanetR > 0.0 ) {
        vec3 kRd = normalize( worldPosition.xyz - eye );
        vec3 kO = eye - vec3( kCenter.x, - kPlanetR, kCenter.y );
        float kAltO = length( kO ) - kPlanetR;
        float kB = dot( kO, kRd );
        float kC = ( kAltO - kWaterLevel ) * ( 2.0 * kPlanetR + kAltO + kWaterLevel );
        float kDisc = kB * kB - kC;
        // 遠くの地形は粗い三角形（弦）なので、本当の高さより少し沈む。
        // 低い海岸が水に沈んで見えないよう、遠いほど水面もその分だけ下げる（地形の頂点の間隔 ≒ 距離 / 118）
        if ( kDisc >= 0.0 ) {
          float kL = ( - kB - sqrt( kDisc ) ) / 118.0;
          float kA = kWaterLevel - kL * kL / ( 4.0 * kPlanetR );
          kC = ( kAltO - kA ) * ( 2.0 * kPlanetR + kAltO + kA );
          kDisc = kB * kB - kC;
        }
        if ( kDisc >= 0.0 ) {
          float kT = - kB - sqrt( kDisc );
          if ( kT > 0.0 ) {
            float kW = - ( viewMatrix * vec4( eye + kRd * kT, 1.0 ) ).z;
            gl_FragDepth = log2( 1.0 + kW ) * logDepthBufFC * 0.5;
          }
        }
      }
      #endif`,
    )
    .replace(
      noiseLine,
      `vec4 noise = getNoise( ( vKFlat.xz + kWaterOrigin ) * size );
      float kFar = smoothstep( 3000.0, 80000.0, length( eye - worldPosition.xyz ) );
      vec3 surfaceNormal = normalize( mix( normalize( noise.xzy * vec3( 1.5, 1.0, 1.5 ) ), vec3( 0.0, 1.0, 0.0 ), kFar ) );
      surfaceNormal = kCurveN( vKFlat, surfaceNormal );`,
    );
  material.needsUpdate = true;
  return true;
}
