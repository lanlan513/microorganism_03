import {
  BootstrapResponse,
  Command,
  EXHIBIT_CATALOG,
  GameSnapshot,
  LedgerEntry,
  LedgerPage,
  MICROBE_CATALOG,
  MutationResponse,
  OFFLINE_CAP_MS,
  RESOURCES,
  SaveEnvelope,
  SettleResponse,
  SettlementReceipt,
  emptyResources,
  round6,
} from '../../../shared/civilization.js';
import { tick, wallNow } from './clock.js';
import {
  appendLedgerEntry,
  applyCommand,
  createInitialSave,
  projectBalances,
  validateCommand,
  produceForInterval,
} from './engine.js';
import { saveStore } from './saveStore.js';

export class ApiError extends Error {
  constructor(public status: number, message: string, public code = 'API_ERROR') {
    super(message);
  }
}

function snapshot(save: SaveEnvelope): GameSnapshot {
  return {
    schemaVersion: save.schemaVersion,
    playerId: save.playerId,
    revision: save.revision,
    state: save.state,
    serverTime: wallNow(),
  };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

function settlementIdForKey(key: string): string {
  let hash = 5381;
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 33) ^ key.charCodeAt(index);
  }
  return `set-${(hash >>> 0).toString(36)}-${key.slice(-8)}`;
}

function runSettlement(save: SaveEnvelope, idempotencyKey: string): { receipt: SettlementReceipt; entry?: LedgerEntry; serverNow: number } {
  const rawNow = wallNow();
  const from = save.state.lastSettleServerTime;
  const rawElapsed = Math.max(0, rawNow - from);
  const billableMs = Math.min(rawElapsed, OFFLINE_CAP_MS);
  const clockRewound = rawNow < save.state.lastServerTime || rawNow < from;
  const { now } = tick(save.state.lastServerTime);

  const { deltas } = produceForInterval(save.state, billableMs);
  let entry: LedgerEntry | undefined;
  if (billableMs > 0 && Object.keys(deltas).length > 0) {
    entry = appendLedgerEntry(save, {
      idempotencyKey,
      command: { type: 'settlement' },
      deltas,
      reason: `服务端周期结算（${Math.round(billableMs / 60000)} 分钟）`,
      serverTime: now,
    });
  }

  save.state.lastSettleServerTime = from + billableMs;
  save.state.lastServerTime = now;

  const receipt: SettlementReceipt = {
    settlementId: settlementIdForKey(idempotencyKey),
    elapsedMs: rawElapsed,
    billableMs,
    capped: rawElapsed > OFFLINE_CAP_MS,
    clockRewound,
    deltas,
    fromServerTime: from,
    toServerTime: save.state.lastSettleServerTime,
    entrySeq: entry?.seq,
  };
  return { receipt, entry, serverNow: now };
}

function enforceIdempotency(
  save: SaveEnvelope,
  key: string,
  fingerprint: string,
): { responseSnapshot: unknown; entrySeq: number | null } | null {
  const existing = save.idempotency[key];
  if (!existing) return null;
  if (existing.commandFingerprint !== fingerprint) {
    throw new ApiError(409, '同一个幂等凭证不能用于不同命令', 'IDEMPOTENCY_KEY_CONFLICT');
  }
  return { responseSnapshot: existing.responseSnapshot, entrySeq: existing.entrySeq };
}

async function mutateSave<T>(playerId: string, operation: (save: SaveEnvelope) => T): Promise<T> {
  return saveStore.withSave(playerId, async (save) => {
    const result = operation(save);
    const projected = projectBalances(save.ledger);
    for (const resource of RESOURCES) {
      if (Math.abs(projected[resource] - save.state.balances[resource]) > 0.0001) {
        throw new Error(`账本投影与余额不一致：${resource}`);
      }
    }
    await saveStore.persist(save);
    return result;
  });
}

