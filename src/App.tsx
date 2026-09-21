import { useEffect, useState } from 'react';
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  BookOpen,
  DatabaseBackup,
  FlaskConical,
  Leaf,
  Lock,
  RefreshCw,
  ScrollText,
  ShieldCheck,
  Sparkles,
  Waves,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { RESOURCE_ORDER, useGameStore } from './useGameStore';
import type { ChamberId, ResourceKey } from './game-types';

const RESOURCE_NAME: Record<ResourceKey, string> = {
  carbon: '碳',
  nitrogen: '氮',
  methane: '甲烷',
  alcohol: '酒精',
  antibiotic: '抗生素',
};

const RESOURCE_STYLE: Record<ResourceKey, string> = {
  carbon: 'text-amber-200',
  nitrogen: 'text-sky-200',
  methane: 'text-emerald-300',
  alcohol: 'text-fuchsia-300',
  antibiotic: 'text-rose-300',
};

const CHAMBER_ICON: Record<ChamberId, unknown> = {
  hotSpring: Waves,
  gut: FlaskConical,
  soil: Leaf,
};

function compact(value: number) {
  return new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function timeText(tick: number) {
  const hours = Math.floor(tick / 3_600_000);
  const minutes = Math.floor((tick % 3_600_000) / 60_000);
  return `${hours}h ${minutes}m`;
}

export default function App() {
  const { view, ledger, queue, syncing, error, load, settle, upgrade, unlock, reset, flushQueue } = useGameStore();
  const [settleRef, setSettleRef] = useState<string | null>(null);

  useEffect(() => {
    load();
  }, [load]);

  const receipt = view ? `账本 #${view.ledgerCount} · ${view.lastEntryHash.slice(0, 10)}` : '连接服务端中';
  const activeChambers = view
    ? Object.values(view.chambers).filter((chamber) => chamber.unlocked && chamber.level > 0).length
    : 0;

  const doSettle = async () => {
    const result = await settle();
    if (result?.ref) setSettleRef(result.ref);
  };

  return (
    <div className="min-h-screen text-slate-100 bg-[#071411]">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_20%_0%,rgba(20,184,166,.18),transparent_35%),radial-gradient(circle_at_85%_15%,rgba(217,70,239,.12),transparent_30%)]" />
      <header className="relative border-b border-emerald-400/10 bg-black/20 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-4 px-6 py-5">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-emerald-400/10 ring-1 ring-emerald-300/30">
            <Activity className="h-6 w-6 text-emerald-300" />
          </div>
          <div className="mr-auto">
            <p className="text-xs uppercase tracking-[.35em] text-emerald-200/60">Microbial Civilization</p>
            <h1 className="text-2xl font-semibold tracking-wide">文明馆</h1>
          </div>
          <div className="rounded-full border border-white/10 px-3 py-1.5 text-xs text-slate-300">{receipt}</div>
          <div className={`flex items-center gap-2 rounded-full px-3 py-1.5 text-xs ${navigator.onLine ? 'bg-emerald-400/10 text-emerald-200' : 'bg-amber-400/10 text-amber-200'}`}>
            {navigator.onLine ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
            {navigator.onLine ? '服务端在线' : `离线队列 ${queue.length}`}
          </div>
        </div>
      </header>

      <main className="relative mx-auto grid max-w-7xl gap-6 px-6 py-8 lg:grid-cols-[1.05fr_.95fr]">
        <section className="space-y-6">
          {error && (
            <div className="rounded-2xl border border-rose-300/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
              {error}
            </div>
          )}
          {view?.migration && (view.migration.restoredFromBackup || view.migration.migratedFrom) && (
            <div className="flex items-center gap-3 rounded-2xl border border-sky-300/25 bg-sky-400/10 px-4 py-3 text-sm text-sky-100">
              <DatabaseBackup className="h-4 w-4 shrink-0" />
              {view.migration.restoredFromBackup
                ? `检测到存档/迁移异常，已回退上一份可用存档：${view.migration.error || '哈希校验失败'}`
                : `存档已从 v${view.migration.migratedFrom} 迁移至 v3。`}
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-3">
            <StatusCard label="文明等级" value={view ? `Lv.${view.civilizationLevel}` : '--'} detail={view ? `稳定度 ${Math.round(view.stability * 100)}%` : ''} />
            <StatusCard label="生态年龄" value={view ? timeText(view.tick) : '--'} detail={`${activeChambers} 个活跃舱室`} />
            <StatusCard label="馆藏积累" value={view ? compact(view.cumulativeProducts) : '--'} detail="产物累计，不含库存消耗" />
          </div>

          <div className="rounded-3xl border border-emerald-300/15 bg-white/[.03] p-5 shadow-2xl shadow-emerald-950/20">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold">三种舱室</h2>
                <p className="text-sm text-slate-400">升级先结算，再扣费；重复凭证返回同一张回执。</p>
              </div>
              <button onClick={doSettle} className="rounded-full bg-emerald-300 px-4 py-2 text-sm font-semibold text-emerald-950 transition hover:bg-emerald-200">
                立即结算
              </button>
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              {view && (Object.keys(view.chamberDefs) as ChamberId[]).map((id) => (
                <ChamberPanel key={id} id={id} onUpgrade={() => upgrade(id)} />
              ))}
            </div>
          </div>

          <div className="rounded-3xl border border-fuchsia-300/15 bg-white/[.03] p-5">
            <div className="mb-4 flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-fuchsia-300" />
              <h2 className="text-lg font-semibold">馆藏展品</h2>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {view?.exhibits.map((exhibit) => {
                const unlocked = Boolean(view.unlockedExhibits[exhibit.id]);
                return (
                  <button
                    key={exhibit.id}
                    disabled={unlocked}
                    onClick={() => unlock(exhibit.id)}
                    className={`rounded-2xl border p-4 text-left transition ${unlocked ? 'border-emerald-300/30 bg-emerald-400/10' : 'border-white/10 bg-black/20 hover:border-fuchsia-300/40 hover:bg-fuchsia-400/5'}`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{exhibit.name}</span>
                      {unlocked ? <ShieldCheck className="h-4 w-4 text-emerald-300" /> : <Lock className="h-4 w-4 text-slate-500" />}
                    </div>
                    <p className="mt-2 text-xs text-slate-400">
                      {Object.entries(exhibit.cost).map(([k, v]) => `${RESOURCE_NAME[k as ResourceKey]} ${v}`).join(' · ')}
                    </p>
                  </button>
                );
              })}
            </div>
          </div>
        </section>

        <aside className="space-y-6">
          <div className="rounded-3xl border border-white/10 bg-white/[.03] p-5">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-[.25em] text-slate-400">当前库存（含未结算预览）</h2>
            <div className="space-y-3">
              {RESOURCE_ORDER.map((key) => (
                <div key={key} className="flex items-center justify-between rounded-2xl bg-black/20 px-4 py-3">
                  <span className="text-sm text-slate-300">{RESOURCE_NAME[key]}</span>
                  <span className={`font-mono text-lg ${RESOURCE_STYLE[key]}`}>{view ? compact(view.balances[key]) : '--'}</span>
                </div>
              ))}
            </div>
            <div className="mt-4 flex flex-wrap gap-2 text-xs text-slate-400">
              <button onClick={flushQueue} className="rounded-full border border-white/10 px-3 py-1.5 hover:bg-white/5">
                {syncing ? '队列重放中…' : `重放本地队列 (${queue.length})`}
              </button>
              <button onClick={() => { if (confirm('重置服务端存档和本地队列？')) reset(); }} className="rounded-full border border-rose-300/30 px-3 py-1.5 text-rose-200 hover:bg-rose-400/10">
                重置存档
              </button>
            </div>
            {settleRef && <p className="mt-3 break-all text-xs text-slate-500">最近结算凭证：{settleRef}</p>}
          </div>

          <div className="flex h-[640px] flex-col overflow-hidden rounded-3xl border border-emerald-300/15 bg-[#081815]">
            <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
              <div className="flex items-center gap-2">
                <BookOpen className="h-5 w-5 text-emerald-300" />
                <div>
                  <h2 className="font-semibold">资源流水账本</h2>
                  <p className="text-xs text-slate-500">append-only；余额只是缓存，重放流水验真</p>
                </div>
              </div>
              <ScrollText className="h-4 w-4 text-slate-500" />
            </div>
            <div className="flex-1 space-y-2 overflow-y-auto p-4">
              {[...ledger].reverse().map((entry) => (
                <article key={entry.id} className="rounded-2xl border border-white/8 bg-white/[.025] p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-slate-100">#{entry.seq} {entry.note}</p>
                      <p className="mt-1 font-mono text-[10px] text-slate-600">{entry.hash}</p>
                    </div>
                    <div className="shrink-0 text-right">
                      {Object.entries(entry.changes).filter(([, v]) => v !== 0).map(([key, value]) => (
                        <div key={key} className={`flex items-center justify-end gap-1 font-mono text-xs ${Number(value) > 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
                          {Number(value) > 0 ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
                          {RESOURCE_NAME[key as ResourceKey]} {Number(value) > 0 ? '+' : ''}{compact(Number(value))}
                        </div>
                      ))}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </aside>
      </main>
    </div>
  );
}

function StatusCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-3xl border border-white/10 bg-white/[.03] p-5">
      <p className="text-xs uppercase tracking-[.22em] text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-emerald-100">{value}</p>
      <p className="mt-1 text-xs text-slate-500">{detail}</p>
    </div>
  );
}

function ChamberPanel({ id, onUpgrade }: { id: ChamberId; onUpgrade: () => void }) {
  const view = useGameStore((state) => state.view);
  if (!view) return null;
  const chamber = view.chambers[id];
  const def = view.chamberDefs[id];
  const Icon = CHAMBER_ICON[id] as typeof FlaskConical;
  const canSee = chamber.unlocked || view.cumulativeProducts >= def.unlockAt;

  return (
    <div className={`rounded-2xl border p-4 ${chamber.unlocked ? 'border-emerald-300/20 bg-black/20' : 'border-white/10 bg-black/10 opacity-80'}`}>
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-emerald-400/10 p-2"><Icon className="h-5 w-5 text-emerald-300" /></div>
          <div>
            <h3 className="font-semibold">{def.name}</h3>
            <p className="text-xs text-slate-500">Lv.{chamber.level}</p>
          </div>
        </div>
        {!chamber.unlocked && <Lock className="h-4 w-4 text-slate-500" />}
      </div>
      <p className="mt-3 min-h-12 text-xs leading-5 text-slate-400">{canSee ? def.description : `累计 ${def.unlockAt} 产物后点亮`}</p>
      <p className="mt-2 text-xs text-slate-500">{def.microbes.join(' · ')}</p>
      <button
        onClick={onUpgrade}
        disabled={!canSee}
        className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-full border border-emerald-300/25 px-3 py-2 text-sm text-emerald-200 transition hover:bg-emerald-300/10 disabled:cursor-not-allowed disabled:opacity-30"
      >
        <RefreshCw className="h-3.5 w-3.5" />
        升级 / 点亮 · 碳{12 * (chamber.level + 1)} 氮{8 * (chamber.level + 1)}
      </button>
    </div>
  );
}
