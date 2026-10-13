import { normalizeScene } from '../core/schema.js';

export function sceneToJSON(scene) {
  const out = structuredClone(scene);
  out.meta.modified = new Date().toISOString();
  return JSON.stringify(out, null, 2);
}

export async function sceneFromFile(file) {
  const text = await file.text();
  return normalizeScene(JSON.parse(text));
}
