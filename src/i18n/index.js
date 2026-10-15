import { EN } from './en.js';

// 表示言語。原文（日本語）をそのまま鍵にして、英語のときだけ辞書から引く。
// - 静的な文言・画面に追加された部品の文言は translateDom / watchDom が自動で置き換える
// - 数値などを差し込む文言は t('…{name}…', { name }) で組み立てる

const KEY = 'kuniumi.lang';

function detect() {
  try {
    const saved = globalThis.localStorage?.getItem(KEY);
    if (saved === 'ja' || saved === 'en') return saved;
  } catch {
    // 保存先が使えなくても表示はできる
  }
  const nav = globalThis.navigator?.language ?? 'ja';
  return nav.toLowerCase().startsWith('ja') ? 'ja' : 'en';
}

export const lang = detect();

export function setLang(next) {
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // 保存できなければ今回だけ
  }
}

// 原文 → 表示文。vars があれば {name} を差し込む
export function t(ja, vars) {
  let s = lang === 'en' ? (EN[ja] ?? ja) : ja;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  return s;
}

const ATTRS = ['title', 'aria-label', 'placeholder'];

function translateNode(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    const raw = node.nodeValue;
    const key = raw.trim();
    if (key && EN[key] !== undefined) node.nodeValue = raw.replace(key, EN[key]);
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  for (const a of ATTRS) {
    const v = node.getAttribute(a);
    if (v && EN[v] !== undefined) node.setAttribute(a, EN[v]);
  }
  for (const c of node.childNodes) translateNode(c);
}

// 文書（または一部）を英語に置き換える
export function translateDom(root = document.body) {
  if (lang !== 'en') return;
  translateNode(root);
}

// これから画面に加わる文言も置き換え続ける
export function watchDom(root = document.body) {
  if (lang !== 'en') return;
  new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'childList') m.addedNodes.forEach(translateNode);
      else if (m.type === 'characterData') translateNode(m.target);
      else if (m.type === 'attributes') translateNode(m.target);
    }
  }).observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
}
