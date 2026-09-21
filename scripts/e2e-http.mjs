#!/usr/bin/env node
import { mkdtempSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInitialState } from '../shared/engine.mjs';

const tempDir = mkdtempSync(path.join(os.tmpdir(), 'civilization-http-'));
process.env.CIV_DATA_DIR = path.join(tempDir, 'data');
process.env.PORT = '0';
const { default: app } = await import(pathToFileURL(path.resolve('api/app.ts')).href);

const server = createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const origin = `http://127.0.0.1:${port}/api`;

let failures = 0;
function assert(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} — actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  if (!ok) failures += 1;
}

async function call(method, url, body) {
  const response = await fetch(`${origin}${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok || !payload.success) throw new Error(payload.error || response.statusText);
  return payload.data;
}

try {
  // 1. 等待 1.1 个服务端 monotonic 秒，然后同一结算凭证提交两次。
  const duplicateUser = 'http-duplicate';
  await call('POST', `/reset?user=${duplicateUser}`);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const ref = 'acceptance-idempotency-proof';
  const first = await call('POST', `/settle?user=${duplicateUser}`, { ref });
  const second = await call('POST', `/settle?user=${duplicateUser}`, { ref });
  const ledgerAfterDuplicate = await call('GET', `/ledger?user=${duplicateUser}`);

  assert('结算凭证第一次不是 duplicate', first.receipt.duplicate, false);
  assert('同一结算凭证第二次是 duplicate', second.receipt.duplicate, true);
  assert('重复凭证返回同一条账本 ID', second.receipt.entryId, first.receipt.entryId);
  assert('热泉舱 1 秒产生 2 甲烷', first.receipt.changes.methane, 2);
  assert('重复提交没有新增账本条目', ledgerAfterDuplicate.total, 2);
  console.log(`可复现凭证：POST /api/settle { "ref": "${ref}" } -> entry=${first.receipt.entryId}`);

  // 2. 两个标签页的 10 个升级请求交错并发；每个唯一 ref 只能扣一次。
  const concurrentUser = 'http-tabs';
  await call('POST', `/reset?user=${concurrentUser}`);
  const refs = Array.from({ length: 10 }, (_, i) => `tab-${i % 2 ? 'B' : 'A'}-${i}-${Date.now()}`);
  const responses = await Promise.all(
    refs.map((upgradeRef, i) =>
      new Promise((resolve, reject) => {
        setTimeout(() => call('POST', `/actions/upgrade?user=${concurrentUser}`, {
          ref: upgradeRef,
          chamberId: 'hotSpring',
        }).then(resolve, reject), i % 2 ? 15 : 0);
      }),
    ),
  );
  const state = await call('GET', `/state?user=${concurrentUser}`);
  const ledger = await call('GET', `/ledger?user=${concurrentUser}&limit=500`);
  const upgrades = ledger.entries.filter((entry) => entry.type === 'upgrade');
  const carbonCost = upgrades.reduce((sum, entry) => sum + entry.changes.carbon, 0);
  const nitrogenCost = upgrades.reduce((sum, entry) => sum + entry.changes.nitrogen, 0);

  assert('10 个并发升级全部成功', responses.length, 10);
  assert('没有任何升级被重复扣费', responses.filter((item) => item.receipt.duplicate).length, 0);
  assert('升级流水恰好 10 笔', upgrades.length, 10);
  assert('10 次升级总耗碳为 -(24+36+...+132)=-780', carbonCost, -780);
  assert('10 次升级总耗氮为 -520', nitrogenCost, -520);
  assert('热泉舱从 Lv.1 串行升级到 Lv.11', state.chambers.hotSpring.level, 11);

  // 3. 预置 24 小时前的服务端存档，冷启动后只允许 8 小时离线收益。
  const offlineUser = 'http-offline';
  const startedAt = Date.now();
  const offlineSave = createInitialState(startedAt - 24 * 60 * 60 * 1000);
  await writeFile(
    path.join(tempDir, 'data', `civilization-${offlineUser}.json`),
    JSON.stringify({
      version: 3,
      savedAt: startedAt - 24 * 60 * 60 * 1000,
      data: offlineSave,
    }),
  );
  const offlineState = await call('GET', `/state?user=${offlineUser}`);
  assert('冷启动识别 24 小时离线但截断为 8 小时', offlineState.migration.pendingOfflineMs, 8 * 60 * 60 * 1000);
  const offline = await call('POST', `/heartbeat?user=${offlineUser}`);
  const offlineLedger = await call('GET', `/ledger?user=${offlineUser}`);
  const settleEntry = offlineLedger.entries.find((entry) => entry.type === 'settle');
  assert('8 小时热泉舱甲烷为 57600', settleEntry.changes.methane, 57600);
  assert('离线结算后没有待结算毫秒', offline.pendingLiveMs < 1000, true);
} finally {
  await new Promise((resolve) => server.close(resolve));
  rmSync(tempDir, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} 项 HTTP 验收失败`);
  process.exit(1);
}
console.log('\n全部 HTTP 验收通过');
