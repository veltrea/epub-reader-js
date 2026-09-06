// 読み上げのスリープタイマー。
//
// 「あと何分で止める」という経過時間で指定する(就寝前に使うものなので、時刻を数えさせない)。
// 満了したら `onExpire`(＝読み上げの停止)を必ず呼び、続けて `action` の追加動作を行う。
//
// シャットダウンだけは**猶予のカウントダウン**を挟む。寝落ちしていなければ取り消せる。
// 残り時間は「締め切りの時刻」から毎回引き直す(タイマーの刻みを足し込まない)ので、
// 発火が遅れたりウィンドウ操作で刻みが飛んでも、止まる時刻はずれない。
//
// DOM にも Tauri にも依らない(時計と電源操作を注入する)ので単体で検証できる。

/** 選べる時間(分)。カスタム入力もできる。 */
export const PRESET_MINUTES = [15, 30, 45, 60, 90, 120];

/** シャットダウン実行前の猶予(秒)。 */
export const SHUTDOWN_GRACE = 30;

/**
 * 満了時の動作。
 * 「読み上げを停止」だけは必ず行う(タイマーの本体)。スリープ／シャットダウンはその後に
 * 続けて実行する追加動作という位置付けなので、排他の 3 択にしてある。
 */
export const ACTIONS = ['stopOnly', 'sleepSystem', 'shutdown'];

export function normalizeAction(a) {
  return ACTIONS.includes(a) ? a : 'stopOnly';
}

