import { describe, it, expect } from 'vitest';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// すべてのソースが構文として正しいか（描画器・ワーカーなど、ほかのテストで読み込まないファイルも含めて）
function files(dir) {
  const out = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

describe('構文', () => {
  it('src のすべての .js が構文として正しい', () => {
    const bad = [];
    for (const f of files('src')) {
      const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
      if (r.status !== 0) bad.push(`${f}: ${r.stderr.split('\n').find((l) => /Error/.test(l))}`);
    }
    expect(bad).toEqual([]);
  }, 60000);
});
