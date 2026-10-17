// 静止画用の細かい地形（四分木）をメインスレッドの外で作る
import { buildLodTerrain } from '../core/terrainLod.js';
import { decodePng } from '../core/png16.js';
import { decodePhoto } from '../io/photo.js';

self.onmessage = async (e) => {
  const { terrain, water, view, maxTriangles, vegetation, place, refField } = e.data;
  try {
    // ハイトマップ地形は画像を解釈して渡す（16bit のまま）
    let heightmapImage = null;
    if (terrain.mode === 'heightmap' && terrain.heightmap?.png) {
      heightmapImage = await decodePng(await (await fetch(terrain.heightmap.png)).arrayBuffer());
      if (!heightmapImage) throw new Error('このPNG形式は読めません');
    }
    // 地球から取り込んだ地形の衛星写真（写真の色を使う設定のとき）
    let photo = null;
    if (heightmapImage && terrain.photo !== false && terrain.heightmap?.photo) photo = await decodePhoto(terrain.heightmap.photo).catch(() => null);
    const r = buildLodTerrain(terrain, water, view, {
      maxTriangles,
      vegetation,
      heightmapImage,
      photo,
      place,
      refField,
      onProgress: (p) => self.postMessage({ progress: p }),
    });
    const transfer = [r.positions.buffer, r.normals.buffer, r.colors.buffer, r.uvs.buffer, r.index.buffer];
    if (r.plants) transfer.push(r.plants.conifer.buffer, r.plants.broadleaf.buffer, r.plants.grass.buffer);
    self.postMessage({ result: r }, transfer);
  } catch (err) {
    self.postMessage({ error: String(err?.message ?? err) });
  }
};
