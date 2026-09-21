import {
  ActiveMicrobe,
  addResources,
  BootstrapResponse,
  Command,
  CommandReceipt,
  compartmentUpgradeCost,
  COMPARTMENT_LABELS,
  emptyResources,
  EXHIBIT_CATALOG,
  GameSnapshot,
  LedgerEntry,
  LedgerPage,
  MICROBE_CATALOG,
  MutationResponse,
  ResourceMap,
  scaleResources,
  SettlementReceipt,
  SettleResponse,
} from '../../shared/civilization';
import { create } from 'zustand';
import { ApiFailure, gameApi, idempotencyKey, isNetworkFailure } from '../utils/gameApi';

const QUEUE_PREFIX = 'wenming.queue-item.v1.';
const PLAYER_STORAGE_KEY = 'wenming-player-id';
const CHANNEL_NAME = 'wenming-sync';

type PendingStatus = 'pending' | 'sending' | 'failed';

interface PendingMutation {
  key: string;
  command: Command;
  status: PendingStatus;
  createdAt: number;
  error?: string;
}

interface OptimisticEntry {
  key: string;
  command: Command;
  deltas: Partial<ResourceMap>;
  reason: string;
  clientTime: number;
}

interface GameStore {
  ready: boolean;
  online: boolean;
  snapshot: GameSnapshot | null;
  catalog: BootstrapResponse['catalog'] | null;
  ledger: LedgerEntry[];
  nextBeforeSeq: number | null;
  computedBalances: ResourceMap;
  pending: PendingMutation[];
  optimisticEntries: OptimisticEntry[];
  notice: string | null;
  lastReceipt: string | null;
  init: () => Promise<void>;
  refreshLedger: () => Promise<void>;
  loadMoreLedger: () => Promise<void>;
  settle: () => Promise<SettleResponse | null>;
  sendCommand: (command: Command) => Promise<MutationResponse | null>;
  drainQueue: () => Promise<void>;
  clearNotice: () => void;
}

let channel: BroadcastChannel | null = null;
let leader = false;

function getPlayerId(): string {
  const existing = localStorage.getItem(PLAYER_STORAGE_KEY);
  if (existing) return existing;
  const next = globalThis.crypto?.randomUUID?.().slice(0, 8) ?? `p${Date.now()}`;
  localStorage.setItem(PLAYER_STORAGE_KEY, next);
  return next;
}

function readQueue(): PendingMutation[] {
  const queue: PendingMutation[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const storageKey = localStorage.key(index);
    if (!storageKey?.startsWith(QUEUE_PREFIX)) continue;
    try {
      queue.push(JSON.parse(localStorage.getItem(storageKey) ?? 'null') as PendingMutation);
    } catch {
      // A damaged local view never blocks replay of the remaining ordered items.
    }
  }
  return queue.sort((a, b) => a.createdAt - b.createdAt || a.key.localeCompare(b.key));
}

function upsertQueue(mutation: PendingMutation): void {
  localStorage.setItem(`${QUEUE_PREFIX}${mutation.key}`, JSON.stringify(mutation));
}

function removeFromQueue(key: string): void {
  localStorage.removeItem(`${QUEUE_PREFIX}${key}`);
}

function optimisticDelta(command: Command): { deltas: Partial<ResourceMap>; reason: string } {
  if (command.type === 'inoculate') return { deltas: {}, reason: '入舱申请等待服务端确认' };
  if (command.type === 'upgradeCompartment') {
    const level = useGameStore.getState().snapshot?.state.compartments[command.compartment!].level ?? 1;
    const cost = compartmentUpgradeCost(level);
    return {
      deltas: scaleResources(cost, -1),
      reason: `${COMPARTMENT_LABELS[command.compartment!]}升级申请`,
    };
  }
  const exhibit = EXHIBIT_CATALOG.find((item) => item.id === command.exhibitId)!;
  return { deltas: scaleResources(exhibit.cost, -1), reason: `${exhibit.name}点亮申请` };
}

function reconcileOptimistic(entries: OptimisticEntry[], ledgerEntries: LedgerEntry[]): OptimisticEntry[] {
  const knownKeys = new Set(ledgerEntries.map((entry) => entry.idempotencyKey));
  const sendingKeys = new Set(
    useGameStore.getState().pending.filter((item) => item.status === 'sending').map((item) => item.key),
  );
  return entries.filter((entry) => !knownKeys.has(entry.key) || sendingKeys.has(entry.key));
}

