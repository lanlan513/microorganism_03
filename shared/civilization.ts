export const SAVE_SCHEMA_VERSION = 2;
export const OFFLINE_CAP_MS = 8 * 60 * 60 * 1000;

export const RESOURCES = ['carbon', 'nitrogen', 'methane', 'ethanol', 'antibiotic', 'biomass'] as const;
export type ResourceKey = (typeof RESOURCES)[number];

export const COMPARTMENTS = ['hotSpring', 'gut', 'soil'] as const;
export type CompartmentKey = (typeof COMPARTMENTS)[number];
export type Metabolism = 'methanogenesis' | 'fermentation' | 'streptomyces';

export type ResourceMap = Record<ResourceKey, number>;

export interface MicrobeSpec {
  id: string;
  name: string;
  latin: string;
  compartment: CompartmentKey;
  metabolism: Metabolism;
  input: Pick<ResourceMap, 'carbon' | 'nitrogen'>;
  output: Partial<ResourceMap>;
  emoji: string;
}

export interface ActiveMicrobe extends MicrobeSpec {
  addedAt: number;
}

export interface CompartmentState {
  level: number;
  microbes: string[];
}

export type CommandType = 'inoculate' | 'upgradeCompartment' | 'curateExhibit';

export interface Command {
  type: CommandType;
  compartment?: CompartmentKey;
  microbeId?: string;
  exhibitId?: string;
}

export type LedgerCommand = Command | { type: 'settlement' } | { type: 'opening' } | { type: 'migration-opening' };

export interface LedgerEntry {
  seq: number;
  id: string;
  idempotencyKey: string;
  command: LedgerCommand;
  deltas: Partial<ResourceMap>;
  reason: string;
  serverTime: number;
}

export interface GameState {
  compartments: Record<CompartmentKey, CompartmentState>;
  microbes: ActiveMicrobe[];
  exhibits: string[];
  balances: ResourceMap;
  stability: number;
  civilizationLevel: number;
  lastServerTime: number;
  lastSettleServerTime: number;
}

export interface IdempotencyRecord {
  commandFingerprint: string;
  responseSnapshot: unknown;
  entrySeq: number | null;
  createdAt: number;
}

export interface SaveEnvelope {
  schemaVersion: number;
  playerId: string;
  state: GameState;
  ledger: LedgerEntry[];
  idempotency: Record<string, IdempotencyRecord>;
  revision: number;
  updatedAt: number;
}

export interface SettlementReceipt {
  settlementId: string;
  elapsedMs: number;
  billableMs: number;
  capped: boolean;
  clockRewound: boolean;
  deltas: Partial<ResourceMap>;
  fromServerTime: number;
  toServerTime: number;
  entrySeq?: number;
  duplicate?: boolean;
}

export interface CommandReceipt {
  command: Command;
  idempotencyKey: string;
  entrySeq: number;
  revision: number;
  duplicate?: boolean;
  settlement: SettlementReceipt;
}

export interface GameSnapshot {
  schemaVersion: number;
  playerId: string;
  revision: number;
  state: GameState;
  serverTime: number;
}

export interface BootstrapResponse {
  snapshot: GameSnapshot;
  catalog: {
    microbes: MicrobeSpec[];
    exhibits: ExhibitSpec[];
  };
}

export interface MutationResponse {
  snapshot: GameSnapshot;
  receipt: CommandReceipt;
  ledgerEntry: LedgerEntry;
}

export interface SettleResponse {
  snapshot: GameSnapshot;
  receipt: SettlementReceipt;
  ledgerEntry?: LedgerEntry;
}

export interface LedgerPage {
  entries: LedgerEntry[];
  nextBeforeSeq: number | null;
  computedBalances: ResourceMap;
}

export interface ExhibitSpec {
  id: string;
  name: string;
  cost: ResourceMap;
  stabilityBonus: number;
  description: string;
}

export const RESOURCE_LABELS: Record<ResourceKey, string> = {
  carbon: '碳源',
  nitrogen: '氮源',
  methane: '甲烷',
  ethanol: '酒精',
  antibiotic: '抗生素',
  biomass: '生物质',
};

export const COMPARTMENT_LABELS: Record<CompartmentKey, string> = {
  hotSpring: '热泉舱',
  gut: '肠道舱',
  soil: '土壤舱',
};

export const METABOLISM_LABELS: Record<Metabolism, string> = {
  methanogenesis: '产甲烷代谢',
  fermentation: '厌氧发酵',
  streptomyces: '链霉菌次级代谢',
};

