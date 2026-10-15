// 静止画用の細かい地形（四分木）をメインスレッドの外で作る
import { buildLodTerrain } from '../core/terrainLod.js';

self.onmessage = (e) => {
  const { terrain, water, view, maxTriangles } = e.data;
  try {
    const r = buildLodTerrain(terrain, water, view, {
      maxTriangles,
      onProgress: (p) => self.postMessage({ progress: p }),
    });
    self.postMessage({ result: r }, [r.positions.buffer, r.normals.buffer, r.colors.buffer, r.uvs.buffer, r.index.buffer]);
  } catch (err) {
    self.postMessage({ error: String(err?.message ?? err) });
  }
};
