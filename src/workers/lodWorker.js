// 静止画用の細かい地形（四分木）をメインスレッドの外で作る
import { buildLodTerrain } from '../core/terrainLod.js';

self.onmessage = (e) => {
  const { terrain, water, view, maxTriangles, vegetation } = e.data;
  try {
    const r = buildLodTerrain(terrain, water, view, {
      maxTriangles,
      vegetation,
      onProgress: (p) => self.postMessage({ progress: p }),
    });
    const transfer = [r.positions.buffer, r.normals.buffer, r.colors.buffer, r.uvs.buffer, r.index.buffer];
    if (r.plants) transfer.push(r.plants.conifer.buffer, r.plants.broadleaf.buffer, r.plants.grass.buffer);
    self.postMessage({ result: r }, transfer);
  } catch (err) {
    self.postMessage({ error: String(err?.message ?? err) });
  }
};
