// 元に戻す／やり直す。ストアの変更を見張り、変更前のシーンを積んでおく。
// シーンは不変更新なので、積むのは参照だけで済む（大きなハイトマップも共有される）。
//
// - スライダーを動かし続けたような「同じ項目への短い間隔の変更」は 1 回分にまとめる
// - 視点（カメラ）の移動は履歴に入れない。戻すときも今の視点はそのまま
const LIMIT = 100;
const MERGE_MS = 600;

export function createHistory(store, { onChange } = {}) {
  const past = [];
  const future = [];
  let last = store.get();
  let lastKey = '';
  let lastTime = 0;
  let applying = false;

  store.subscribe((state, changed, meta) => {
    const prev = last;
    last = state;
    if (applying) return;
    // 自動保存からの復元など、元に戻す対象にしない変更
    if (meta.history === false) return;
    if (changed.every((p) => p === 'camera' || p.startsWith('camera.'))) return;
    const key = `${meta.source ?? ''}|${changed.join(',')}`;
    const now = performance.now();
    // 同じ項目を続けて動かしている間は、最初の変更前だけを残す
    if (!(key === lastKey && now - lastTime < MERGE_MS && past.length)) {
      past.push(prev);
      if (past.length > LIMIT) past.shift();
    }
    lastKey = key;
    lastTime = now;
    future.length = 0;
    onChange?.();
  });

  const apply = (target) => {
    applying = true;
    // 視点は今のまま
    store.replace({ ...target, camera: store.get().camera }, { source: 'history' });
    applying = false;
    last = store.get();
    lastKey = '';
    onChange?.();
  };

  return {
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
    undo() {
      if (!past.length) return false;
      future.push(store.get());
      apply(past.pop());
      return true;
    },
    redo() {
      if (!future.length) return false;
      past.push(store.get());
      apply(future.pop());
      return true;
    },
    // 一区切り（次の変更を前とまとめない）
    mark() {
      lastKey = '';
    },
  };
}
