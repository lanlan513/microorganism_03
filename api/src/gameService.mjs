import { randomUUID } from 'node:crypto';
import {
  CHAMBERS,
  EXHIBITS,
  MAX_OFFLINE_MS,
  RESOURCE_KEYS,
  civilizationLevel,
  createInitialState,
  cumulativeProducts,
  previewProduction,
  settle as engineSettle,
  unlockExhibit as engineUnlockExhibit,
  upgradeChamber as engineUpgradeChamber,
} from '../../shared/engine.mjs';
import { createGameClock } from './clock.mjs';
import { loadSave, saveSave } from './store.mjs';

const games = new Map();
const chains = new Map();

function enqueue(userId, task) {
  if (!chains.has(userId)) chains.set(userId, Promise.resolve());
  const previous = chains.get(userId);
  const run = previous.then(() => task());
  chains.set(userId, run.then(() => {}, () => {}));
  return run;
}

function publicView(game, includeProductionMs = 0) {
  const currentTick = game.clock.tick;
  const liveElapsed = Math.max(0, currentTick - game.state.lastSettledTick) + includeProductionMs;
  const preview = previewProduction(game.state, liveElapsed);
  const balances = { ...game.state.balances };
  for (const [key, delta] of Object.entries(preview.changes)) balances[key] += delta;
  return {
    tick: currentTick + includeProductionMs,
    lastSettledTick: game.state.lastSettledTick,
    online: game.clock.onlineState,
    maxOfflineMs: MAX_OFFLINE_MS,
    balances,
    totalsProduced: game.state.totalsProduced,
    chambers: game.state.chambers,
    chamberDefs: CHAMBERS,
    exhibits: EXHIBITS,
    unlockedExhibits: game.state.exhibits,
    cumulativeProducts: cumulativeProducts({ ...game.state, balances }),
    stability: game.state.stability,
    civilizationLevel: civilizationLevel(game.state),
    ledgerCount: game.ledger.length,
    lastEntryHash: game.ledger[game.ledger.length - 1].hash,
    pendingLiveMs: liveElapsed,
    clockEvents: game.clock.events,
    migration: {
      ...(game.migration || {}),
      pendingOfflineMs: game.clock.pendingOfflineMs,
    },
  };
}

export async function getGame(userId = 'demo') {
  if (games.has(userId)) return games.get(userId);
  return enqueue(userId, async () => {
    if (games.has(userId)) return games.get(userId);
    const loaded = await loadSave(userId, Date.now());
    const clock = createGameClock({
      startTick: loaded.state.tick,
      lastWallAt: loaded.state.lastWallAt,
    });
    const restart = clock.restartFrom({
      savedTick: loaded.state.tick,
      savedWallAt: loaded.state.lastWallAt,
    });
    loaded.state.tick = restart.tick;
    const game = {
      userId,
      state: loaded.state,
      ledger: loaded.ledger,
      clock,
      file: loaded.file,
      backup: loaded.backup,
      migration: {
        migratedFrom: loaded.migratedFrom ?? null,
        restoredFromBackup: loaded.restoredFromBackup ?? false,
        migrationRolledBack: loaded.migrationRolledBack ?? false,
        replacedCorruptSave: loaded.replacedCorruptSave ?? false,
        error: loaded.migrationError || loaded.corruption || null,
        pendingOfflineMs: restart.offlineMs,
        restartWallDelta: restart.wallDelta,
      },
    };
    games.set(userId, game);
    return game;
  });
}

export async function viewGame(userId) {
  const game = await getGame(userId);
  return enqueue(userId, async () => publicView(game));
}

async function persist(game, at = Date.now()) {
  game.state.tick = game.state.lastSettledTick;
  game.state.lastWallAt = at;
  game.state.online = game.clock.onlineState;
  game.state.lastHeartbeatAt = game.clock.lastHeartbeatWall;
  await saveSave({ file: game.file, backup: game.backup }, game.state, ledgerFor(game), at);
}

function ledgerFor(game) {
  return game.ledger;
}

async function settleThroughNow(game, ref, reason) {
  game.clock.heartbeat();
  const now = game.clock.wallNow();
  const elapsedMs = Math.max(0, Math.floor(game.clock.tick - game.state.lastSettledTick));
  const existing = ref ? game.ledger.find((e) => e.ref === ref && e.type === 'settle') : null;
  if (existing) {
    return { duplicate: true, entry: existing, elapsedMs: 0, now };
  }
  if (elapsedMs <= 0) return { duplicate: false, entry: null, elapsedMs: 0, now, noop: true };
  // 亚秒级操作不制造空流水；下次心跳/结算会合并这段时间。
  if (elapsedMs < 1000) return { duplicate: false, entry: null, elapsedMs, now, noop: true };
  const result = engineSettle(game.state, game.ledger, { now, elapsedMs, reason, ref });
  game.clock.settleAt(game.state.lastSettledTick);
  return { ...result, elapsedMs, now };
}