/** 残り時間の表示("m:ss" / 1 時間以上なら "h:mm:ss")。 */
export function formatRemaining(seconds) {
  const total = Math.max(0, Math.ceil(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export class SleepTimer {
  /**
   * @param {object} opts
   * @param {() => number} [opts.now] 現在時刻(ms)
   * @param {() => void} [opts.onExpire] 満了時の停止処理(読み上げの停止)
   * @param {{sleepNow:()=>any, shutdown:()=>any}} [opts.power] 電源操作(テストでは記録だけの実装)
   * @param {(a:string)=>void} [opts.onActionChange] 選んだ動作を覚えるための通知
   * @param {(m:number)=>void} [opts.onMinutesChange] 指定した分を覚えるための通知
   * @param {() => void} [opts.onChange] 表示更新の通知
   */
  constructor({ now = () => Date.now(), onExpire = null, power = recordingPower(),
    action = 'stopOnly', minutes = 30,
    onActionChange = null, onMinutesChange = null, onChange = null } = {}) {
    this._now = now;
    this.onExpire = onExpire;
    this.power = power;
    this.action = normalizeAction(action);
    this.lastMinutes = Math.max(1, minutes | 0) || 30;
    this._onActionChange = onActionChange;
    this._onMinutesChange = onMinutesChange;
    this._onChange = onChange;
    this.deadline = null;          // 稼働中なら締め切り。停止中は null
    this.remaining = 0;            // 締め切りまでの残り秒
    this.shutdownCountdown = null; // 猶予カウントダウン中ならその残り秒
    this._shutdownDeadline = null;
    this._ticker = null;
  }

  /** 稼働中(締め切り待ち、または猶予中)か。 */
  get isActive() { return this.deadline != null || this.shutdownCountdown != null; }

  get remainingText() { return this.deadline == null ? '' : formatRemaining(this.remaining); }

  setAction(a) {
    const v = normalizeAction(a);
    if (v === this.action) return v;
    this.action = v;
    this._onActionChange?.(v);
    this._changed();
    return v;
  }

  /** タイマーを開始する(稼働中なら締め切りを引き直す)。 */
  start(minutes = this.lastMinutes) {
    const m = Math.max(1, Math.round(minutes) || 0) || 1;
    this.lastMinutes = m;
    this._onMinutesChange?.(m);
    this.cancelShutdownCountdown();
    this.deadline = this._now() + m * 60000;
    this.remaining = m * 60;
    this._startTicker();
    this._changed();
    return m;
  }

  /** 秒単位で締め切りを引き直す(テスト用。分より短い時間で満了まで通したいとき)。 */
  startForTest(seconds) {
    this.cancelShutdownCountdown();
    this.deadline = this._now() + seconds * 1000;
    this.remaining = seconds;
    this._startTicker();
    this._changed();
  }

  /** 締め切りを延長する(稼働していなければ何もしない)。 */
  extend(minutes) {
    if (this.deadline == null) return false;
    this.deadline += minutes * 60000;
    this.tick();
    return true;
  }

  /** タイマーを解除する(猶予カウントダウン中ならそれも取り消す)。 */
  cancel() {
    this.deadline = null;
    this.remaining = 0;
    this.cancelShutdownCountdown();
    this._stopTickerIfIdle();
    this._changed();
  }

  /** シャットダウンの猶予を取り消す(電源操作は行わない)。 */
  cancelShutdownCountdown() {
    if (this.shutdownCountdown == null) return false;
    this.shutdownCountdown = null;
    this._shutdownDeadline = null;
    this._stopTickerIfIdle();
    this._changed();
    return true;
  }

  /** 猶予を待たずにシャットダウンする。 */
  shutdownNow() {
    this.shutdownCountdown = null;
    this._shutdownDeadline = null;
    this._stopTickerIfIdle();
    this.power.shutdown();
    this._changed();
  }

  /**
   * 締め切りだけを取り出す(画面をまたいで引き継ぐ用)。
   * 残り秒ではなく**締め切りの時刻**を渡すので、遷移に何秒かかっても止まる時刻はずれない。
   */
  snapshot() {
    return { deadline: this.deadline, shutdownDeadline: this._shutdownDeadline };
  }

  /**
   * `snapshot()` の値から復元する。**既に過ぎている締め切りは捨てる**——
   * 復元した瞬間に満了してスリープ/シャットダウンが走る、という事故を防ぐ。
   * @returns {boolean} 復元して稼働状態になったか
   */
  restore({ deadline = null, shutdownDeadline = null } = {}) {
    const now = this._now();
    if (typeof deadline === 'number' && deadline > now) {
      this.deadline = deadline;
      this.remaining = (deadline - now) / 1000;
      this._startTicker();
    }
    if (typeof shutdownDeadline === 'number' && shutdownDeadline > now) {
      this._shutdownDeadline = shutdownDeadline;
      this.shutdownCountdown = (shutdownDeadline - now) / 1000;
      this._startTicker();
    }
    this._changed();
    return this.isActive;
  }

  /** いま満了させる(テスト用)。 */
  fireNow() {
    if (this.deadline == null) return;
    this.deadline = this._now();
    this.tick();
  }

  tick() {
    const now = this._now();
    if (this.deadline != null) {
      this.remaining = Math.max(0, (this.deadline - now) / 1000);
      if (this.remaining <= 0) {
        this.deadline = null;
        this.remaining = 0;
        this._expire();
      }
    }
    if (this._shutdownDeadline != null) {
      const left = (this._shutdownDeadline - now) / 1000;
      this.shutdownCountdown = Math.max(0, left);
      if (left <= 0) { this.shutdownNow(); return; }
    }
    this._stopTickerIfIdle();
    this._changed();
  }

  /** 満了。停止処理を必ず行い、続けて追加動作へ進む。 */
  _expire() {
    this.onExpire?.();
    if (this.action === 'sleepSystem') {
      this.power.sleepNow();
    } else if (this.action === 'shutdown') {
      // 寝落ちしていなければ取り消せるよう、猶予を挟む。
      this._shutdownDeadline = this._now() + SHUTDOWN_GRACE * 1000;
      this.shutdownCountdown = SHUTDOWN_GRACE;
      this._startTicker();
    }
  }

  _startTicker() {
    if (this._ticker != null || typeof setInterval !== 'function') return;
    this._ticker = setInterval(() => this.tick(), 500);
  }

  _stopTickerIfIdle() {
    if (this.deadline == null && this._shutdownDeadline == null && this._ticker != null) {
      clearInterval(this._ticker);
      this._ticker = null;
    }
  }

  _changed() { this._onChange?.(this); }
}

/** 電源操作を実行せず、要求だけを記録する実装(テスト・ブラウザ検証用)。 */
export function recordingPower() {
  const rec = {
    lastRequest: null,
    sleepNow() { rec.lastRequest = 'sleep'; return true; },
    shutdown() { rec.lastRequest = 'shutdown'; return true; },
    reset() { rec.lastRequest = null; },
  };
  return rec;
}
