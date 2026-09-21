import { useMemo } from 'react';
import {
  Beaker,
  BookCopy,
  CheckCircle2,
  Clock3,
  Database,
  FlaskConical,
  Leaf,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Wifi,
  WifiOff,
} from 'lucide-react';
import {
  COMPARTMENT_LABELS,
  COMPARTMENTS,
  compartmentUpgradeCost,
  EXHIBIT_CATALOG,
  formatSignedResource,
  LedgerEntry,
  METABOLISM_LABELS,
  MICROBE_CATALOG,
  RESOURCE_LABELS,
  RESOURCES,
  ResourceKey,
} from '../../shared/civilization';
import { useGameStore } from '../store/useGameStore';

const COMPARTMENT_ICONS = {
  hotSpring: FlaskConical,
  gut: Beaker,
  soil: Leaf,
};

function ResourceChip({ resource, value, tone = 'default' }: { resource: ResourceKey; value: number; tone?: 'default' | 'strong' }) {
  return (
    <div className={`rounded-xl border px-3 py-2 ${tone === 'strong' ? 'border-glow-primary/40 bg-glow-primary/10' : 'border-white/10 bg-white/5'}`}>
      <div className="text-[10px] text-text-muted">{RESOURCE_LABELS[resource]}</div>
      <div className="font-semibold text-sm">{value.toFixed(2)}</div>
    </div>
  );
}

function DeltaCell({ deltas }: { deltas: LedgerEntry['deltas'] }) {
  const keys = RESOURCES.filter((key) => Math.abs(deltas[key] ?? 0) >= 0.000001);
  if (keys.length === 0) return <span className="text-text-muted">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {keys.map((key) => (
        <span
          key={key}
          className={`rounded px-1.5 py-0.5 text-xs ${deltas[key]! < 0 ? 'bg-glow-red/10 text-glow-red' : 'bg-glow-primary/10 text-glow-primary'}`}
        >
          {RESOURCE_LABELS[key]} {formatSignedResource(deltas[key]!)}
        </span>
      ))}
    </div>
  );
}

