import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  CURRENT_SAVE_VERSION,
  assertLedger,
  createInitialState,
  hashEntry,
  replayLedger,
} from '../../shared/engine.mjs';

const BACKUP_SUFFIX = '.bak';
const TEMP_SUFFIX = '.tmp';

function dataDir() {
  return process.env.CIV_DATA_DIR ? path.resolve(process.env.CIV_DATA_DIR) : path.resolve('data');
}

function fileFor(userId = 'demo') {
  const safeId = userId.replace(/[^a-zA-Z0-9_-]/g, 'demo');
  return path.join(dataDir(), `civilization-${safeId}.json`);
}

async function readJson(file) {
  const raw = await fs.readFile(file, 'utf8');
  return { raw, envelope: JSON.parse(raw) };
}

async function writeAtomic(file, envelope) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}${TEMP_SUFFIX}`;
  await fs.writeFile(tmp, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, file);
}

function rebuildV2Ledger(ledger) {
  if (!Array.isArray(ledger) || ledger.length === 0 || ledger[0].type !== 'genesis') {
    throw new Error('v2 账本缺少 genesis');
  }
  let prevHash = 'GENESIS';
  return ledger.map((oldEntry, i) => {
    const entry = {
      id: oldEntry.id || `${oldEntry.type}-${i}`,
      seq: i,
      tick: Number(oldEntry.tick || 0),
      at: Number(oldEntry.at || 0),
      type: oldEntry.type,
      ref: oldEntry.ref ?? null,
      note: oldEntry.note ?? '',
      changes: oldEntry.changes ?? {},
      meta: oldEntry.meta ?? {},
      prevHash,
      hash: '',
    };
    entry.hash = hashEntry(entry);
    prevHash = entry.hash;
    return entry;
  });
}

function migrate(envelope) {
  if (!envelope || typeof envelope !== 'object') throw new Error('存档不是对象');
  if (envelope.version < 2) throw new Error(`不支持从 v${envelope.version} 直接迁移，请先升级到 v2`);
  if (envelope.version > CURRENT_SAVE_VERSION) {
    throw new Error(`存档版本 v${envelope.version} 比程序更新，拒绝降级写入`);
  }
  if (envelope.forceMigrationFailure) throw new Error('模拟迁移失败：损坏标记');

  let { state, ledger } = envelope.data || {};
  if (envelope.version === 2) {
    ledger = rebuildV2Ledger(ledger);
    state = replayLedger(ledger);
    state.lastWallAt = Number(envelope.savedAt || state.lastWallAt || 0);
  }
  assertLedger(ledger);
  const replayed = replayLedger(ledger);
  state.tick = replayed.tick;
  state.lastSettledTick = replayed.lastSettledTick;
  state.balances = replayed.balances;
  state.chambers = replayed.chambers;
  state.exhibits = replayed.exhibits;
  state.totalsProduced = replayed.totalsProduced;
  state.ledgerVersion = 1;
  state.online = false;
  state.lastHeartbeatAt = null;

  return {
    version: CURRENT_SAVE_VERSION,
    savedAt: state.lastWallAt,
    migratedFrom: envelope.version,
    data: { state, ledger },
  };
}

export class MigrationError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'MigrationError';
    this.cause = cause;
  }
}

export async function loadSave(userId, now = Date.now()) {
  const file = fileFor(userId);
  const backup = `${file}${BACKUP_SUFFIX}`;
  let raw;
  try {
    ({ raw } = await readJson(file));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    const fresh = createInitialState(now);
    const envelope = {
      version: CURRENT_SAVE_VERSION,
      savedAt: now,
      data: fresh,
    };
    await writeAtomic(file, envelope);
    return { ...fresh, file, backup, migratedFrom: null };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return restoreBackup({ file, backup, err, now });
  }

  if (parsed.version === CURRENT_SAVE_VERSION) {
    try {
      assertLedger(parsed.data.ledger);
      return { ...parsed.data, file, backup, migratedFrom: null };
    } catch (err) {
      return restoreBackup({ file, backup, err, now });
    }
  }

  // 迁移前保留原 v2/v3 文件；.bak 只允许被“上一份可运行版本”占用。
  if (parsed.version === CURRENT_SAVE_VERSION) {
    await writeAtomic(backup, parsed).catch(() => {});
  }
  try {
    const migrated = migrate(parsed);
    await writeAtomic(file, migrated);
    return { ...migrated.data, file, backup, migratedFrom: parsed.version };
  } catch (err) {
    // 原文件已在迁移前写回；只有存在上一份当前版本备份时才自动恢复。
    try {
      const { envelope: backupEnvelope } = await readJson(backup);
      if (backupEnvelope.version === CURRENT_SAVE_VERSION) {
        const restored = backupEnvelope.data;
        assertLedger(restored.ledger);
        await writeAtomic(file, backupEnvelope);
        return {
          ...restored,
          file,
          backup,
          restoredFromBackup: true,
          migrationRolledBack: true,
          migrationError: String(err.message || err),
        };
      }
    } catch {}
    throw new MigrationError(`旧存档迁移失败；原 v${parsed.version} 存档已保留，可修复后重试`, err);
  }
}

async function restoreBackup({ file, backup, err, now }) {
  try {
    const { envelope } = await readJson(backup);
    if (envelope.version !== CURRENT_SAVE_VERSION) throw new Error('备份不是当前版本');
    assertLedger(envelope.data.ledger);
    await writeAtomic(file, envelope);
    return { ...envelope.data, file, backup, restoredFromBackup: true, corruption: String(err.message || err) };
  } catch (backupErr) {
    const fresh = createInitialState(now);
    const envelope = { version: CURRENT_SAVE_VERSION, savedAt: now, data: fresh, replacedCorruptSave: true };
    await writeAtomic(file, envelope);
    return { ...fresh, file, backup, replacedCorruptSave: true, corruption: String(err.message || err), backupError: String(backupErr.message || backupErr) };
  }
}

export async function saveSave({ file, backup }, state, ledger, now) {
  const current = {
    version: CURRENT_SAVE_VERSION,
    savedAt: now,
    data: { state, ledger },
  };
  let previous = null;
  try {
    previous = await readJson(file);
  } catch {}

  try {
    assertLedger(ledger);
    if (previous?.envelope) await writeAtomic(backup, previous.envelope);
    await writeAtomic(file, current);
  } catch (err) {
    if (previous?.envelope) await writeAtomic(file, previous.envelope);
    throw err;
  }
}

export async function writeLegacyV2ForTest(file, data, savedAt) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeAtomic(file, { version: 2, savedAt, data });
}

export { fileFor };
