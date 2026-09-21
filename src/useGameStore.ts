import { create } from 'zustand';
import { gameApi, makeRef } from './gameApi';
import type {
  ChamberId,
  GameView,
  LedgerEntry,
  QueuedAction,
  Receipt,
  ResourceKey,
} from './game-types';

const QUEUE_KEY = 'civilization.offline-queue.v1';
const SNAPSHOT_KEY = 'civilization.snapshot.v1';
const TAB_ID = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const RESOURCE_ORDER: ResourceKey[] = ['carbon', 'nitrogen', 'methane', 'alcohol', 'antibiotic'];

type Pending = {
  ref: string;
  action: QueuedAction['action'];
  chamberId?: ChamberId;
  exhibitId?: string;
};

interface GameStore {
  view: GameView | null;
  ledger: LedgerEntry[];
  queue: QueuedAction[];
  online: boolean;
  syncing: boolean;
  pending: Pending[];
  error: string | null;
  lastReceipt: Receipt | null;
  load: () => Promise<void>;
  refreshLedger: () => Promise<void>;
  settle: (ref?: string) => Promise<Receipt | null>;
  upgrade: (chamberId: ChamberId) => Promise<void>;
  unlock: (exhibitId: string) => Promise<void>;
  reset: () => Promise<void>;
  flushQueue: () => Promise<void>;
  reconcile: () => Promise<void>;
}

function readQueue(): QueuedAction[] {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]') as QueuedAction[];
  } catch {
    return [];
  }
}

function writeQueue(queue: QueuedAction[]) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  localStorage.setItem(`${QUEUE_KEY}.updated`, String(Date.now()));
}

function cloneView(view: GameView): GameView {
  return {
    ...view,
    balances: { ...view.balances },
    totalsProduced: { ...view.totalsProduced },
    chambers: {
      hotSpring: { ...view.chambers.hotSpring },
      gut: { ...view.chambers.gut },
      soil: { ...view.chambers.soil },
    },
    unlockedExhibits: { ...view.unlockedExhibits },
  };
}

function optimisticUpgrade(view: GameView, chamberId: ChamberId): GameView {
  const next = cloneView(view);
  const target = next.chambers[chamberId].level + 1;
  next.chambers[chamberId].level = target;
  next.chambers[chamberId].unlocked = true;
  next.balances.carbon -= 12 * target;
  next.balances.nitrogen -= 8 * target;
  return next;
}

function optimisticUnlock(view: GameView, exhibitId: string): GameView {
  const next = cloneView(view);
  const exhibit = next.exhibits.find((item) => item.id === exhibitId);
  if (exhibit) {
    for (const [key, amount] of Object.entries(exhibit.cost)) {
      next.balances[key as ResourceKey] -= Number(amount);
    }
    next.unlockedExhibits[exhibitId] = { unlockedAt: Date.now(), level: exhibit.level };
  }
  return next;
}

function applyPendingLocally(view: GameView, queue: QueuedAction[]): GameView {
  return queue.reduce((current, item) => {
    if (item.action === 'upgrade' && item.chamberId) return optimisticUpgrade(current, item.chamberId);
    if (item.action === 'unlock' && item.exhibitId) return optimisticUnlock(current, item.exhibitId);
    return current;
  }, cloneView(view));
}

async function withWriteLock<T>(task: () => Promise<T>): Promise<T> {
  if (!('locks' in navigator)) return task();
  return navigator.locks.request('civilization-museum-write', task);
}

async function upgradeImpl(
  chamberId: ChamberId,
  get: () => GameStore,
  set: (partial: Partial<GameStore>) => void,
) {
  const { view } = get();
  if (!view) return;
  const item: QueuedAction = {
    id: makeRef('q'),
    action: 'upgrade',
    chamberId,
    createdAt: Date.now(),
    ref: makeRef('upgrade'),
  };
  const previous = cloneView(view);
  const optimistic = optimisticUpgrade(view, chamberId);
  const queue = navigator.onLine ? readQueue() : [...readQueue(), item];
  writeQueue(queue);
  set({
    view: optimistic,
    queue,
    online: navigator.onLine,
    pending: [...get().pending, { ref: item.ref, action: 'upgrade', chamberId }],
  });

  if (!navigator.onLine) return;
  try {
    const data = await gameApi.upgrade(chamberId, item.ref);
    const remaining = readQueue();
    set({
      view: applyPendingLocally(data, remaining),
      queue: remaining,
      pending: get().pending.filter((p) => p.ref !== item.ref),
      lastReceipt: data.receipt,
      error: null,
    });
    channel?.postMessage({ type: 'state-changed', tab: TAB_ID });
    await get().refreshLedger();
  } catch (err) {
    const stillQueued = readQueue();
    if (!stillQueued.some((q) => q.ref === item.ref)) writeQueue([...stillQueued, item]);
    set({
      view: applyPendingLocally(previous, readQueue()),
      queue: readQueue(),
      error: `服务端拒绝升级，已回滚并入队：${(err as Error).message}`,
    });
  }
}

