// 画面をまたいで生き続けるスリープタイマー。
//
// **なぜ要るか**: 書棚とリーダーは別ページ(`location.href` の遷移)なので、素朴に `new` すると
// 書棚へ戻った瞬間にタイマーのインスタンスごと消える。プロトタイプ(Swift 版)は AppModel が
// 持っていて、本を閉じてもタイマーは走り続ける。「走っているタイマーを、書棚へ戻ってから
// 解除したい」という使い方があるので、そちらに合わせる。
//
// **やり方**: 締め切りの「時刻」だけを sessionStorage に預け、遷移先で引き直す。
// SleepTimer は元から締め切りの時刻から残りを計算する設計なので、これで足りる。
//
// **なぜ sessionStorage か**: 窓を閉じる(=アプリ終了)と一緒に消えてほしいため。
// 就寝前に掛けたタイマーが翌日の起動で生き返って Mac をスリープさせる、という事故を防ぐ。
// (それでも保険として `SleepTimer.restore()` は過ぎた締め切りを捨てる。)

import { SleepTimer } from './sleeptimer.js';

const KEY = 'sleepTimer.session';

function loadSnapshot() {
  try { return JSON.parse(sessionStorage.getItem(KEY)) || null; } catch { return null; }
}

function saveSnapshot(timer) {
  try {
    const s = timer.snapshot();
    if (s.deadline == null && s.shutdownDeadline == null) sessionStorage.removeItem(KEY);
    else sessionStorage.setItem(KEY, JSON.stringify(s));
  } catch { /* プライベートモード等で書けなくても、その画面の中では普通に動く */ }
}

/**
 * 画面をまたいで引き継がれる SleepTimer を作る。
 * 引数は SleepTimer と同じ。`onChange` は表示更新に使われるので、保存と両方呼ぶ。
 */
export function createSharedSleepTimer(opts = {}) {
  const { onChange, ...rest } = opts;
  const timer = new SleepTimer({
    ...rest,
    onChange: (t) => { saveSnapshot(t); onChange?.(t); },
  });
  timer.restore(loadSnapshot() || {});
  return timer;
}

/** 引き継ぎを捨てる(タイマーを完全に畳むとき)。 */
export function clearSharedSleepTimer() {
  try { sessionStorage.removeItem(KEY); } catch { /* 無視 */ }
}

/**
 * 実際に電源を触る実装(リーダーと書棚で共通)。
 * 何を要求したかは残しておく——テストバスから「本当に要求したか」を確かめられるように。
 */
export function systemPower(api) {
  return {
    lastRequest: null,
    sleepNow() { this.lastRequest = 'sleep'; void api.systemSleep(); return true; },
    shutdown() { this.lastRequest = 'shutdown'; void api.systemShutdown(); return true; },
  };
}
