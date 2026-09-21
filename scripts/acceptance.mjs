#!/usr/bin/env node
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_OFFLINE_MS,
  assertLedger,
  createInitialState,
  previewProduction,
  replayLedger,
  settle,
  upgradeChamber,
} from '../shared/engine.mjs';
import { createGameClock } from '../api/src/clock.mjs';

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail });
  const icon = condition ? 'PASS' : 'FAIL';
  console.log(`${icon}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!condition) process.exitCode = 1;
}

const tempDir = mkdtempSync(path.join(os.tmpdir(), 'civilization-acceptance-'));
process.env.CIV_DATA_DIR = path.join(tempDir, 'data');
const { loadSave, writeLegacyV2ForTest } = await import('../api/src/store.mjs');

function cloneStateLedger(now = 0) {
  const fresh = createInitialState(now);
  return {
    state: structuredClone(fresh.state),
    ledger: structuredClone(fresh.ledger),
  };
}

function makeVirtualClock({ startWall = 1_000_000, startTick = 0 } = {}) {
  let wall = startWall;
  let perf = 0;
  const clock = createGameClock({
    startTick,
    lastWallAt: startWall,
    dateNow: () => wall,
    perfNow: () => perf,
  });
  return {
    clock,
    advanceWall(ms) { wall += ms; },
    rewindWall(ms) { wall -= ms; },
    advancePerf(ms) { perf += ms; },
    wall: () => wall,
  };
}

function settleAt({ state, ledger }, elapsedMs, ref, reason = '验收结算') {
  return settle(state, ledger, {
    now: 1_000_000 + state.tick,
    elapsedMs,
    reason,
    ref,
  });
}

function sums(ledger) {
  const totals = { carbon: 0, nitrogen: 0, methane: 0, alcohol: 0, antibiotic: 0 };
  for (const entry of ledger) {
    for (const key of Object.keys(totals)) totals[key] += entry.changes[key] || 0;
  }
  return totals;
}

// 1. 在线时把“系统时间”往后拨一天，收益只看 monotonic elapsed，不许变。
{
  const game = cloneStateLedger(1_000_000);
  const virtual = makeVirtualClock({ startWall: 1_000_000 });
  virtual.clock.heartbeat();
  virtual.advancePerf(2_000); // 真实经过 2 秒
  virtual.advanceWall(24 * 60 * 60 * 1000); // 墙上时钟被改到明天
  const elapsedAfterForward = virtual.clock.tick;

  const before = previewProduction(game.state, elapsedAfterForward).changes;
  settleAt(game, elapsedAfterForward, 'clock-forward-once');
  const afterForward = sums(game.ledger);

  virtual.clock.heartbeat();
  virtual.advancePerf(2_000);
  virtual.rewindWall(24 * 60 * 60 * 1000 + 1_000); // 再拨回去
  virtual.clock.heartbeat(); // 下一次服务端请求读到被回拨的墙上时钟
  const elapsedAfterBack = virtual.clock.tick;
  settleAt(game, elapsedAfterBack - game.state.lastSettledTick, 'clock-back-once');
  const afterBack = sums(game.ledger);

  check('系统时间往后调一天，在线收益仍只按 2 秒计算', elapsedAfterForward === 2000, `elapsed=${elapsedAfterForward}ms`);
  check('未来时钟没有产出一天甲烷', afterForward.methane === 4, `methane=${afterForward.methane}, expect=4`);
  check('时钟往回拨不产生负收益或重复收益', afterBack.methane === 8, `methane=${afterBack.methane}, expect=8`);
  check('时钟回拨被服务端记录为 clock event', virtual.clock.events.some((e) => e.type === 'wall-rewind'), `${virtual.clock.events.length} events`);
  assertLedger(game.ledger);
}

// 2. 离线时长硬上限：服务重启后 3 天，只给 8 小时。
{
  const saved = cloneStateLedger(1_000_000);
  saved.state.tick = 0;
  saved.state.lastWallAt = 1_000_000;
  let wall = 1_000_000 + 3 * 24 * 60 * 60 * 1000;
  let perf = 0;
  const clock = createGameClock({
    startTick: saved.state.tick,
    lastWallAt: saved.state.lastWallAt,
    dateNow: () => wall,
    perfNow: () => perf,
  });
  const restart = clock.restartFrom({ savedTick: 0, savedWallAt: 1_000_000 });
  settle(saved.state, saved.ledger, { now: wall, elapsedMs: restart.offlineMs, reason: '离线三天', ref: 'offline-cap' });
  check('离线 3 天只按 8 小时入账', restart.offlineMs === MAX_OFFLINE_MS, `offline=${restart.offlineMs}, cap=${MAX_OFFLINE_MS}`);
  check('8 小时热泉舱甲烷为 57600', sums(saved.ledger).methane === 2 * 8 * 3600, `methane=${sums(saved.ledger).methane}`);

  // 重启时系统时钟反而早于存档时间：不得离线收益。
  wall = 900_000;
  const rewindRestart = createGameClock({
    startTick: 0,
    lastWallAt: 1_000_000,
    dateNow: () => wall,
    perfNow: () => perf,
  }).restartFrom({ savedTick: 0, savedWallAt: 1_000_000 });
  check('系统时钟被往回拨，重启离线收益为 0', rewindRestart.offlineMs === 0, `offline=${rewindRestart.offlineMs}`);
}

// 3. 同一次结算凭证提交两遍，只入账一次。
{
  const game = cloneStateLedger();
  const ref = 'receipt-duplicate-proof';
  const first = settleAt(game, 5000, ref);
  const ledgerCountAfterFirst = game.ledger.length;
  const methaneAfterFirst = sums(game.ledger).methane;
  const second = settleAt(game, 5000, ref);
  check('同一 ref 第一次结算生效', first.duplicate === false && game.ledger.length === ledgerCountAfterFirst, `entry=${first.entry.id}`);
  check('同一 ref 第二次返回 duplicate，账本不新增条目', second.duplicate === true && game.ledger.length === ledgerCountAfterFirst, `entries=${game.ledger.length}`);
  check('同一 ref 第二遍资源不重复入账', sums(game.ledger).methane === methaneAfterFirst, `methane=${methaneAfterFirst}`);
  check('两次返回同一张条目凭证', first.entry.id === second.entry.id, `${first.entry.id}`);
}

// 4. 两个标签页并发提交升级；服务端串行化，结果等价于某个单序列调度。
{
  const serial = cloneStateLedger();
  const concurrent = cloneStateLedger();
  const actionByTab = [
    ...Array.from({ length: 5 }, (_, i) => ({ tab: 'A', chamberId: 'hotSpring', ref: `tab-A-${i}` })),
    ...Array.from({ length: 5 }, (_, i) => ({ tab: 'B', chamberId: 'gut', ref: `tab-B-${i}` })),
  ];
  settleAt(serial, 2000, 'seed-serial');
  settleAt(concurrent, 2000, 'seed-concurrent');
  serial.state.chambers.gut.unlocked = true;
  concurrent.state.chambers.gut.unlocked = true;

  // 单序列：A 的 5 次全部完成后，再执行 B 的 5 次。
  for (const action of actionByTab) {
    upgradeChamber(serial.state, serial.ledger, {
      chamberId: action.chamberId,
      now: 1_000_000,
      ref: action.ref,
    });
  }

  // 双标签页：请求交错到达。HTTP 服务还有用户级 FIFO 互斥；这里验证所有结果有唯一串行序。
  const interleaved = [
    actionByTab[0], actionByTab[5], actionByTab[1], actionByTab[6],
    actionByTab[2], actionByTab[7], actionByTab[3], actionByTab[8],
    actionByTab[4], actionByTab[9],
  ];
  await Promise.all(interleaved.map(
    (action, index) => new Promise((resolve) => setTimeout(() => resolve(upgradeChamber(concurrent.state, concurrent.ledger, {
      chamberId: action.chamberId,
      now: 1_000_000,
      ref: action.ref,
    })), index === 0 ? 1 : 0)),
  ));
  assertLedger(concurrent.ledger);
  const serialTotals = sums(serial.ledger);
  const concurrentTotals = sums(concurrent.ledger);
  check('两标签页交错 10 次后的总碳氮/产物等于单序列结果', JSON.stringify(serialTotals) === JSON.stringify(concurrentTotals), `concurrent=${JSON.stringify(concurrentTotals)}`);
  check('并发后热泉执行 5 次升级、肠道执行 5 次升级', concurrent.state.chambers.hotSpring.level === 6 && concurrent.state.chambers.gut.level === 5, `levels=${concurrent.state.chambers.hotSpring.level}/${concurrent.state.chambers.gut.level}`);
  const replayed = replayLedger(concurrent.ledger);
  check('从账本唯一真源重放，余额与物化缓存一致', JSON.stringify(replayed.balances) === JSON.stringify(concurrent.state.balances), `replayed=${JSON.stringify(replayed.balances)}`);
}

// 5. 版本迁移失败时退回上一份可用存档。
{
  const good = cloneStateLedger(1_000_000);
  good.state.balances.methane = 123;
  const goodFile = path.join(tempDir, 'data', 'civilization-migration-good.json');
  const legacyFile = path.join(tempDir, 'data', 'civilization-migration-bad.json');
  const { writeFile, mkdir } = await import('node:fs/promises');
  await mkdir(path.dirname(goodFile), { recursive: true });
  await writeFile(goodFile, JSON.stringify({ version: 3, savedAt: 1_000_000, data: good }));
  // v2 合法，但带强制失败标记；迁移前会先备份 v2，回退后当前文件保持可重新迁移。
  await writeLegacyV2ForTest(legacyFile, { state: good.state, ledger: good.ledger }, 1_000_000);
  const raw = await import('node:fs/promises').then((fs) => fs.readFile(legacyFile, 'utf8'));
  const envelope = JSON.parse(raw);
  envelope.forceMigrationFailure = true;
  await writeFile(legacyFile, JSON.stringify(envelope));
  let failed = null;
  let loaded = null;
  try {
    loaded = await loadSave('migration-bad', 2_000_000);
  } catch (err) {
    failed = err;
  }
  // 本演示没有 v3 备份，因此明确失败而不是吞掉；预置 v3 的用户会恢复上一份。
  check('坏迁移不会静默覆盖存档', Boolean(failed), failed?.message || '');
  const secondRaw = JSON.parse(await import('node:fs/promises').then((fs) => fs.readFile(legacyFile, 'utf8')));
  check('失败后原 v2 存档仍在，可在修复后重试', secondRaw.version === 2 && secondRaw.forceMigrationFailure === true, `version=${secondRaw.version}`);

  // 已有上一份 v3：新迁移失败时恢复 .bak 中的当前版本。
  const recoverFile = path.join(tempDir, 'data', 'civilization-recover.json');
  const recoverBackup = `${recoverFile}.bak`;
  const brokenV3 = {
    version: 2,
    savedAt: 1_000_000,
    forceMigrationFailure: true,
    data: { state: good.state, ledger: good.ledger },
  };
  await writeFile(recoverFile, JSON.stringify(brokenV3));
  await writeFile(recoverBackup, JSON.stringify({ version: 3, savedAt: 1_000_000, data: good }));
  const restored = await loadSave('recover', 2_000_000);
  check('旧版本迁移失败时恢复上一份可用 v3 存档', restored.migrationRolledBack === true && restored.restoredFromBackup === true && restored.state.balances.methane === 123, `methane=${restored.state.balances.methane}`);
}

// 6. 账本真源：任何缓存余额都必须能由流水逐笔重放得到。
{
  const game = cloneStateLedger();
  settleAt(game, 10_000, 'audit-1');
  upgradeChamber(game.state, game.ledger, { chamberId: 'hotSpring', now: 1_000_000, ref: 'audit-up' });
  settleAt(game, 20_000, 'audit-2');
  const replayed = replayLedger(game.ledger);
  const same = JSON.stringify(replayed.balances) === JSON.stringify(game.state.balances) &&
    replayed.chambers.hotSpring.level === game.state.chambers.hotSpring.level;
  check('最终验收：余额、舱室等级全部可从 append-only 账本重放', same, JSON.stringify(game.state.balances));
}

rmSync(tempDir, { recursive: true, force: true });
const failedCount = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failedCount}/${results.length} passed`);
if (failedCount) process.exitCode = 1;
