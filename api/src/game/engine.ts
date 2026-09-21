import {
  ActiveMicrobe,
  addResources,
  canAfford,
  Command,
  compartmentUpgradeCost,
  COMPARTMENTS,
  emptyResources,
  EXHIBIT_CATALOG,
  GameState,
  LedgerCommand,
  LedgerEntry,
  MICROBE_CATALOG,
  RESOURCES,
  ResourceMap,
  round6,
  SaveEnvelope,
  SAVE_SCHEMA_VERSION,
  scaleResources,
} from '../../../shared/civilization.js';

const HOUR_MS = 60 * 60 * 1000;

export interface ProduceResult {
  deltas: Partial<ResourceMap>;
  stabilityBefore: number;
  stabilityAfter: number;
}

export function createInitialState(now: number): GameState {
  return {
    compartments: {
      hotSpring: { level: 1, microbes: [] },
      gut: { level: 1, microbes: [] },
      soil: { level: 1, microbes: [] },
    },
    microbes: [],
    exhibits: [],
    balances: {
      carbon: 1200,
      nitrogen: 300,
      methane: 0,
      ethanol: 0,
      antibiotic: 0,
      biomass: 120,
    },
    stability: 50,
    civilizationLevel: 1,
    lastServerTime: now,
    lastSettleServerTime: now,
  };
}

export function createInitialSave(playerId: string, now: number): SaveEnvelope {
  const state = createInitialState(now);
  const save: SaveEnvelope = {
    schemaVersion: SAVE_SCHEMA_VERSION,
    playerId,
    state,
    ledger: [],
    idempotency: {},
    revision: 0,
    updatedAt: now,
  };
  appendLedgerEntry(save, {
    idempotencyKey: `opening-${playerId}`,
    command: { type: 'opening' },
    deltas: { ...state.balances },
    reason: '文明建馆种子资源',
    serverTime: now,
  });
  return save;
}

export function computeStability(state: GameState): number {
  const species = new Set(state.microbes.map((microbe) => microbe.id)).size;
  const compartmentsUsed = COMPARTMENTS.filter((key) => state.compartments[key].microbes.length > 0).length;
  const levels = COMPARTMENTS.reduce((sum, key) => sum + state.compartments[key].level, 0);
  const exhibitBonus = state.exhibits.reduce((sum, id) => {
    const exhibit = EXHIBIT_CATALOG.find((item) => item.id === id);
    return sum + (exhibit?.stabilityBonus ?? 0);
  }, 0);
  const diversityScore = species * 4 + compartmentsUsed * 6 + levels * 2 + exhibitBonus;
  const resourcePenalty = RESOURCES.some((key) => key !== 'biomass' && state.balances[key] < 0) ? 12 : 0;
  return Math.max(0, Math.min(100, Math.round(36 + diversityScore - resourcePenalty)));
}

export function computeCivilizationLevel(stability: number): number {
  return Math.max(1, Math.min(10, Math.floor(stability / 10) + 1));
}

export function produceForInterval(
  state: GameState,
  elapsedMs: number,
): ProduceResult {
  const stabilityBefore = state.stability;
  const hours = Math.max(0, elapsedMs) / HOUR_MS;
  if (hours === 0 || state.microbes.length === 0) {
    return { deltas: {}, stabilityBefore, stabilityAfter: stabilityBefore };
  }

  const deltas = emptyResources();
  for (const microbe of state.microbes) {
    const compartmentLevel = state.compartments[microbe.compartment].level;
    const efficiency = 0.72 + compartmentLevel * 0.14;
    const factor = round6(hours * efficiency);

    for (const key of ['carbon', 'nitrogen'] as const) {
      deltas[key] = round6((deltas[key] ?? 0) - microbe.input[key] * factor);
    }
    for (const key of RESOURCES) {
      const value = microbe.output[key];
      if (value) deltas[key] = round6((deltas[key] ?? 0) + value * factor);
    }
  }

  // Production is substrate-limited. If a cumulative input is unavailable, all
  // metabolic activity for that interval is clipped; this keeps every projection
  // directly reconstructable from the append-only ledger.
  for (const key of ['carbon', 'nitrogen'] as const) {
    const consumed = Math.abs(Math.min(0, deltas[key] ?? 0));
    if (consumed > state.balances[key]) {
      const clipFactor = state.balances[key] / consumed;
      for (const resourceKey of RESOURCES) {
        deltas[resourceKey] = round6((deltas[resourceKey] ?? 0) * clipFactor);
      }
      break;
    }
  }

  for (const key of RESOURCES) {
    if (Math.abs(deltas[key]) < 0.000001) delete deltas[key];
  }
  state.balances = addResources(state.balances, deltas);

  state.stability = computeStability(state);
  state.civilizationLevel = computeCivilizationLevel(state.stability);
  return { deltas, stabilityBefore, stabilityAfter: state.stability };
}

