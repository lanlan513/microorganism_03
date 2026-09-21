import type { GameView, LedgerPage, MutationResponse } from './game-types';

const API_BASE = '/api';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  const body = await response.json();
  if (!response.ok || body.success !== true) {
    const error = new Error(body.error || `请求失败：${response.status}`) as Error & { status: number };
    error.status = response.status;
    throw error;
  }
  return body.data as T;
}

export function makeRef(prefix: string) {
  if (window.crypto?.randomUUID) return `${prefix}_${window.crypto.randomUUID()}`;
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export const gameApi = {
  state: () => request<GameView>('/state'),
  ledger: (limit = 100, offset = 0) =>
    request<LedgerPage>(`/ledger?limit=${limit}&offset=${offset}`),
  heartbeat: () => request<GameView>('/heartbeat', { method: 'POST', body: '{}' }),
  settle: (ref: string) =>
    request<MutationResponse>('/settle', { method: 'POST', body: JSON.stringify({ ref }) }),
  upgrade: (chamberId: string, ref: string) =>
    request<MutationResponse>('/actions/upgrade', {
      method: 'POST',
      body: JSON.stringify({ chamberId, ref }),
    }),
  unlock: (exhibitId: string, ref: string) =>
    request<MutationResponse>('/actions/unlock', {
      method: 'POST',
      body: JSON.stringify({ exhibitId, ref }),
    }),
  reset: () => request<GameView>('/reset', { method: 'POST', body: '{}' }),
};
