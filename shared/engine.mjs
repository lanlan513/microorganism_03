// 文明馆的唯一真源是服务端 append-only ledger。
// state.balances / state.chambers 都只是这份流水的物化缓存；验收时从流水重放即可验真。

export const CURRENT_SAVE_VERSION = 3;
export const CURRENT_LEDGER_VERSION = 1;
export const MAX_OFFLINE_MS = 8 * 60 * 60 * 1000; // 离线收益硬上限：8 小时
export const OFFLINE_GRACE_MS = 60 * 1000; // 断线/刷新宽限
export const RESOURCE_KEYS = ['carbon', 'nitrogen', 'methane', 'alcohol', 'antibiotic'];
export const RESOURCE_LABELS = {
  carbon: '碳',
  nitrogen: '氮',
  methane: '甲烷',
  alcohol: '酒精',
  antibiotic: '抗生素',
};

export const CHAMBERS = {
  hotSpring: {
    name: '热泉舱',
    description: '高温、高压，古菌把二氧化碳和氢变成甲烷。',
    microbes: ['methanogen'],
    input: { carbon: 3, nitrogen: 1 },
    output: { methane: 2 },
    unlockAt: 0,
  },
  gut: {
    name: '肠道舱',
    description: '缺氧而潮湿，酵母菌吃碳产酒精，脆弱拟杆菌制造抗生素。',
    microbes: ['yeast', 'bacteroides'],
    input: { carbon: 4, nitrogen: 2 },
    output: { alcohol: 1, antibiotic: 1 },
    unlockAt: 1000,
  },
  soil: {
    name: '土壤舱',
    description: '富含有机质，放线菌和根瘤菌共同维持氮循环与防御物质。',
    microbes: ['streptomyces', 'rhizobium'],
    input: { carbon: 2, nitrogen: 3 },
    output: { antibiotic: 2, nitrogen: 1 },
    unlockAt: 3000,
  },
};

export const MICROBES = {
  methanogen: { name: '甲烷古菌', chamber: 'hotSpring', note: 'CO₂ + 4H₂ → CH₄ + 2H₂O' },
  yeast: { name: '酿酒酵母', chamber: 'gut', note: '糖酵解 → 乙醇' },
  bacteroides: { name: '脆弱拟杆菌', chamber: 'gut', note: '分泌次级代谢防御物' },
  streptomyces: { name: '链霉菌', chamber: 'soil', note: '产抗生素，土壤稳定器' },
  rhizobium: { name: '根瘤菌', chamber: 'soil', note: '固氮并提高生态稳定度' },
};

export const EXHIBITS = [
  { id: 'first_flame', name: '第一簇蓝焰', cost: { methane: 300 }, level: 1 },
  { id: 'fermentation_jar', name: '新石器发酵罐', cost: { alcohol: 300 }, level: 2 },
  { id: 'pharmacy_dawn', name: '抗生素黎明', cost: { antibiotic: 600 }, level: 3 },
  { id: 'balanced_biosphere', name: '平衡生物圈沙盘', cost: { methane: 800, alcohol: 800, antibiotic: 800 }, level: 4 },
];

const INITIAL_BALANCES = {
  carbon: 1_000_000,
  nitrogen: 1_000_000,
  methane: 0,
  alcohol: 0,
  antibiotic: 0,
};

export function zeroBalances() {
  return { carbon: 0, nitrogen: 0, methane: 0, alcohol: 0, antibiotic: 0 };
}

export function createInitialState(now = 0) {
  const state = {
    tick: 0,
    lastWallAt: now,
    lastSettledTick: 0,
    online: false,
    lastHeartbeatAt: null,
    stability: 0.5,
    chambers: {
      hotSpring: { level: 1, unlocked: true },
      gut: { level: 0, unlocked: false },
      soil: { level: 0, unlocked: false },
    },
    exhibits: {},
    balances: { ...INITIAL_BALANCES },
    totalsProduced: { carbon: 0, nitrogen: 0, methane: 0, alcohol: 0, antibiotic: 0 },
    ledgerVersion: CURRENT_LEDGER_VERSION,
  };

  const ledger = [
    {
      id: 'genesis',
      seq: 0,
      tick: 0,
      at: now,
      type: 'genesis',
      ref: null,
      note: '文明馆开馆：初始碳氮入库',
      changes: {
        carbon: INITIAL_BALANCES.carbon,
        nitrogen: INITIAL_BALANCES.nitrogen,
      },
      prevHash: 'GENESIS',
      hash: '',
    },
  ];
  ledger[0].hash = hashEntry(ledger[0]);
  state.totalsProduced.carbon = INITIAL_BALANCES.carbon;
  state.totalsProduced.nitrogen = INITIAL_BALANCES.nitrogen;
  return { state, ledger };
}

export function canonicalEntry(entry) {
  return JSON.stringify({
    id: entry.id,
    seq: entry.seq,
    tick: entry.tick,
    at: entry.at,
    type: entry.type,
    ref: entry.ref ?? null,
    note: entry.note ?? '',
    changes: entry.changes ?? {},
    meta: entry.meta ?? {},
    prevHash: entry.prevHash,
  });
}

