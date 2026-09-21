process.env.NODE_ENV = 'test';
process.env.GAME_DATA_DIR = `${process.cwd()}/.game-data-acceptance`;

import assert from 'node:assert/strict';
import { readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { RESOURCES } from '../shared/civilization.js';
import { setClockOffset } from '../api/src/game/clock.js';
import { gameService } from '../api/src/game/gameService.js';
import { saveStore } from '../api/src/game/saveStore.js';
import { MigrationError } from '../api/src/game/migrations.js';

rmSync(process.env.GAME_DATA_DIR!, { recursive: true, force: true });

function key(prefix: string, index: number) {
  return `${prefix}-${String(index).padStart(2, '0')}-${Math.random().toString(36).slice(2, 10)}`;
}

async function inoculate(playerId: string, microbeId: string, compartment: 'hotSpring' | 'gut' | 'soil', index: number) {
  return gameService.command(playerId, key('inoc', index), { type: 'inoculate', microbeId, compartment });
}

async function upgrade(playerId: string, compartment: 'hotSpring' | 'gut' | 'soil', index: number) {
  return gameService.command(playerId, key(`up-${compartment}`, index), { type: 'upgradeCompartment', compartment });
}

function outputSummary(snapshot: Awaited<ReturnType<typeof gameService.bootstrap>>['snapshot']) {
  const b = snapshot.state.balances;
  return {
    methane: Number(b.methane.toFixed(6)),
    ethanol: Number(b.ethanol.toFixed(6)),
    carbon: Number(b.carbon.toFixed(6)),
    nitrogen: Number(b.nitrogen.toFixed(6)),
    biomass: Number(b.biomass.toFixed(6)),
  };
}

async function testClockCapAndRewind() {
  setClockOffset(0);
  const suffix = Date.now();
  const player8h = `clock8${suffix}`;
  const player24h = `clock24${suffix}`;

  await gameService.bootstrap(player8h);
  await gameService.bootstrap(player24h);
  await inoculate(player8h, 'thermal-archaeon', 'hotSpring', 1);
  await inoculate(player24h, 'thermal-archaeon', 'hotSpring', 1);

  setClockOffset(8 * 60 * 60 * 1000);
  await gameService.settle(player8h, 'proof-cap-8h-0001');
  setClockOffset(24 * 60 * 60 * 1000);
  const settle24 = await gameService.settle(player24h, 'proof-cap-24h-0001');

  const eight = (await gameService.bootstrap(player8h)).snapshot;
  const day = (await gameService.bootstrap(player24h)).snapshot;
  assert.equal(settle24.receipt.capped, true);
  assert.equal(settle24.receipt.billableMs, 8 * 60 * 60 * 1000);
  assert.deepEqual(outputSummary(day), outputSummary(eight));

  setClockOffset(-24 * 60 * 60 * 1000);
  const rewound = await gameService.settle(player24h, 'proof-rewind-0001');
  assert.equal(rewound.receipt.clockRewound, true);
  assert.equal(rewound.receipt.billableMs, 0);
  const afterRewind = await gameService.bootstrap(player24h);
  assert.deepEqual(outputSummary(afterRewind.snapshot), outputSummary(day));

  setClockOffset(0);
  return {
    eight: outputSummary(eight),
    day: outputSummary(day),
    billableHours: settle24.receipt.billableMs / 3_600_000,
    clockRewound: rewound.receipt.clockRewound,
  };
}

async function testIdempotentReceipt() {
  setClockOffset(0);
  const playerId = `idem${Date.now()}`;
  await gameService.bootstrap(playerId);
  setClockOffset(2 * 60 * 60 * 1000);
  await inoculate(playerId, 'gut-yeast', 'gut', 1);
  setClockOffset(3 * 60 * 60 * 1000);

  const credential = 'proof-settle-once-0001';
  const first = await gameService.settle(playerId, credential);
  const ledgerAfterFirst = (await gameService.ledger(playerId, 100)).entries;
  const second = await gameService.settle(playerId, credential);
  const ledgerAfterSecond = (await gameService.ledger(playerId, 100)).entries;

  assert.equal(first.receipt.settlementId, second.receipt.settlementId);
  assert.equal(ledgerAfterFirst.length, ledgerAfterSecond.length);
  assert.equal(ledgerAfterSecond.filter((entry) => entry.idempotencyKey === credential).length, 1);
  assert.equal(second.receipt.entrySeq, first.receipt.entrySeq);
  setClockOffset(0);

  return {
    credential,
    settlementId: first.receipt.settlementId,
    entrySeq: first.receipt.entrySeq,
    entriesAfterFirst: ledgerAfterFirst.length,
    entriesAfterSecond: ledgerAfterSecond.length,
    methane: first.snapshot.state.balances.methane,
    ethanol: Number(first.snapshot.state.balances.ethanol.toFixed(3)),
  };
}

async function testTwoTabs() {
  setClockOffset(0);
  const concurrentPlayer = `tabs${Date.now()}`;
  const sequentialPlayer = `seq${Date.now()}`;
  await gameService.bootstrap(concurrentPlayer);
  await gameService.bootstrap(sequentialPlayer);

  const tabA: Array<() => Promise<unknown>> = Array.from({ length: 5 }, (_, index) => () => upgrade(concurrentPlayer, 'hotSpring', index + 1));
  const tabB: Array<() => Promise<unknown>> = Array.from({ length: 5 }, (_, index) => () => upgrade(concurrentPlayer, 'gut', index + 10));
  const calls: Array<Promise<unknown>> = [];
  for (let round = 0; round < 5; round += 1) {
    calls.push(tabA[round]());
    calls.push(tabB[round]());
  }
  await Promise.all(calls);

  for (let index = 1; index <= 5; index += 1) await upgrade(sequentialPlayer, 'hotSpring', index);
  for (let index = 11; index <= 15; index += 1) await upgrade(sequentialPlayer, 'gut', index);

  const concurrent = (await gameService.bootstrap(concurrentPlayer)).snapshot;
  const sequential = (await gameService.bootstrap(sequentialPlayer)).snapshot;
  const page = await gameService.ledger(concurrentPlayer, 100);

  assert.equal(concurrent.state.compartments.hotSpring.level, 6);
  assert.equal(concurrent.state.compartments.gut.level, 6);
  for (const resource of RESOURCES) {
    assert.equal(
      Number(concurrent.state.balances[resource].toFixed(6)),
      Number(sequential.state.balances[resource].toFixed(6)),
      resource,
    );
    assert.equal(Number(page.computedBalances[resource].toFixed(6)), Number(concurrent.state.balances[resource].toFixed(6)), resource);
  }
  const keys = page.entries.map((entry) => entry.idempotencyKey);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(page.entries.length, 11);

  return {
    rounds: 10,
    ledgerEntries: page.entries.length,
    concurrent: outputSummary(concurrent),
    sequential: outputSummary(sequential),
  };
}

async function testMigrationRollback() {
  const playerId = `mig${Date.now()}`;
  await gameService.installBrokenV1ForTest(playerId);
  const restored = await gameService.bootstrap(playerId);
  assert.equal(restored.snapshot.schemaVersion, 2);
  assert.equal(restored.snapshot.state.balances.carbon, 222);

  const files = readdirSync(path.join(process.env.GAME_DATA_DIR!, 'saves'));
  const quarantined = files.filter((file) => file.includes(`corrupt-${playerId}`)).length;
  assert.ok(quarantined >= 1);

  const noFallback = `migbad${Date.now()}`;
  await gameService.installBrokenV1ForTest(noFallback, { skip: true });
  // installBroken writes a fallback even with a truthy second arg; remove it explicitly.
  const saveDir = path.join(process.env.GAME_DATA_DIR!, 'saves');
  for (const file of readdirSync(saveDir)) {
    if (file === `last-good-v1-${noFallback}.json`) rmSync(path.join(saveDir, file));
  }
  await assert.rejects(() => saveStore.load(noFallback), MigrationError);

  return {
    restoredSchema: restored.snapshot.schemaVersion,
    restoredCarbon: restored.snapshot.state.balances.carbon,
    quarantinedFiles: quarantined,
    noFallback: '拒绝启动并保留错误，而不是使用坏档',
  };
}

const clock = await testClockCapAndRewind();
const idempotent = await testIdempotentReceipt();
const tabs = await testTwoTabs();
const migration = await testMigrationRollback();

console.log('\n✅ 微生物文明馆：可复现验收凭证');
console.log('======================================');
console.log('1) 服务端时钟 / 离线 8 小时上限 / 时钟回拨');
console.table(clock);
console.log('\n2) 同一结算凭证提交两次');
console.table(idempotent);
console.log('\n3) 两个标签页共 10 次并发升级，对照单序列 10 次');
console.table(tabs);
console.log('\n4) 旧版存档迁移失败并恢复上一份可用存档');
console.table(migration);
console.log('\n结论：时间改动 24h 与 8h 收益完全一致；重复结算流水仍为 1 笔；双标签页总额等于单序列；坏档隔离且 v1 last-good 已恢复为 v2。');
