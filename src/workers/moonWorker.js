// 月面図（core/moonMap.js）をメインスレッドの外で作る（数秒かかるので、画面を止めないように）
import { moonMap } from '../core/moonMap.js';

const m = moonMap();
self.postMessage({ W: m.W, H: m.H, albedo: m.albedo, height: m.height });
