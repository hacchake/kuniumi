// ブラウザでのファイル保存・読み込みの小道具

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function pickFile(accept) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files[0] ?? null);
    input.click();
  });
}

export function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

// ファイル名に使えない文字を除く
export function safeName(name) {
  return (name || 'kuniumi').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60);
}

export function extOf(file) {
  return file.name.split('.').pop().toLowerCase();
}
