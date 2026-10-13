import { setIn } from './schema.js';

// シーンを一か所で持つ小さなストア。UI はここへ書き、描画側はここを購読する。
// meta.source で「誰が変えたか」を伝え、カメラ操作のような自己由来の変更を描画側が無視できるようにする。
export function createStore(initial) {
  let state = initial;
  const subs = new Set();

  const emit = (changed, meta) => {
    for (const fn of subs) fn(state, changed, meta);
  };

  return {
    get: () => state,
    set(path, value, meta = {}) {
      state = setIn(state, path, value);
      emit([path], meta);
    },
    // { 'sun.elevation': 10, 'water.level': 5 } のようにまとめて変更
    patch(changes, meta = {}) {
      for (const [p, v] of Object.entries(changes)) state = setIn(state, p, v);
      emit(Object.keys(changes), meta);
    },
    replace(next, meta = {}) {
      state = next;
      emit(['*'], meta);
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}
