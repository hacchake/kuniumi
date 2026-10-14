// 物体の模様テクスチャ（色・法線・発光）をメインスレッドの外で作る
import { generateMaterialMaps } from '../core/texgen.js';

self.onmessage = (e) => {
  const { key, material, width, height, image } = e.data;
  try {
    const maps = generateMaterialMaps(material, width, height, image);
    self.postMessage({ key, ...maps }, [maps.color.buffer, maps.normal.buffer, maps.emissive.buffer]);
  } catch (err) {
    self.postMessage({ key, error: String(err?.message ?? err) });
  }
};