export const MICROBE_CATALOG: MicrobeSpec[] = [
  {
    id: 'thermal-archaeon',
    name: '嗜热古菌',
    latin: 'Methanothermus fervidus',
    compartment: 'hotSpring',
    metabolism: 'methanogenesis',
    emoji: '🔥',
    input: { carbon: 2, nitrogen: 0.4 },
    output: { methane: 1.2, biomass: 0.18 },
  },
  {
    id: 'sulfur-symbiont',
    name: '硫还原共栖菌',
    latin: 'Thermotoga sulfurensis',
    compartment: 'hotSpring',
    metabolism: 'fermentation',
    emoji: '♨️',
    input: { carbon: 1.4, nitrogen: 0.3 },
    output: { ethanol: 0.36, biomass: 0.14 },
  },
  {
    id: 'gut-yeast',
    name: '肠道酵母',
    latin: 'Candida intestinalis',
    compartment: 'gut',
    metabolism: 'fermentation',
    emoji: '🍶',
    input: { carbon: 1.8, nitrogen: 0.25 },
    output: { ethanol: 1, biomass: 0.16 },
  },
  {
    id: 'gut-methanogen',
    name: '肠产甲烷菌',
    latin: 'Methanobrevibacter smithii',
    compartment: 'gut',
    metabolism: 'methanogenesis',
    emoji: '🫧',
    input: { carbon: 1.2, nitrogen: 0.2 },
    output: { methane: 0.82, biomass: 0.1 },
  },
  {
    id: 'soil-streptomyces',
    name: '土壤链霉菌',
    latin: 'Streptomyces griseus',
    compartment: 'soil',
    metabolism: 'streptomyces',
    emoji: '🌱',
    input: { carbon: 1.6, nitrogen: 0.6 },
    output: { antibiotic: 0.72, biomass: 0.12 },
  },
  {
    id: 'soil-fermenter',
    name: '腐殖发酵菌',
    latin: 'Bacillus humi',
    compartment: 'soil',
    metabolism: 'fermentation',
    emoji: '🍂',
    input: { carbon: 1.5, nitrogen: 0.35 },
    output: { ethanol: 0.42, biomass: 0.15 },
  },
];

export const EXHIBIT_CATALOG: ExhibitSpec[] = [
  {
    id: 'blue-flame-lantern',
    name: '蓝焰航灯',
    description: '用提纯甲烷点亮第一盏馆藏航灯。',
    cost: { carbon: 0, nitrogen: 0, methane: 12, ethanol: 0, antibiotic: 0, biomass: 4 },
    stabilityBonus: 8,
  },
  {
    id: 'fermentation-amphora',
    name: '发酵陶罐',
    description: '记录微生物把糖转化为酒精的古老工艺。',
    cost: { carbon: 0, nitrogen: 0, methane: 0, ethanol: 10, antibiotic: 0, biomass: 3 },
    stabilityBonus: 7,
  },
  {
    id: 'antibiotic-ark',
    name: '抑菌方舟',
    description: '封存第一批链霉菌产物，展示抗生素时代。',
    cost: { carbon: 0, nitrogen: 0, methane: 0, ethanol: 0, antibiotic: 8, biomass: 5 },
    stabilityBonus: 10,
  },
];

export function emptyResources(): ResourceMap {
  return {
    carbon: 0,
    nitrogen: 0,
    methane: 0,
    ethanol: 0,
    antibiotic: 0,
    biomass: 0,
  };
}

export function scaleResources(resources: ResourceMap, factor: number): ResourceMap {
  const result = emptyResources();
  for (const key of RESOURCES) result[key] = round6(resources[key] * factor);
  return result;
}

export function addResources(a: ResourceMap, deltas: Partial<ResourceMap>): ResourceMap {
  const result = { ...a };
  for (const key of RESOURCES) result[key] = round6(result[key] + (deltas[key] ?? 0));
  return result;
}

export function canAfford(balances: ResourceMap, cost: Partial<ResourceMap>): boolean {
  return RESOURCES.every((key) => balances[key] + Number.EPSILON >= (cost[key] ?? 0));
}

export function missingCost(balances: ResourceMap, cost: Partial<ResourceMap>): Partial<ResourceMap> {
  const missing: Partial<ResourceMap> = {};
  for (const key of RESOURCES) {
    const value = cost[key] ?? 0;
    if (balances[key] + Number.EPSILON < value) missing[key] = round6(value - balances[key]);
  }
  return missing;
}

export function round6(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

export function compartmentUpgradeCost(level: number): ResourceMap {
  const multiplier = Math.pow(1.72, Math.max(0, level - 1));
  return {
    carbon: round6(8 * multiplier),
    nitrogen: round6(2 * multiplier),
    methane: 0,
    ethanol: 0,
    antibiotic: 0,
    biomass: round6(2 * multiplier),
  };
}

export function formatSignedResource(value: number): string {
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  return `${sign}${Math.abs(value).toFixed(2)}`;
}