function microbeFromCommand(command: Command, addedAt: number): ActiveMicrobe | null {
  if (command.type !== 'inoculate' || !command.microbeId) return null;
  const spec = MICROBE_CATALOG.find((item) => item.id === command.microbeId);
  return spec ? { ...spec, addedAt } : null;
}

function applyOptimisticState(snapshot: GameSnapshot | null, entry: OptimisticEntry): GameSnapshot | null {
  if (!snapshot) return null;
  const next: GameSnapshot = structuredClone(snapshot);
  next.state.balances = addResources(next.state.balances, entry.deltas);
  const command = entry.command;
  if (command.type === 'inoculate') {
    const active = microbeFromCommand(command, entry.clientTime);
    if (active && !next.state.microbes.some((item) => item.id === active.id)) {
      next.state.microbes.push(active);
      next.state.compartments[active.compartment].microbes.push(active.id);
    }
  } else if (command.type === 'upgradeCompartment') {
    next.state.compartments[command.compartment!].level += 1;
  } else if (command.type === 'curateExhibit' && command.exhibitId) {
    next.state.exhibits.push(command.exhibitId);
  }
  return next;
}

function receiptText(receipt: CommandReceipt | SettlementReceipt, duplicate: boolean): string {
  const stamp = duplicate ? '重复提交（已拦截）' : '首次提交（已入账）';
  if ('settlementId' in receipt) {
    return `${receipt.settlementId}\n${stamp}\n服务端结算 ${receipt.billableMs / 60000} 分钟`;
  }
  return `${receipt.idempotencyKey}\n${stamp}\n流水序号 #${receipt.entrySeq} / 存档修订 ${receipt.revision}`;
}