export async function heartbeat(userId) {
  await getGame(userId);
  return enqueue(userId, async () => {
    const game = await getGame(userId);
    const pending = Math.max(0, Math.floor(game.clock.tick - game.state.lastSettledTick));
    if (pending > 0) {
      const result = await settleThroughNow(game, `heartbeat-restart-${game.state.lastSettledTick}-${pending}`, '重连后离线结算');
      await persist(game, result.now);
    } else {
      const beat = game.clock.heartbeat();
      await persist(game, beat.now);
    }
    return publicView(game, 0);
  });
}

export async function settleGame(userId, payload = {}) {
  await getGame(userId);
  return enqueue(userId, async () => {
    const game = await getGame(userId);
    const ref = payload.ref || `settle_${randomUUID()}`;
    const existing = game.ledger.find((e) => e.ref === ref && e.type === 'settle');
    if (existing) {
      return {
        ...publicView(game),
        receipt: { ref, duplicate: true, entryId: existing.id, elapsedMs: 0, changes: existing.changes },
      };
    }
    const result = await settleThroughNow(game, ref, '服务端心跳结算');
    if (!result.noop) await persist(game, result.now);
    return {
      ...publicView(game),
      receipt: {
        ref,
        duplicate: false,
        entryId: result.entry?.id || null,
        elapsedMs: result.elapsedMs,
        changes: result.entry?.changes || null,
        noop: result.noop || false,
      },
    };
  });
}

export async function mutateGame(userId, action, payload = {}) {
  await getGame(userId);
  return enqueue(userId, async () => {
    const game = await getGame(userId);
    const ref = payload.ref || `${action}_${randomUUID()}`;
    const existing = game.ledger.find((e) => e.ref === ref && ['upgrade', 'unlock'].includes(e.type));
    if (existing) {
      return {
        ...publicView(game),
        receipt: { ref, action, duplicate: true, entryId: existing.id, changes: existing.changes },
      };
    }

    const beforeRef = `pre_${ref}`;
    const before = await settleThroughNow(game, beforeRef, '操作前自动结算');
    const now = before.now;

    let result;
    if (action === 'upgrade') {
      result = engineUpgradeChamber(game.state, game.ledger, { chamberId: payload.chamberId, now, ref });
    } else if (action === 'unlock') {
      result = engineUnlockExhibit(game.state, game.ledger, { exhibitId: payload.exhibitId, now, ref });
    } else {
      const err = new Error('未知操作');
      err.status = 400;
      throw err;
    }

    await persist(game, now);
    return {
      ...publicView(game),
      receipt: { ref, action, duplicate: result.duplicate, entryId: result.entry.id, changes: result.entry.changes },
    };
  });
}

export async function getLedger(userId, { limit = 100, offset = 0 } = {}) {
  const game = await getGame(userId);
  return enqueue(userId, async () => {
    const start = Math.max(0, Number(offset) || 0);
    const size = Math.min(500, Math.max(1, Number(limit) || 100));
    return {
      total: game.ledger.length,
      entries: game.ledger.slice(start, start + size),
      verifiedSum: Object.fromEntries(
        RESOURCE_KEYS.map((key) => [key, game.ledger.reduce((sum, e) => sum + (e.changes[key] || 0), 0)]),
      ),
      lastHash: game.ledger[game.ledger.length - 1].hash,
    };
  });
}

export async function resetGame(userId = 'demo') {
  const now = Date.now();
  const { state, ledger } = createInitialState(now);
  const old = games.get(userId);
  const clock = createGameClock({ startTick: 0, lastWallAt: now });
  clock.heartbeat();
  const game = {
    userId,
    state,
    ledger,
    clock,
    file: old?.file,
    backup: old?.backup,
    migration: { reset: true },
  };
  if (!game.file || !game.backup) {
    const loaded = await loadSave(userId, now);
    game.file = loaded.file;
    game.backup = loaded.backup;
    games.set(userId, game);
  } else {
    games.set(userId, game);
  }
  return enqueue(userId, async () => {
    await persist(game, now);
    return publicView(game);
  });
}