// FNV-1a 64-bit：零依赖且足够给本地演示做篡改检测；生产可换服务端 HMAC。
export function hashEntry(entry) {
  const text = canonicalEntry(entry);
  let h1 = 0xcbf29ce4 ^ 0x9e3779b9;
  let h2 = 0x84222325 ^ 0x9e3779b9;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ ((c << 9) | (c >>> 7)), 0x01000193);
  }
  const h = (BigInt(h1 >>> 0) << 32n) | BigInt(h2 >>> 0);
  return h.toString(16).padStart(16, '0');
}

export function assertLedger(ledger) {
  if (!Array.isArray(ledger) || ledger.length === 0) throw new Error('账本为空');
  let prev = 'GENESIS';
  const seenIds = new Set();
  for (let i = 0; i < ledger.length; i++) {
    const e = ledger[i];
    if (e.seq !== i) throw new Error(`账本序号断裂：期望 ${i}，实际 ${e.seq}`);
    if (seenIds.has(e.id)) throw new Error(`账本条目重复：${e.id}`);
    seenIds.add(e.id);
    if (e.prevHash !== prev) throw new Error(`账本哈希链断裂：#${i} ${e.id}`);
    const actualHash = hashEntry(e);
    if (actualHash !== e.hash) throw new Error(`账本内容被篡改：#${i} ${e.id}`);
    prev = e.hash;
  }
}

export function replayLedger(ledger) {
  assertLedger(ledger);
  const { state } = createInitialState(ledger[0].at);
  state.balances = zeroBalances();
  state.totalsProduced = { carbon: 0, nitrogen: 0, methane: 0, alcohol: 0, antibiotic: 0 };

  for (const entry of ledger) {
    for (const [key, delta] of Object.entries(entry.changes || {})) {
      state.balances[key] += delta;
      if (delta > 0) state.totalsProduced[key] += delta;
    }

    if (entry.type === 'upgrade') {
      state.chambers[entry.meta.chamber].level = entry.meta.level;
      state.chambers[entry.meta.chamber].unlocked = true;
    }
    if (entry.type === 'unlock') {
      state.exhibits[entry.meta.exhibitId] = { unlockedAt: entry.at, level: entry.meta.level };
    }
    if (entry.type === 'settle') {
      state.lastSettledTick = entry.tick;
    }
    state.tick = Math.max(state.tick, entry.tick);
    state.lastWallAt = Math.max(state.lastWallAt || 0, entry.at);
  }
  state.stability = calculateStability(state);
  return state;
}

export function calculateStability(state) {
  const totalLevels = Object.values(state.chambers).reduce((sum, c) => sum + c.level, 0);
  const active = Object.values(state.chambers).filter((c) => c.level > 0).length;
  if (!totalLevels) return 0.35;
  const balancePenalty =
    state.balances.carbon < 10_000 || state.balances.nitrogen < 10_000 ? 0.18 : 0;
  return Math.min(1, 0.36 + active * 0.1 + totalLevels * 0.015 + balancePenalty);
}

export function civilizationLevel(state) {
  return Math.min(5, 1 + Math.floor(state.stability * 4));
}

export function unlockableChambers(state) {
  return Object.entries(CHAMBERS)
    .filter(([id]) => !state.chambers[id].unlocked)
    .filter(([, def]) => cumulativeProducts(state) >= def.unlockAt)
    .map(([id]) => id);
}

export function cumulativeProducts(state) {
  return state.totalsProduced.methane + state.totalsProduced.alcohol + state.totalsProduced.antibiotic;
}

function availableChambers(state) {
  return Object.entries(state.chambers)
    .filter(([, chamber]) => chamber.unlocked && chamber.level > 0)
    .map(([id]) => id);
}

export function previewProduction(state, durationMs) {
  const durationSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const changes = { carbon: 0, nitrogen: 0, methane: 0, alcohol: 0, antibiotic: 0 };
  let activeSeconds = 0;

  for (const chamberId of availableChambers(state)) {
    const chamber = state.chambers[chamberId];
    const def = CHAMBERS[chamberId];
    const needCarbonPerSec = def.input.carbon * chamber.level;
    const needNitrogenPerSec = def.input.nitrogen * chamber.level;
    let affordableSeconds = durationSeconds;
    if (needCarbonPerSec > 0) {
      affordableSeconds = Math.min(affordableSeconds, Math.floor(state.balances.carbon / needCarbonPerSec));
    }
    if (needNitrogenPerSec > 0) {
      affordableSeconds = Math.min(affordableSeconds, Math.floor(state.balances.nitrogen / needNitrogenPerSec));
    }
    affordableSeconds = Math.max(0, affordableSeconds);
    activeSeconds = Math.max(activeSeconds, affordableSeconds);
    for (const [key, amount] of Object.entries(def.input)) {
      changes[key] -= amount * chamber.level * affordableSeconds;
    }
    for (const [key, amount] of Object.entries(def.output)) {
      changes[key] += amount * chamber.level * affordableSeconds;
    }
  }

  return { durationSeconds, activeSeconds, changes };
}