export const gameService = {
  async bootstrap(playerId: string): Promise<BootstrapResponse> {
    const data = await mutateSave(playerId, (save) => ({
      snapshot: snapshot(save),
      catalog: { microbes: MICROBE_CATALOG, exhibits: EXHIBIT_CATALOG },
    }));
    return data;
  },

  async settle(playerId: string, key: string): Promise<SettleResponse> {
    if (!key) throw new ApiError(400, '缺少 Idempotency-Key 请求头', 'IDEMPOTENCY_KEY_REQUIRED');
    const fingerprint = stableStringify({ action: 'settle' });
    return mutateSave(playerId, (save) => {
      const duplicate = enforceIdempotency(save, key, fingerprint);
      if (duplicate) {
        const response = duplicate.responseSnapshot as SettleResponse;
        return { ...response, receipt: { ...response.receipt, duplicate: true } };
      }

      const { receipt, entry } = runSettlement(save, key);
      save.idempotency[key] = {
        commandFingerprint: fingerprint,
        responseSnapshot: null,
        entrySeq: entry?.seq ?? null,
        createdAt: wallNow(),
      };
      const response: SettleResponse = { snapshot: snapshot(save), receipt, ledgerEntry: entry };
      save.idempotency[key].responseSnapshot = response;
      return response;
    });
  },

  async command(playerId: string, key: string, command: Command): Promise<MutationResponse> {
    if (!key) throw new ApiError(400, '缺少 Idempotency-Key 请求头', 'IDEMPOTENCY_KEY_REQUIRED');
    if (!command || typeof command.type !== 'string') throw new ApiError(400, '命令格式错误');
    const fingerprint = stableStringify({ action: 'command', command });

    return mutateSave(playerId, (save) => {
      const duplicate = enforceIdempotency(save, key, fingerprint);
      if (duplicate) {
        const response = duplicate.responseSnapshot as MutationResponse;
        return { ...response, receipt: { ...response.receipt, duplicate: true } };
      }

      // Commands and the production they trigger are one server-authoritative transaction.
      const settlementKey = `settle-before:${key}`;
      const { receipt: settlement, serverNow } = runSettlement(save, settlementKey);
      validateCommand(save.state, command);
      const { deltas, reason } = applyCommand(save.state, command, serverNow);
      const entry = appendLedgerEntry(save, {
        idempotencyKey: key,
        command,
        deltas,
        reason,
        serverTime: serverNow,
      });
      save.revision += 1;

      const receipt = {
        command,
        idempotencyKey: key,
        entrySeq: entry.seq,
        revision: save.revision,
        settlement,
      };
      save.idempotency[key] = {
        commandFingerprint: fingerprint,
        responseSnapshot: null,
        entrySeq: entry.seq,
        createdAt: serverNow,
      };
      const response: MutationResponse = { snapshot: snapshot(save), receipt, ledgerEntry: entry };
      save.idempotency[key].responseSnapshot = response;
      return response;
    });
  },

  async ledger(playerId: string, limitValue: number, beforeSeq?: number): Promise<LedgerPage> {
    return saveStore.withSave(playerId, (save) => {
      const limit = Math.max(1, Math.min(100, Math.floor(limitValue) || 50));
      const end = beforeSeq ? beforeSeq - 1 : save.ledger.length;
      const start = Math.max(0, end - limit);
      const entries = save.ledger.slice(start, end).reverse();
      return {
        entries,
        nextBeforeSeq: start > 0 ? start + 1 : null,
        computedBalances: projectBalances(save.ledger),
      };
    });
  },

  async debugState(playerId: string) {
    return saveStore.withSave(playerId, (save) => snapshot(save));
  },

  async resetForTest(playerId: string): Promise<void> {
    await saveStore.withSave(playerId, async (save) => {
      const fresh = createInitialSave(save.playerId, wallNow());
      save.state = fresh.state;
      save.ledger = fresh.ledger;
      save.idempotency = {};
      save.revision = 0;
      save.schemaVersion = fresh.schemaVersion;
      await saveStore.persist(save);
    });
  },

  async installBrokenV1ForTest(playerId: string, lastGoodV1: unknown = {
    version: 1,
    playerId,
    resources: { carbon: 222, nitrogen: 33, methane: 4 },
    chambers: { hotSpring: { level: 2 } },
    lastTick: Date.now() - 60_000,
  }): Promise<void> {
    const broken = {
      version: 1,
      playerId,
      corruptForMigrationTest: true,
      resources: { carbon: 10 },
    };
    await saveStore.installRawSaveForMigrationTest(playerId, broken);
    await saveStore.saveLastGoodV1ForMigrationTest(playerId, lastGoodV1);
  },

  async installLastGoodV1ForTest(playerId: string, raw: unknown): Promise<void> {
    await saveStore.saveLastGoodV1ForMigrationTest(playerId, raw);
  },
};

export function sumLocalLedger(entries: LedgerEntry[]) {
  return entries.reduce((balances, entry) => {
    for (const key of RESOURCES) balances[key] = round6(balances[key] + (entry.deltas[key] ?? 0));
    return balances;
  }, emptyResources());
}