async function unlockImpl(
  exhibitId: string,
  get: () => GameStore,
  set: (partial: Partial<GameStore>) => void,
) {
  const { view } = get();
  if (!view) return;
  const item: QueuedAction = {
    id: makeRef('q'),
    action: 'unlock',
    exhibitId,
    createdAt: Date.now(),
    ref: makeRef('unlock'),
  };
  const previous = cloneView(view);
  const optimistic = optimisticUnlock(view, exhibitId);
  const queue = navigator.onLine ? readQueue() : [...readQueue(), item];
  writeQueue(queue);
  set({ view: optimistic, queue, pending: [...get().pending, { ref: item.ref, action: 'unlock', exhibitId }] });

  if (!navigator.onLine) return;
  try {
    const data = await gameApi.unlock(exhibitId, item.ref);
    const remaining = readQueue();
    set({
      view: applyPendingLocally(data, remaining),
      queue: remaining,
      pending: get().pending.filter((p) => p.ref !== item.ref),
      lastReceipt: data.receipt,
      error: null,
    });
    channel?.postMessage({ type: 'state-changed', tab: TAB_ID });
    await get().refreshLedger();
  } catch (err) {
    const stillQueued = readQueue();
    if (!stillQueued.some((q) => q.ref === item.ref)) writeQueue([...stillQueued, item]);
    set({
      view: applyPendingLocally(previous, readQueue()),
      queue: readQueue(),
      error: `服务端拒绝点亮，已回滚并入队：${(err as Error).message}`,
    });
  }
}

let flushInFlight = false;

async function flushQueueImpl(
  get: () => GameStore,
  set: (partial: Partial<GameStore>) => void,
) {
  if (flushInFlight || !navigator.onLine) return;
  flushInFlight = true;
  set({ syncing: true });
  try {
    for (const item of readQueue()) {
      const data =
        item.action === 'upgrade' && item.chamberId
          ? await gameApi.upgrade(item.chamberId, item.ref)
          : item.action === 'unlock' && item.exhibitId
            ? await gameApi.unlock(item.exhibitId, item.ref)
            : null;
      if (!data) continue;
      const remaining = readQueue().filter((queued) => queued.ref !== item.ref);
      writeQueue(remaining);
      set({ view: applyPendingLocally(data, remaining), queue: remaining, lastReceipt: data.receipt });
    }
    channel?.postMessage({ type: 'state-changed', tab: TAB_ID });
    await get().refreshLedger();
  } catch (err) {
    await get().reconcile();
    set({ error: `本地队列重放中断：${(err as Error).message}` });
  } finally {
    flushInFlight = false;
    set({ syncing: false });
  }
}
let channel: BroadcastChannel | null = null;
if (typeof BroadcastChannel !== 'undefined') {
  channel = new BroadcastChannel('civilization-museum');
}

export const useGameStore = create<GameStore>((set, get) => ({
  view: null,
  ledger: [],
  queue: readQueue(),
  online: navigator.onLine,
  syncing: false,
  pending: [],
  error: null,
  lastReceipt: null,

  async load() {
    try {
      const server = await gameApi.state();
      localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(server));
      const queued = readQueue();
      set({
        view: applyPendingLocally(server, queued),
        queue: queued,
        error: null,
        online: navigator.onLine,
      });
      await get().refreshLedger();
      if (navigator.onLine) await get().flushQueue();
    } catch (err) {
      const cached = localStorage.getItem(SNAPSHOT_KEY);
      set({ error: (err as Error).message, online: navigator.onLine });
      if (cached) {
        const server = JSON.parse(cached) as GameView;
        set({ view: applyPendingLocally(server, readQueue()) });
      }
    }
  },

  async refreshLedger() {
    try {
      const page = await gameApi.ledger(200);
      set({ ledger: page.entries });
    } catch (err) {
      set({ error: `账本暂不可刷新：${(err as Error).message}` });
    }
  },

  async reconcile() {
    const server = await gameApi.state();
    const queued = readQueue();
    set({ view: applyPendingLocally(server, queued), pending: [], error: null });
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(server));
    await get().refreshLedger();
  },

  async settle(ref = makeRef('settle')) {
    try {
      const data = await gameApi.settle(ref);
      set({ view: applyPendingLocally(data, readQueue()), lastReceipt: data.receipt, error: null });
      await get().refreshLedger();
      return data.receipt;
    } catch (err) {
      set({ error: (err as Error).message });
      return null;
    }
  },

  upgrade: (chamberId) => withWriteLock(() => upgradeImpl(chamberId, get, set)),

  unlock: (exhibitId) => withWriteLock(() => unlockImpl(exhibitId, get, set)),

  flushQueue: () => withWriteLock(() => flushQueueImpl(get, set)),

  async reset() {
    return withWriteLock(async () => {
      writeQueue([]);
      const view = await gameApi.reset();
      set({ view, queue: [], pending: [], error: null, lastReceipt: null });
      channel?.postMessage({ type: 'state-changed', tab: TAB_ID });
      await get().refreshLedger();
    });
  },
}));

async function heartbeatLoop() {
  if (navigator.onLine) {
    try {
      await gameApi.heartbeat();
    } catch {
      // 后台心跳失败会在下次用户操作或重连时由服务端权威状态纠正。
    }
  }
  setTimeout(heartbeatLoop, 5000);
}

setTimeout(heartbeatLoop, 800);
window.addEventListener('online', () => useGameStore.getState().flushQueue());
window.addEventListener('offline', () => useGameStore.setState({ online: false }));

window.addEventListener('storage', async (event) => {
  if (event.key === QUEUE_KEY || event.key === `${QUEUE_KEY}.updated`) {
    const queue = readQueue();
    const server = await gameApi.state().catch(() => null);
    if (server) {
      useGameStore.setState({ queue, view: applyPendingLocally(server, queue), online: navigator.onLine });
    }
  }
});

channel?.addEventListener('message', (event) => {
  if (event.data?.type === 'request-write-lock') return;
  if (event.data?.type === 'state-changed') {
    useGameStore.getState().reconcile();
  }
});

export { RESOURCE_ORDER, TAB_ID };
