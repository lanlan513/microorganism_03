import {
  ActiveMicrobe,
  COMPARTMENTS,
  CompartmentKey,
  LedgerEntry,
  MICROBE_CATALOG,
  RESOURCES,
  SaveEnvelope,
  SAVE_SCHEMA_VERSION,
} from '../../../shared/civilization.js';
import { appendLedgerEntry, computeCivilizationLevel, computeStability, createInitialSave } from './engine.js';

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new MigrationError(`${field} 必须是数字`);
  return value;
}

export function validateV2(save: SaveEnvelope): void {
  if (save.schemaVersion !== SAVE_SCHEMA_VERSION) throw new MigrationError('目标存档版本必须是 2');
  if (typeof save.playerId !== 'string' || !save.playerId) throw new MigrationError('playerId 缺失');
  if (!isRecord(save.state) || !isRecord(save.state.balances) || !isRecord(save.state.compartments)) {
    throw new MigrationError('v2 state 结构损坏');
  }
  for (const key of RESOURCES) asFiniteNumber(save.state.balances[key], `balances.${key}`);
  for (const key of COMPARTMENTS) {
    const compartment = save.state.compartments[key];
    if (!isRecord(compartment) || typeof compartment.level !== 'number' || !Array.isArray(compartment.microbes)) {
      throw new MigrationError(`compartments.${key} 结构损坏`);
    }
  }
  if (!Array.isArray(save.state.microbes)) throw new MigrationError('microbes 必须是数组');
  if (!Array.isArray(save.ledger)) throw new MigrationError('ledger 必须是数组');
  save.ledger.forEach((entry: LedgerEntry, index: number) => {
    if (entry.seq !== index + 1) throw new MigrationError(`ledger 第 ${index + 1} 条序号断裂`);
  });
}

interface V1Save {
  version: 1;
  playerId?: unknown;
  resources?: Record<string, unknown>;
  chambers?: Record<string, unknown>;
  selectedMicrobes?: unknown[];
  lastTick?: unknown;
  corruptForMigrationTest?: unknown;
}

function migrateV1ToV2(raw: V1Save, fallbackNow: number): SaveEnvelope {
  if (raw.corruptForMigrationTest === true) {
    throw new MigrationError('模拟迁移失败：缺少必要的代谢索引');
  }

  const playerId = typeof raw.playerId === 'string' && raw.playerId ? raw.playerId : `player-${fallbackNow}`;
  const save = createInitialSave(playerId, fallbackNow);
  // A legacy balance is not trusted as an implicit number. It enters the v2
  // append-only ledger explicitly as a migration-opening entry.
  save.state.balances = {
    carbon: 0,
    nitrogen: 0,
    methane: 0,
    ethanol: 0,
    antibiotic: 0,
    biomass: 0,
  };
  save.ledger = [];
  const resources = raw.resources ?? {};
  const numberResource = (key: string): number | null => {
    const value = resources[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  };

  save.state.balances.carbon = numberResource('carbon') ?? 1200;
  save.state.balances.nitrogen = numberResource('nitrogen') ?? 300;
  save.state.balances.methane = numberResource('methane') ?? 0;
  save.state.balances.ethanol = numberResource('alcohol') ?? numberResource('ethanol') ?? 0;
  save.state.balances.antibiotic = numberResource('antibiotics') ?? numberResource('antibiotic') ?? 0;
  save.state.balances.biomass = numberResource('biomass') ?? 120;

  const chambers = raw.chambers ?? {};
  for (const compartment of COMPARTMENTS) {
    const legacy = chambers[compartment];
    if (isRecord(legacy) && typeof legacy.level === 'number') {
      save.state.compartments[compartment].level = Math.max(1, Math.floor(legacy.level));
    }
  }

  if (Array.isArray(raw.selectedMicrobes)) {
    for (const item of raw.selectedMicrobes) {
      if (!isRecord(item) || typeof item.id !== 'string') continue;
      const spec = MICROBE_CATALOG.find((microbe) => microbe.id === item.id);
      if (!spec || !isCompartment(item.compartment)) continue;
      if (save.state.compartments[spec.compartment].microbes.includes(spec.id)) continue;
      const active: ActiveMicrobe = { ...spec, addedAt: fallbackNow };
      save.state.microbes.push(active);
      save.state.compartments[spec.compartment].microbes.push(spec.id);
    }
  }

  const lastTick = typeof raw.lastTick === 'number' && Number.isFinite(raw.lastTick) ? raw.lastTick : fallbackNow;
  save.state.lastServerTime = lastTick;
  save.state.lastSettleServerTime = lastTick;
  save.state.stability = computeStability(save.state);
  save.state.civilizationLevel = computeCivilizationLevel(save.state.stability);
  if (save.ledger.length === 0) {
    appendLedgerEntry(save, {
      idempotencyKey: `migration-opening-${playerId}`,
      command: { type: 'migration-opening' },
      deltas: { ...save.state.balances },
      reason: '旧版存档迁移：余额转入 v2 账本',
      serverTime: fallbackNow,
    });
  }
  validateV2(save);
  return save;
}

function isCompartment(value: unknown): value is CompartmentKey {
  return typeof value === 'string' && COMPARTMENTS.includes(value as CompartmentKey);
}

export function migrateSave(raw: unknown, fallbackNow: number): { save: SaveEnvelope; fromVersion: number } {
  if (!isRecord(raw)) throw new MigrationError('存档不是 JSON 对象');
  const version = 'schemaVersion' in raw ? raw.schemaVersion : (raw as unknown as V1Save).version;
  if (version === SAVE_SCHEMA_VERSION) {
    const save = raw as unknown as SaveEnvelope;
    validateV2(save);
    return { save, fromVersion: 2 };
  }
  if (version === 1) return { save: migrateV1ToV2(raw as unknown as V1Save, fallbackNow), fromVersion: 1 };
  throw new MigrationError(`不支持的存档版本: ${String(version)}`);
}