export const useGameStore = create<GameStore>((set, get) => {
  let settlementInflight: Promise<SettleResponse | null> | null = null;

  function adoptServerSnapshot(serverSnapshot: GameSnapshot, page?: LedgerPage) {
    const currentLedger = page?.entries ?? get().ledger;
    const optimisticEntries = reconcileOptimistic(get().optimisticEntries, currentLedger);
    let workingSnapshot = serverSnapshot;
    for (const entry of optimisticEntries) {
      workingSnapshot = applyOptimisticState(workingSnapshot, entry) ?? workingSnapshot;
    }
    set({
      snapshot: workingSnapshot,
      computedBalances: page?.computedBalances ?? get().computedBalances,
      ledger: page?.entries ?? get().ledger,
      nextBeforeSeq: page?.nextBeforeSeq ?? get().nextBeforeSeq,
      optimisticEntries,
    });
  }

  async function reconcileAfterMutation() {
    const [snapshotResponse, ledgerPage] = await Promise.all([gameApi.bootstrap(), gameApi.ledger(50)]);
    adoptServerSnapshot(snapshotResponse.snapshot, ledgerPage);
    set({ catalog: snapshotResponse.catalog });
  }

  async function settleNow(): Promise<SettleResponse | null> {
    if (!navigator.onLine) return null;
    if (settlementInflight) return settlementInflight;
    settlementInflight = gameApi.settle(idempotencyKey('settle'))
      .then(async (response) => {
        const ledgerPage = await gameApi.ledger(50);
        adoptServerSnapshot(response.snapshot, ledgerPage);
        set({ lastReceipt: receiptText(response.receipt, Boolean(response.receipt.duplicate)) });
        return response;
      })
      .finally(() => {
        settlementInflight = null;
      });
    return settlementInflight;
  }

  async function drainQueue() {
    if (!navigator.onLine) return;
    const queue = readQueue();
    for (const mutation of queue) {
      if (mutation.status === 'sending') continue;
      mutation.status = 'sending';
      upsertQueue(mutation);
      set({ pending: readQueue() });
      try {
        const response = await gameApi.command(mutation.key, mutation.command);
        removeFromQueue(mutation.key);
        const optimisticEntries = get().optimisticEntries.filter((entry) => entry.key !== mutation.key);
        set({ optimisticEntries, pending: readQueue() });
        adoptServerSnapshot(response.snapshot);
        await reconcileAfterMutation();
        set({ lastReceipt: receiptText(response.receipt, Boolean(response.receipt.duplicate)) });
        channel?.postMessage({ type: 'command-confirmed', key: mutation.key });
      } catch (error) {
        const network = await isNetworkFailure(error);
        const failed: PendingMutation = {
          ...mutation,
          status: 'pending',
          error: network ? '离线，保留队列' : error instanceof Error ? error.message : '失败',
        };
        upsertQueue(failed);
        set({ pending: readQueue() });
        if (!network) {
          removeFromQueue(mutation.key);
          const optimisticEntries = get().optimisticEntries.filter((entry) => entry.key !== mutation.key);
          set({
            pending: readQueue(),
            optimisticEntries,
            notice: `服务端拒绝并已回滚：${failed.error}`,
          });
          await reconcileAfterMutation();
        }
      }
    }
  }

  return {
    ready: false,
    online: navigator.onLine,
    snapshot: null,
    catalog: null,
    ledger: [],
    nextBeforeSeq: null,
    computedBalances: emptyResources(),
    pending: readQueue(),
    optimisticEntries: [],
    notice: null,
    lastReceipt: null,

    async init() {
      getPlayerId();
      const data = await gameApi.bootstrap();
      const page = await gameApi.ledger(50);
      set({ ready: true, catalog: data.catalog, computedBalances: page.computedBalances });
      adoptServerSnapshot(data.snapshot, page);

      if (typeof BroadcastChannel !== 'undefined') {
        channel = new BroadcastChannel(CHANNEL_NAME);
        channel.onmessage = async (event: MessageEvent<{ type: string }>) => {
          if (event.data.type === 'state-changed') {
            const fresh = await gameApi.bootstrap();
            const ledgerPage = await gameApi.ledger(50);
            adoptServerSnapshot(fresh.snapshot, ledgerPage);
            set({ pending: readQueue() });
          }
        };
      }

      window.addEventListener('online', async () => {
        set({ online: true, notice: '已联网，正在按本地队列顺序重放' });
        await settleNow();
        await drainQueue();
      });
      window.addEventListener('offline', () => set({ online: false, notice: '当前离线：操作已进入本地有序队列' }));
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden && leader) {
          settleNow().then(() => drainQueue());
        }
      });

      if (navigator.locks?.request) {
        navigator.locks.request('wenming-queue-leader', () => new Promise<void>((resolve) => {
          leader = true;
          window.addEventListener('beforeunload', () => resolve());
          setInterval(() => {
            if (navigator.onLine) drainQueue();
          }, 4000);
        }));
      }
      await settleNow();
    },

    async refreshLedger() {
      const page = await gameApi.ledger(50);
      set({ ledger: page.entries, nextBeforeSeq: page.nextBeforeSeq, computedBalances: page.computedBalances });
    },

    async loadMoreLedger() {
      const beforeSeq = get().nextBeforeSeq;
      if (!beforeSeq) return;
      const page = await gameApi.ledger(50, beforeSeq);
      set({
        ledger: [...get().ledger, ...page.entries],
        nextBeforeSeq: page.nextBeforeSeq,
        computedBalances: page.computedBalances,
      });
    },

    settle: settleNow,

    async sendCommand(command) {
      const key = idempotencyKey(command.type);
      const delta = optimisticDelta(command);
      const optimistic: OptimisticEntry = {
        key,
        command,
        deltas: delta.deltas,
        reason: delta.reason,
        clientTime: Date.now(),
      };
      set({ optimisticEntries: [...get().optimisticEntries, optimistic], notice: null });

      if (!navigator.onLine) {
        const mutation: PendingMutation = { key, command, status: 'pending', createdAt: Date.now() };
        upsertQueue(mutation);
        set({ pending: readQueue(), notice: '离线操作已入队；前端乐观显示已被标记为待确认' });
        return null;
      }

      const mutation: PendingMutation = { key, command, status: 'sending', createdAt: Date.now() };
      upsertQueue(mutation);
      set({ pending: readQueue() });
      try {
        const response = await gameApi.command(key, command);
        removeFromQueue(key);
        const optimisticEntries = get().optimisticEntries.filter((entry) => entry.key !== key);
        set({ optimisticEntries, pending: readQueue() });
        adoptServerSnapshot(response.snapshot);
        await reconcileAfterMutation();
        set({ lastReceipt: receiptText(response.receipt, Boolean(response.receipt.duplicate)) });
        channel?.postMessage({ type: 'state-changed' });
        return response;
      } catch (error) {
        const network = await isNetworkFailure(error);
        if (network) {
          upsertQueue({ ...mutation, status: 'pending', error: '网络中断' });
          set({ pending: readQueue(), notice: '网络中断，操作保留在本地队列' });
          return null;
        }
        removeFromQueue(key);
        const optimisticEntries = get().optimisticEntries.filter((entry) => entry.key !== key);
        set({
          optimisticEntries,
          pending: readQueue(),
          notice: `服务端推翻，已干净回滚：${error instanceof ApiFailure ? error.message : '未知错误'}`,
        });
        await reconcileAfterMutation();
        throw error;
      }
    },

    async drainQueue() {
      return drainQueue();
    },

    clearNotice: () => set({ notice: null }),
  };
});
