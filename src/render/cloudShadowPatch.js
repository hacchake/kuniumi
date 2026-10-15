import { CLOUD_UNIFORMS_GLSL, CLOUD_FUNCS_GLSL } from './atmosphereGLSL.js';

// リアルタイム表示の素材に「雲の影」を差し込む。
// 太陽の直射（平行光源）の明るさだけを、その点から太陽へ向かって雲を通る量で減らす（空からの光はそのまま）。
// uniform は 1 つの組を全素材で共有するので、値を変えれば全部に効く。

export function createCloudUniforms() {
  return {
    cloudScale: { value: 0.0002 },
    cloudCoverage: { value: 0 },
    cloudDensity: { value: 0.5 },
    cloudElevation: { value: 0.5 },
    cloudBase: { value: 2200 },
    cloudThick: { value: 900 },
    cloudSunDir: { value: null }, // THREE.Vector3
  };
}

// MeshStandardMaterial / MeshPhysicalMaterial に差し込む
export function patchStandardMaterial(material, uniforms) {
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    prev?.call(material, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCloudW;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvCloudW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vCloudW;\nuniform vec3 cloudSunDir;\n${CLOUD_UNIFORMS_GLSL}\n${CLOUD_FUNCS_GLSL}`)
      .replace(
        '#include <lights_fragment_begin>',
        `#include <lights_fragment_begin>
        {
          float cT = cloudShadow( vCloudW, cloudSunDir, 2 );
          reflectedLight.directDiffuse *= cT;
          reflectedLight.directSpecular *= cT;
        }`,
      )
      .replace(
        '#include <dithering_fragment>',
        `#include <dithering_fragment>
        #ifdef KUNIUMI_CELESTIAL
          gl_FragColor.a = 0.0;
        #endif`,
      );
  };
  // 差し込みの有無で別のシェーダとして扱わせる
  const prevKey = material.customProgramCacheKey?.bind(material);
  material.customProgramCacheKey = () => `${prevKey ? prevKey() : ''}|cloudShadow`;
  material.needsUpdate = true;
}

// Three.js の Water（ShaderMaterial）に差し込む
export function patchWaterMaterial(material, uniforms) {
  Object.assign(material.uniforms, uniforms);
  const call = 'sunLight( surfaceNormal, eyeDirection, 100.0, 2.0, 0.5, diffuseLight, specularLight );';
  const pars = '#include <shadowmask_pars_fragment>';
  const fs = material.fragmentShader;
  if (!fs.includes(call) || !fs.includes(pars)) return false;
  material.fragmentShader = fs
    .replace(pars, `${pars}\nuniform vec3 cloudSunDir;\n${CLOUD_UNIFORMS_GLSL}\n${CLOUD_FUNCS_GLSL}`)
    .replace(
      call,
      `${call}
      {
        float cT = cloudShadow( worldPosition.xyz, cloudSunDir, 2 );
        diffuseLight *= cT;
        specularLight *= cT;
      }`,
    );
  material.needsUpdate = true;
  return true;
}
