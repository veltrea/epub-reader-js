// 自動ページ送り。指定した秒数ごとに 1 ページ進める。
//
// 締め切りの持ち方は sleeptimer.js と同じで、「次に送る時刻」から毎回残りを引き直す
// (刻みを足し込まない)。0.5 秒刻みの発火が遅れても、送る間隔は指定どおりに保たれる。
//
// 止める条件は 3 つ:
//   - 読み手が止めたとき
//   - 本の終わりに着いたとき(送っても位置が動かない ＝ これ以上進めない)
//   - 本を閉じたとき(送る相手がいなくなる)
//
// 読み上げ中は**止めずに見送る**。読み上げは文の切れ目で自分でページを送るので、
// ここからも送ると 1 ページ飛ばしになる。読み上げが終われば自動送りはそのまま続く。
//
// DOM に依らない(時計と送る相手を注入する)ので、`tick()` を直接呼んで単体で検証できる。

/** 選べる間隔(秒)。カスタム入力もできる。 */
export const PRESET_SECONDS = [10, 15, 20, 30, 45, 60, 90];

/** 終端と見なす位置。ここより手前で位置が動かなかった場合は、描画待ちとみなして止めない。 */
export const END_THRESHOLD = 0.95;

/** ページを送ってから位置(fraction)が届くまで待つ時間(ms)。relocate は遅れて来る。 */
export const ADVANCE_SETTLE_MS = 700;

export class AutoPager {
  /**
   * @param {object} opts
   * @param {() => object|null} opts.target 送る相手を返す(開いている本が変わるので毎回引き直す)。
   *   相手は { isSpeaking(): boolean, progression(): number, advance(): Promise, note(text) }。
   * @param {() => number} [opts.now] 現在時刻(ms)。テストから差し替える。
   * @param {(ms:number)=>Promise} [opts.sleep] 待ち。テストから差し替える。
   * @param {number} [opts.seconds] 直前に指定した間隔(秒)。
   * @param {(s:number)=>void} [opts.onSecondsChange] 間隔を覚えるための通知。
   * @param {() => void} [opts.onChange] 表示更新の通知。
   */
  constructor({ target, now = () => Date.now(), sleep = defaultSleep, seconds = 30,
    onSecondsChange = null, onChange = null } = {}) {
    this._target = target || (() => null);
    this._now = now;
    this._sleep = sleep;
    this.seconds = Math.max(1, seconds | 0) || 30;
    this._onSecondsChange = onSecondsChange;
    this._onChange = onChange;
    this.deadline = null;   // 稼働中なら次に送る時刻。停止中は null
    this.remaining = 0;     // 次に送るまでの残り秒
    this.isHolding = false; // 読み上げ中で送るのを見送っているか
    this._advancing = false;
    this._ticker = null;
  }

  get isRunning() { return this.deadline != null; }

  /** 残り時間の表示("12" のような整数秒)。停止中は空文字。 */
  get remainingText() {
    return this.isRunning ? String(Math.max(0, Math.ceil(this.remaining))) : '';
  }

  /** 自動送りを開始する(稼働中なら間隔を差し替えて数え直す)。 */
  start(seconds = this.seconds) {
    const s = Math.max(1, Math.round(seconds) || 0) || 1;
    if (s !== this.seconds) { this.seconds = s; this._onSecondsChange?.(s); }
    else this._onSecondsChange?.(s);
    this._restart();
    this._startTicker();
    this._changed();
    return s;
  }

  stop() {
    if (!this.isRunning) return false;
    this._finish();
    this._changed();
    return true;
  }

  toggle() {
    if (this.isRunning) { this.stop(); return false; }
    this.start();
    return true;
  }

  /**
   * 手動でページを送った／位置を飛ばしたときの数え直し。
   * 自分で送った直後にすぐ自動送りが来ると 2 ページ飛ぶので、間隔を頭から数え直す。
   */
  noteManualTurn() {
    if (!this.isRunning) return;
    this._restart();
    this._changed();
  }

  /** いま送る(テスト用。締め切りを現在に引き寄せる)。 */
  fireNow() {
    if (!this.isRunning) return;
    this.deadline = this._now();
    return this.tick();
  }

  /**
   * 0.5 秒ごとの刻み。テストからは直接呼ぶ。
   * @returns {?Promise} ページ送りが走ったときだけ、その完了を待てる Promise
   */
  tick() {
    if (this.deadline == null) return null;
    const target = this._target();
    if (!target) {          // 送る相手がいない(本を閉じた)なら止める
      this._finish();
      this._changed();
      return null;
    }
    // 読み上げ中は見送る。締め切りを先送りするので、読み上げが終わったところから
    // まる 1 間隔ぶん数え直す(読み上げ終了の直後にいきなり送られない)。
    if (target.isSpeaking()) {
      this.isHolding = true;
      this.deadline = this._now() + this.seconds * 1000;
      this.remaining = this.seconds;
      this._changed();
      return null;
    }
    this.isHolding = false;
    this.remaining = Math.max(0, (this.deadline - this._now()) / 1000);
    this._changed();
    if (this.remaining > 0) return null;
    this._restart();
    return this._advance(target);
  }

  /** 1 ページ送り、送れたかを位置で確かめる。 */
  async _advance(target) {
    if (this._advancing) return;   // 前の送りがまだ終わっていない
    this._advancing = true;
    try {
      const before = target.progression();
      await target.advance();
      // 位置は relocate で遅れて届く。送った直後はまだ前の値なので待つ。
      await this._sleep(ADVANCE_SETTLE_MS);
      if (!this.isRunning) return;
      // 送っても位置が動かない＝これ以上進めない。終端付近に限って止める
      // (途中で動かないのは描画待ちのことがあるので、そこでは止めない)。
      if (target.progression() === before && before >= END_THRESHOLD) {
        this._finish();
        target.note?.('end');
        this._changed();
      }
    } finally {
      this._advancing = false;
    }
  }

  _restart() {
    this.deadline = this._now() + this.seconds * 1000;
    this.remaining = this.seconds;
    this.isHolding = false;
  }

  _finish() {
    this.deadline = null;
    this.remaining = 0;
    this.isHolding = false;
    this._stopTicker();
  }

  _startTicker() {
    if (this._ticker != null || typeof setInterval !== 'function') return;
    this._ticker = setInterval(() => this.tick(), 500);
  }

  _stopTicker() {
    if (this._ticker != null) { clearInterval(this._ticker); this._ticker = null; }
  }

  _changed() { this._onChange?.(this); }
}

function defaultSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
