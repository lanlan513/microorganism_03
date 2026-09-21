import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SaveEnvelope } from '../../../shared/civilization.js';
import { createInitialSave } from './engine.js';
import { migrateSave, MigrationError } from './migrations.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function saveDir(): string {
  return process.env.GAME_DATA_DIR
    ? path.resolve(process.env.GAME_DATA_DIR, 'saves')
    : path.join(__dirname, '..', '..', '..', 'data', 'saves');
}
const LAST_GOOD_PREFIX = 'last-good-v';

function sanitizePlayerId(playerId: string): string {
  if (!/^[a-zA-Z0-9_-]{3,64}$/.test(playerId)) throw new Error('玩家 ID 只能包含 3-64 位字母、数字、下划线或短横线');
  return playerId;
}

function paths(playerId: string) {
  return {
    save: path.join(saveDir(), `${playerId}.json`),
    lastGoodV1: path.join(saveDir(), `${LAST_GOOD_PREFIX}1-${playerId}.json`),
    lastGoodV2: path.join(saveDir(), `${LAST_GOOD_PREFIX}2-${playerId}.json`),
    quarantine: (suffix: string) => path.join(saveDir(), `corrupt-${playerId}-${Date.now()}-${suffix}.json`),
  };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function atomicWrite(filePath: string, value: unknown): Promise<void> {
  const tempPath = `${filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  await writeFile(tempPath, JSON.stringify(value, null, 2), 'utf8');
  await rename(tempPath, filePath);
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function restoreLastGood(playerId: string, now: number): Promise<SaveEnvelope | null> {
  const playerPaths = paths(playerId);
  for (const filePath of [playerPaths.lastGoodV2, playerPaths.lastGoodV1]) {
    if (!(await exists(filePath))) continue;
    try {
      const raw = await readJson(filePath);
      return migrateSave(raw, now).save;
    } catch (error) {
      if (!(error instanceof MigrationError)) throw error;
    }
  }
  return null;
}

export class SaveStore {
  private readonly tails = new Map<string, Promise<unknown>>();

  constructor() {
    mkdir(saveDir(), { recursive: true }).catch((error) => {
      console.error('无法创建存档目录', error);
    });
  }

  async withSave<T>(playerIdInput: string, operation: (save: SaveEnvelope) => Promise<T> | T): Promise<T> {
    const playerId = sanitizePlayerId(playerIdInput);
    const previous = this.tails.get(playerId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate, () => gate);
    this.tails.set(playerId, tail);

    await previous.catch(() => undefined);
    try {
      const save = await this.load(playerId);
      return await operation(save);
    } finally {
      if (this.tails.get(playerId) === tail) this.tails.delete(playerId);
      release();
    }
  }

  async load(playerIdInput: string): Promise<SaveEnvelope> {
    const playerId = sanitizePlayerId(playerIdInput);
    const playerPaths = paths(playerId);
    await mkdir(saveDir(), { recursive: true });

    if (!(await exists(playerPaths.save))) {
      const save = createInitialSave(playerId, Date.now());
      await this.persist(save);
      return save;
    }

    const raw = await readJson(playerPaths.save);
    const sourceVersion = typeof raw === 'object' && raw !== null && 'schemaVersion' in raw
      ? Number(raw.schemaVersion)
      : typeof raw === 'object' && raw !== null && 'version' in raw
        ? Number((raw as { version: unknown }).version)
        : NaN;

    try {
      const result = migrateSave(raw, Date.now());
      if (result.fromVersion !== result.save.schemaVersion) {
        // Keep the pre-migration bytes, then make the migrated envelope the new current/last-good save.
        await atomicWrite(playerPaths.lastGoodV1, raw);
        await this.persist(result.save);
      }
      return result.save;
    } catch (error) {
      if (!(error instanceof MigrationError)) throw error;
      const quarantinePath = playerPaths.quarantine(`v${Number.isFinite(sourceVersion) ? sourceVersion : 'unknown'}`);
      await atomicWrite(quarantinePath, raw);

      const restored = await restoreLastGood(playerId, Date.now());
      if (restored) {
        await this.persist(restored);
        return restored;
      }

      throw new MigrationError(
        `存档迁移失败，且没有可回退的上一份可用存档：${error.message}；坏档已隔离到 ${quarantinePath}`,
      );
    }
  }

  async persist(save: SaveEnvelope): Promise<void> {
    const playerId = sanitizePlayerId(save.playerId);
    const playerPaths = paths(playerId);
    save.updatedAt = Date.now();
    await atomicWrite(playerPaths.save, save);
    await atomicWrite(playerPaths.lastGoodV2, save);
  }

  async installRawSaveForMigrationTest(playerIdInput: string, raw: unknown): Promise<void> {
    const playerId = sanitizePlayerId(playerIdInput);
    const playerPaths = paths(playerId);
    await mkdir(saveDir(), { recursive: true });
    await atomicWrite(playerPaths.save, raw);
  }

  async saveLastGoodV1ForMigrationTest(playerIdInput: string, raw: unknown): Promise<void> {
    const playerId = sanitizePlayerId(playerIdInput);
    await atomicWrite(paths(playerId).lastGoodV1, raw);
  }
}

export const saveStore = new SaveStore();
