import { MAX_OFFLINE_MS, OFFLINE_GRACE_MS } from '../../shared/engine.mjs';

// 游戏时间只从 monotonic clock 累加；墙上时钟只用于显示和“冷启动是否离线”的判定。
// 在线时 Date 被拨到明天不会改变 tick；时钟回拨会被记录为 clock event。
export function createGameClock({
  startTick = 0,
  lastWallAt = Date.now(),
  dateNow = () => Date.now(),
  perfNow = () => globalThis.performance.now(),
} = {}) {
  let baseTick = Math.max(0, startTick);
  let anchorPerf = perfNow();
  let online = false;
  let pendingOfflineMs = 0;
  let lastHeartbeatWall = null;
  let lastKnownWall = Math.max(0, lastWallAt);
  const events = [];

  function wallNow() {
    const now = dateNow();
    if (now < lastKnownWall) events.push({ type: 'wall-rewind', from: lastKnownWall, to: now, at: now });
    lastKnownWall = Math.max(lastKnownWall, now);
    return now;
  }

  function heartbeat() {
    const now = wallNow();
    if (!online) {
      anchorPerf = perfNow();
      online = true;
      events.push({ type: 'resume', at: now, previousHeartbeat: lastHeartbeatWall });
    }
    lastHeartbeatWall = now;
    return { now, tick: baseTick + pendingOfflineMs + (online ? perfNow() - anchorPerf : 0) };
  }

  function settleAt(lastSettledTick) {
    baseTick = Math.max(0, lastSettledTick);
    pendingOfflineMs = 0;
    anchorPerf = perfNow();
    online = true;
    lastHeartbeatWall = wallNow();
  }

  return {
    get tick() {
      return baseTick + pendingOfflineMs + (online ? perfNow() - anchorPerf : 0);
    },
    get onlineState() {
      return online;
    },
    get pendingOfflineMs() {
      return pendingOfflineMs;
    },
    get lastHeartbeatWall() {
      return lastHeartbeatWall;
    },
    get events() {
      return events.slice();
    },
    heartbeat,
    settleAt,
    restartFrom({ savedTick, savedWallAt }) {
      const now = wallNow();
      const wallDelta = now - savedWallAt;
      pendingOfflineMs = 0;
      if (wallDelta > OFFLINE_GRACE_MS) pendingOfflineMs = Math.min(wallDelta, MAX_OFFLINE_MS);
      if (wallDelta < 0) events.push({ type: 'restart-wall-rewind', from: savedWallAt, to: now });
      baseTick = savedTick;
      anchorPerf = perfNow();
      online = false;
      lastHeartbeatWall = null;
      events.push({ type: 'restart', wallDelta, offlineMs: pendingOfflineMs, at: now });
      return { now, offlineMs: pendingOfflineMs, wallDelta, tick: this.tick };
    },
    wallNow,
  };
}
