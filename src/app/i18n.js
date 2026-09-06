// 最小 i18n。locales/<lang>.json を読み、t(key) で引く。
// 既定言語はブラウザ(WKWebView)の言語→ja/en。設定で上書き可能。

let dict = {};
let fallback = {};
let current = 'ja';

export function detectLang(pref) {
  if (pref === 'ja' || pref === 'en') return pref;
  const nav = (globalThis.navigator?.language || 'ja').toLowerCase();
  return nav.startsWith('ja') ? 'ja' : 'en';
}

export async function loadLocale(lang) {
  current = detectLang(lang);
  const load = async (l) => {
    try {
      const res = await fetch(new URL(`../locales/${l}.json`, import.meta.url));
      return await res.json();
    } catch {
      return {};
    }
  };
  dict = await load(current);
  fallback = current === 'en' ? dict : await load('en');
  document.documentElement.lang = current;
  return current;
}

export function lang() {
  return current;
}

export function t(key, vars) {
  let s = dict[key] ?? fallback[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, v);
  return s;
}

/** data-i18n 属性を持つ要素をまとめて翻訳(textContent / placeholder / title)。 */
export function applyTranslations(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
  root.querySelectorAll('[data-i18n-ph]').forEach((el) => {
    el.setAttribute('placeholder', t(el.getAttribute('data-i18n-ph')));
  });
  root.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.setAttribute('title', t(el.getAttribute('data-i18n-title')));
  });
}
