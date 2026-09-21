export type ResourceKey = 'carbon' | 'nitrogen' | 'methane' | 'alcohol' | 'antibiotic';

export type ChamberId = 'hotSpring' | 'gut' | 'soil';

export type Balances = Record<ResourceKey, number>;

export interface ChamberDef {
  name: string;
  description: string;
  microbes: string[];
  input: Partial<Balances>;
  output: Partial<Balances>;
  unlockAt: number;
}

export interface ChamberState {
  level: number;
  unlocked: boolean;
}

export interface LedgerEntry {
  id: string;
  seq: number;
  tick: number;
  at: number;
  type: 'genesis' | 'settle' | 'upgrade' | 'unlock';
  ref: string | null;
  note: string;
  changes: Partial<Balances>;
  meta?: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export interface GameView {
  tick: number;
  lastSettledTick: number;
  online: boolean;
  maxOfflineMs: number;
  balances: Balances;
  totalsProduced: Balances;
  chambers: Record<ChamberId, ChamberState>;
  chamberDefs: Record<ChamberId, ChamberDef>;
  exhibits: Array<{ id: string; name: string; cost: Partial<Balances>; level: number }>;
  unlockedExhibits: Record<string, { unlockedAt: number; level: number }>;
  cumulativeProducts: number;
  stability: number;
  civilizationLevel: number;
  ledgerCount: number;
  lastEntryHash: string;
  pendingLiveMs: number;
  clockEvents: Array<Record<string, unknown>>;
  migration: null | {
    migratedFrom?: number | null;
    restoredFromBackup?: boolean;
    migrationRolledBack?: boolean;
    replacedCorruptSave?: boolean;
    error?: string | null;
    pendingOfflineMs?: number;
    restartWallDelta?: number;
  };
}

export interface Receipt {
  ref: string;
  action?: string;
  duplicate: boolean;
  entryId?: string | null;
  elapsedMs?: number;
  changes?: Partial<Balances> | null;
  noop?: boolean;
}

export interface MutationResponse extends GameView {
  receipt: Receipt;
}

export interface LedgerPage {
  total: number;
  entries: LedgerEntry[];
  verifiedSum: Balances;
  lastHash: string;
}

export interface QueuedAction {
  id: string;
  action: 'upgrade' | 'unlock';
  chamberId?: ChamberId;
  exhibitId?: string;
  createdAt: number;
  ref: string;
}