export function appendLedgerEntry(
  save: SaveEnvelope,
  fields: {
    idempotencyKey: string;
    command: LedgerCommand;
    deltas: Partial<ResourceMap>;
    reason: string;
    serverTime: number;
  },
): LedgerEntry {
  const seq = save.ledger.length + 1;
  const entry: LedgerEntry = {
    seq,
    id: `led-${save.playerId}-${seq}`,
    idempotencyKey: fields.idempotencyKey,
    command: fields.command,
    deltas: fields.deltas,
    reason: fields.reason,
    serverTime: fields.serverTime,
  };
  save.ledger.push(entry);
  return entry;
}

export function projectBalances(entries: LedgerEntry[]): ResourceMap {
  return entries.reduce<ResourceMap>((balances, entry) => addResources(balances, entry.deltas), emptyResources());
}

export function validateCommand(state: GameState, command: Command): void {
  if (command.type === 'inoculate') {
    const spec = MICROBE_CATALOG.find((item) => item.id === command.microbeId);
    if (!spec) throw new Error('微生物不存在');
    if (spec.compartment !== command.compartment) throw new Error('微生物与舱室不匹配');
    if (state.compartments[spec.compartment].microbes.includes(spec.id)) throw new Error('该微生物已经入舱');
    return;
  }

  if (command.type === 'upgradeCompartment') {
    const compartment = command.compartment;
    if (!compartment || !COMPARTMENTS.includes(compartment)) throw new Error('舱室不存在');
    const level = state.compartments[compartment].level;
    const cost = compartmentUpgradeCost(level);
    if (!canAfford(state.balances, cost)) throw new Error('资源不足，无法升级舱室');
    return;
  }

  if (command.type === 'curateExhibit') {
    const exhibit = EXHIBIT_CATALOG.find((item) => item.id === command.exhibitId);
    if (!exhibit) throw new Error('展品不存在');
    if (state.exhibits.includes(exhibit.id)) throw new Error('展品已经点亮');
    if (!canAfford(state.balances, exhibit.cost)) throw new Error('资源不足，无法点亮展品');
  }
}

export function applyCommand(state: GameState, command: Command, now: number): { deltas: Partial<ResourceMap>; reason: string } {
  if (command.type === 'inoculate') {
    const spec = MICROBE_CATALOG.find((item) => item.id === command.microbeId);
    if (!spec) throw new Error('微生物不存在');
    const active: ActiveMicrobe = { ...spec, addedAt: now };
    state.microbes.push(active);
    state.compartments[spec.compartment].microbes.push(spec.id);
    state.stability = computeStability(state);
    state.civilizationLevel = computeCivilizationLevel(state.stability);
    return { deltas: {}, reason: `${spec.name}进入${spec.compartment === 'hotSpring' ? '热泉舱' : spec.compartment === 'gut' ? '肠道舱' : '土壤舱'}` };
  }

  if (command.type === 'upgradeCompartment') {
    const compartment = command.compartment!;
    const level = state.compartments[compartment].level;
    const cost = compartmentUpgradeCost(level);
    const deltas = scaleResources(cost, -1);
    state.balances = addResources(state.balances, deltas);
    state.compartments[compartment].level += 1;
    state.stability = computeStability(state);
    state.civilizationLevel = computeCivilizationLevel(state.stability);
    return { deltas, reason: `${compartment === 'hotSpring' ? '热泉舱' : compartment === 'gut' ? '肠道舱' : '土壤舱'}升至 Lv.${level + 1}` };
  }

  const exhibit = EXHIBIT_CATALOG.find((item) => item.id === command.exhibitId)!;
  state.balances = addResources(state.balances, scaleResources(exhibit.cost, -1));
  state.exhibits.push(exhibit.id);
  state.stability = computeStability(state);
  state.civilizationLevel = computeCivilizationLevel(state.stability);
  return { deltas: scaleResources(exhibit.cost, -1), reason: `点亮馆藏：${exhibit.name}` };
}