function LedgerBook() {
  const ledger = useGameStore((state) => state.ledger);
  const optimisticEntries = useGameStore((state) => state.optimisticEntries);
  const nextBeforeSeq = useGameStore((state) => state.nextBeforeSeq);
  const loadMoreLedger = useGameStore((state) => state.loadMoreLedger);
  const refreshLedger = useGameStore((state) => state.refreshLedger);

  return (
    <section className="glass-card flex h-[560px] flex-col overflow-hidden">
      <header className="flex items-center justify-between border-b border-white/10 p-4">
        <div>
          <h2 className="flex items-center gap-2 font-display text-2xl text-glow-primary">
            <BookCopy size={22} /> 资源流水账本
          </h2>
          <p className="text-xs text-text-muted">只追加、不分叉；余额由服务端流水重放得出</p>
        </div>
        <button className="btn-primary-ghost" onClick={() => refreshLedger()}>
          <RefreshCw size={14} /> 对账
        </button>
      </header>
      <div className="flex-1 overflow-y-auto p-3">
        <table className="w-full min-w-[680px] text-left text-xs">
          <thead className="sticky top-0 bg-background-card/95 text-text-muted backdrop-blur">
            <tr>
              <th className="p-2">#</th>
              <th className="p-2">事项</th>
              <th className="p-2">增减</th>
              <th className="p-2">凭证 / 服务端时间</th>
            </tr>
          </thead>
          <tbody>
            {optimisticEntries.map((entry) => (
              <tr key={entry.key} className="border-b border-white/5 opacity-60">
                <td className="p-2 text-glow-gold">待</td>
                <td className="p-2">{entry.reason}</td>
                <td className="p-2"><DeltaCell deltas={entry.deltas} /></td>
                <td className="p-2 text-glow-gold">本地队列：{entry.key.slice(0, 24)}…</td>
              </tr>
            ))}
            {ledger.map((entry) => (
              <tr key={entry.id} className="border-b border-white/5 hover:bg-white/5">
                <td className="p-2 text-text-muted">{entry.seq}</td>
                <td className="p-2">{entry.reason}</td>
                <td className="p-2"><DeltaCell deltas={entry.deltas} /></td>
                <td className="p-2 text-text-muted">
                  <div className="break-all">{entry.idempotencyKey.slice(0, 34)}</div>
                  <div>{new Date(entry.serverTime).toLocaleString('zh-CN', { hour12: false })}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {nextBeforeSeq && (
        <button className="border-t border-white/10 p-3 text-sm text-glow-primary hover:bg-glow-primary/10" onClick={loadMoreLedger}>
          向前加载更早账本
        </button>
      )}
    </section>
  );
}

function CompartmentPanel({ compartment }: { compartment: (typeof COMPARTMENTS)[number] }) {
  const snapshot = useGameStore((state) => state.snapshot);
  const sendCommand = useGameStore((state) => state.sendCommand);
  if (!snapshot) return null;
  const state = snapshot.state.compartments[compartment];
  const Icon = COMPARTMENT_ICONS[compartment];
  const cost = compartmentUpgradeCost(state.level);
  const microbes = MICROBE_CATALOG.filter((item) => item.compartment === compartment);

  return (
    <article className="glass-card p-4">
      <header className="mb-3 flex items-center justify-between">
        <h3 className="flex items-center gap-2 font-display text-2xl">
          <Icon className="text-glow-primary" /> {COMPARTMENT_LABELS[compartment]}
        </h3>
        <span className="rounded-full border border-glow-primary/30 px-2 py-1 text-xs">Lv.{state.level}</span>
      </header>
      <div className="mb-3 flex flex-wrap gap-2">
        {state.microbes.length === 0 && <span className="text-xs text-text-muted">空舱：请选择一种微生物</span>}
        {state.microbes.map((id) => {
          const spec = MICROBE_CATALOG.find((item) => item.id === id);
          return <span key={id} className="rounded-full bg-glow-primary/10 px-2 py-1 text-xs">{spec?.emoji} {spec?.name}</span>;
        })}
      </div>
      <div className="grid gap-2">
        {microbes.map((microbe) => (
          <button
            key={microbe.id}
            disabled={state.microbes.includes(microbe.id)}
            className="rounded-xl border border-white/10 bg-white/5 p-3 text-left text-sm hover:border-glow-primary/50 disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => sendCommand({ type: 'inoculate', compartment, microbeId: microbe.id })}
          >
            <div className="flex justify-between">
              <span>{microbe.emoji} {microbe.name}</span>
              <span className="text-xs text-glow-primary">{state.microbes.includes(microbe.id) ? '已入舱' : '入舱'}</span>
            </div>
            <p className="text-xs text-text-muted">{microbe.latin} · {METABOLISM_LABELS[microbe.metabolism]}</p>
            <p className="mt-1 text-xs text-text-muted">
              每小时耗碳 {microbe.input.carbon} / 氮 {microbe.input.nitrogen}
            </p>
          </button>
        ))}
      </div>
      <button
        className="btn-primary mt-3 w-full text-sm"
        onClick={() => sendCommand({ type: 'upgradeCompartment', compartment })}
      >
        升级舱室：碳 {cost.carbon.toFixed(1)}，氮 {cost.nitrogen.toFixed(1)}，生物质 {cost.biomass.toFixed(1)}
      </button>
    </article>
  );
}

function ExhibitPanel() {
  const snapshot = useGameStore((state) => state.snapshot);
  const sendCommand = useGameStore((state) => state.sendCommand);
  if (!snapshot) return null;
  return (
    <section className="glass-card p-4">
      <h2 className="mb-3 font-display text-2xl text-glow-gold">馆藏展台</h2>
      <div className="grid gap-3 md:grid-cols-3">
        {EXHIBIT_CATALOG.map((exhibit) => {
          const lit = snapshot.state.exhibits.includes(exhibit.id);
          return (
            <button
              key={exhibit.id}
              disabled={lit}
              onClick={() => sendCommand({ type: 'curateExhibit', exhibitId: exhibit.id })}
              className={`rounded-2xl border p-4 text-left ${lit ? 'border-glow-gold/60 bg-glow-gold/10' : 'border-white/10 bg-white/5 hover:border-glow-gold/50'}`}
            >
              <div className="mb-2 flex items-center justify-between">
                <strong>{exhibit.name}</strong>
                {lit && <CheckCircle2 className="text-glow-gold" size={18} />}
              </div>
              <p className="mb-3 text-xs text-text-muted">{exhibit.description}</p>
              <div className="flex flex-wrap gap-1 text-xs">
                {RESOURCES.filter((key) => exhibit.cost[key] > 0).map((key) => (
                  <span key={key} className="rounded bg-black/20 px-1.5 py-0.5">
                    {RESOURCE_LABELS[key]} {exhibit.cost[key]}
                  </span>
                ))}
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}

export function GamePage() {
  const ready = useGameStore((state) => state.ready);
  const snapshot = useGameStore((state) => state.snapshot);
  const computedBalances = useGameStore((state) => state.computedBalances);
  const optimisticEntries = useGameStore((state) => state.optimisticEntries);
  const pending = useGameStore((state) => state.pending);
  const online = useGameStore((state) => state.online);
  const notice = useGameStore((state) => state.notice);
  const lastReceipt = useGameStore((state) => state.lastReceipt);
  const settle = useGameStore((state) => state.settle);

  const optimisticBalances = useMemo(() => {
    const balances = snapshot ? { ...snapshot.state.balances } : null;
    if (!balances) return null;
    for (const entry of optimisticEntries) {
      for (const key of RESOURCES) balances[key] += entry.deltas[key] ?? 0;
    }
    return balances;
  }, [snapshot, optimisticEntries]);

  if (!ready || !snapshot || !optimisticBalances) {
    return <div className="flex min-h-screen items-center justify-center"><Loader2 className="animate-spin" /></div>;
  }

  const state = snapshot.state;

  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <header className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.3em] text-glow-primary">Microbial Civilization</p>
          <h1 className="font-display text-5xl text-gradient-primary">微生物文明馆</h1>
          <p className="mt-2 max-w-2xl text-sm text-text-muted">
            选择热泉、肠道、土壤中的微生物，观察它们消耗碳氮并产出甲烷、酒精与抗生素。资源数字以服务端账本为准，本地只展示乐观视图。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded-full border px-3 py-1 text-xs ${online ? 'border-glow-primary/40 text-glow-primary' : 'border-glow-orange/50 text-glow-orange'}`}>
            {online ? <Wifi className="mr-1 inline" size={14} /> : <WifiOff className="mr-1 inline" size={14} />}
            {online ? '在线' : `离线队列 ${pending.length}`}
          </span>
          <button className="btn-primary text-sm" onClick={() => settle()}>
            <Clock3 size={16} /> 服务端结算
          </button>
        </div>
      </header>

      <div className="mb-4 grid gap-3 md:grid-cols-3">
        <div className="glass-card p-4">
          <div className="flex items-center gap-2 text-sm text-text-muted"><ShieldCheck size={16} /> 生态稳定度</div>
          <div className="mt-2 flex items-end gap-3">
            <strong className="text-4xl text-glow-primary">{state.stability}</strong>
            <span className="pb-1 text-xs">文明等级 Lv.{state.civilizationLevel}</span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded bg-black/30">
            <div className="h-full bg-glow-primary" style={{ width: `${state.stability}%` }} />
          </div>
        </div>
        <div className="glass-card p-4 md:col-span-2">
          <div className="mb-2 flex items-center gap-2 text-sm text-text-muted"><Database size={16} /> 账本投影余额</div>
          <div className="grid grid-cols-3 gap-2 md:grid-cols-6">
            {RESOURCES.map((key) => <ResourceChip key={key} resource={key} value={optimisticBalances[key]} />)}
          </div>
          <p className="mt-2 text-[11px] text-text-muted">
            服务端流水重放值：碳 {computedBalances.carbon.toFixed(2)} / 氮 {computedBalances.nitrogen.toFixed(2)}；乐观项 {optimisticEntries.length}
          </p>
        </div>
      </div>

      {notice && <div className="mb-4 rounded-xl border border-glow-gold/40 bg-glow-gold/10 p-3 text-sm">{notice}</div>}

      <div className="mb-4 grid gap-4 lg:grid-cols-3">
        {COMPARTMENTS.map((compartment) => <CompartmentPanel key={compartment} compartment={compartment} />)}
      </div>

      <div className="mb-4"><ExhibitPanel /></div>

      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <LedgerBook />
        <aside className="glass-card h-[560px] overflow-y-auto p-4">
          <h2 className="mb-3 font-display text-2xl text-glow-primary">幂等凭证</h2>
          {lastReceipt ? (
            <>
              <pre className="whitespace-pre-wrap break-all rounded-xl bg-black/30 p-3 text-xs">{lastReceipt}</pre>
              <button className="btn-primary-ghost mt-3 w-full" onClick={() => navigator.clipboard.writeText(lastReceipt)}>
                复制凭证
              </button>
            </>
          ) : (
            <p className="text-sm text-text-muted">提交一次结算或升级后，可拿同凭证重复提交验收。</p>
          )}
          <div className="mt-6 rounded-xl border border-white/10 bg-white/5 p-3 text-xs leading-6 text-text-muted">
            <p>1. 客户端时间不参与收益。</p>
            <p>2. 离线收益最多结算 8 小时。</p>
            <p>3. 时钟回拨只标记，不倒扣、不预支。</p>
            <p>4. 同账号命令在服务端串行执行。</p>
            <p>5. 迁移失败会隔离坏档并恢复 last-good。</p>
          </div>
        </aside>
      </div>
    </div>
  );
}
