import type {
  BootstrapResponse,
  Command,
  LedgerPage,
  MutationResponse,
  SettleResponse,
} from '../../shared/civilization';

const API_BASE = '/api';

export class ApiFailure extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

interface Envelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  const payload = (await res.json()) as Envelope<T>;
  if (!res.ok || !payload.success || !payload.data) {
    throw new ApiFailure(
      payload.error?.message ?? '请求失败',
      res.status,
      payload.error?.code ?? 'UNKNOWN',
    );
  }
  return payload.data;
}

function playerHeaders(extra?: HeadersInit): HeadersInit {
  return {
    'X-Player-ID': localStorage.getItem('wenming-player-id') ?? 'demo-player',
    ...extra,
  };
}

export function idempotencyKey(prefix: string): string {
  if (globalThis.crypto?.randomUUID) return `${prefix}-${globalThis.crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export const gameApi = {
  bootstrap: () => request<BootstrapResponse>('/bootstrap', { headers: playerHeaders() }),

  settle: (key: string) => request<SettleResponse>('/settle', {
    method: 'POST',
    headers: playerHeaders({ 'Idempotency-Key': key }),
  }),

  command: (key: string, command: Command) => request<MutationResponse>('/commands', {
    method: 'POST',
    headers: playerHeaders({ 'Idempotency-Key': key }),
    body: JSON.stringify(command),
  }),

  ledger: (limit = 50, beforeSeq?: number) => {
    const query = new URLSearchParams({ limit: String(limit) });
    if (beforeSeq) query.set('beforeSeq', String(beforeSeq));
    return request<LedgerPage>(`/ledger?${query.toString()}`, { headers: playerHeaders() });
  },
};

export async function isNetworkFailure(error: unknown): Promise<boolean> {
  return error instanceof TypeError || (error instanceof ApiFailure && error.status === 0);
}