function appendEntry({ ledger, state, type, changes, ref, note, meta = {}, at, tick }) {
  const withoutHash = {
    id: `${type}_${ref}`,
    seq: ledger.length,
    tick,
    at,
    type,
    ref,
    note,
    changes,
    meta,
    prevHash: ledger[ledger.length - 1].hash,
  };
  const entry = { ...withoutHash, hash: hashEntry(withoutHash) };
  ledger.push(entry);

  for (const [key, delta] of Object.entries(changes)) {
    if (delta !== 0) state.balances[key] += delta;
    if (delta > 0 && type !== 'genesis') state.totalsProduced[key] += delta;
  }
  return entry;
}

export function settle(state, ledger, { now, elapsedMs, reason, ref }) {
  if (!ref || typeof ref !== 'string') throw new Error('结算必须携带幂等凭证 ref');
  if (ledger.some((e) => e.ref === ref && e.type === 'settle')) {
    return { entry: ledger.find((e) => e.ref === ref && e.type === 'settle'), duplicate: true };
  }
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) throw new Error('非法结算时长');
  elapsedMs = Math.min(elapsedMs, MAX_OFFLINE_MS);
  const tick = state.tick + elapsedMs;
  const { activeSeconds, changes } = previewProduction(state, elapsedMs);
  const entry = appendEntry({
    ledger,
    state,
    type: 'settle',
    changes,
    ref,
    note: `${reason}，活跃代谢 ${activeSeconds} 秒`,
    meta: { requestedMs: elapsedMs, cappedMs: MAX_OFFLINE_MS, reason },
    at: now,
    tick,
  });
  state.tick = tick;
  state.lastSettledTick = tick;
  state.lastWallAt = now;
  state.stability = calculateStability(state);
  return { entry, duplicate: false };
}

export function upgradeChamber(state, ledger, { chamberId, now, ref }) {
  if (!ref || typeof ref !== 'string') throw new Error('升级必须携带幂等凭证 ref');
  const existing = ledger.find((e) => e.ref === ref && e.type === 'upgrade');
  if (existing) return { entry: existing, duplicate: true };
  const def = CHAMBERS[chamberId];
  if (!def) throw new Error('未知舱室');
  const chamber = state.chambers[chamberId];
  if (!chamber.unlocked && cumulativeProducts(state) < def.unlockAt) {
    throw new Error(`馆藏积累不足，${def.name}尚未点亮`);
  }
  const targetLevel = chamber.level + 1;
  const cost = {
    carbon: 12 * targetLevel,
    nitrogen: 8 * targetLevel,
  };
  if (state.balances.carbon < cost.carbon || state.balances.nitrogen < cost.nitrogen) {
    throw new Error('碳氮不足，不能升级舱室');
  }
  const tick = state.tick;
  const entry = appendEntry({
    ledger,
    state,
    type: 'upgrade',
    changes: { carbon: -cost.carbon, nitrogen: -cost.nitrogen },
    ref,
    note: `${def.name}升至 Lv.${targetLevel}`,
    meta: { chamber: chamberId, level: targetLevel, cost },
    at: now,
    tick,
  });
  chamber.level = targetLevel;
  chamber.unlocked = true;
  state.lastWallAt = now;
  state.stability = calculateStability(state);
  return { entry, duplicate: false };
}

export function unlockExhibit(state, ledger, { exhibitId, now, ref }) {
  if (!ref || typeof ref !== 'string') throw new Error('点亮展品必须携带幂等凭证 ref');
  const existing = ledger.find((e) => e.ref === ref && e.type === 'unlock');
  if (existing) return { entry: existing, duplicate: true };
  const def = EXHIBITS.find((e) => e.id === exhibitId);
  if (!def) throw new Error('未知展品');
  if (state.exhibits[exhibitId]) throw new Error('展品已经点亮');
  for (const [key, amount] of Object.entries(def.cost)) {
    if (state.balances[key] < amount) throw new Error(`${RESOURCE_LABELS[key]}不足`);
  }
  const entry = appendEntry({
    ledger,
    state,
    type: 'unlock',
    changes: Object.fromEntries(Object.entries(def.cost).map(([k, v]) => [k, -v])),
    ref,
    note: `点亮馆藏：${def.name}`,
    meta: { exhibitId, level: def.level },
    at: now,
    tick: state.tick,
  });
  state.exhibits[exhibitId] = { unlockedAt: now, level: def.level };
  state.lastWallAt = now;
  state.stability = calculateStability(state);
  return { entry, duplicate: false };
}

export function reconcile(state, ledger) {
  const replayed = replayLedger(ledger);
  const fromLedger = replayLedger(ledger).balances;
  for (const key of RESOURCE_KEYS) {
    if (state.balances[key] !== fromLedger[key]) {
      state.balances[key] = replayed.balances[key];
    }
  }
  state.chambers = replayed.chambers;
  state.exhibits = replayed.exhibits;
  state.totalsProduced = replayed.totalsProduced;
  state.stability = calculateStability(state);
}
