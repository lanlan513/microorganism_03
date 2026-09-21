import { Router } from 'express';
import {
  getLedger,
  heartbeat,
  mutateGame,
  resetGame,
  settleGame,
  viewGame,
} from '../src/gameService.mjs';

export const apiRouter = Router();

function userOf(req) {
  return String(req.query.user || req.body?.user || 'demo');
}

function ok(res, data) {
  res.json({ success: true, data });
}

function fail(res, err) {
  res.status(err.status || 409).json({ success: false, error: err.message || String(err) });
}

apiRouter.get('/health', (_req, res) => ok(res, { service: 'civilization-museum', authoritative: 'server-ledger' }));
apiRouter.get('/state', async (req, res) => {
  try { ok(res, await viewGame(userOf(req))); } catch (err) { fail(res, err); }
});
apiRouter.post('/heartbeat', async (req, res) => {
  try { ok(res, await heartbeat(userOf(req))); } catch (err) { fail(res, err); }
});
apiRouter.post('/settle', async (req, res) => {
  try { ok(res, await settleGame(userOf(req), req.body || {})); } catch (err) { fail(res, err); }
});
apiRouter.post('/actions/upgrade', async (req, res) => {
  try { ok(res, await mutateGame(userOf(req), 'upgrade', req.body || {})); } catch (err) { fail(res, err); }
});
apiRouter.post('/actions/unlock', async (req, res) => {
  try { ok(res, await mutateGame(userOf(req), 'unlock', req.body || {})); } catch (err) { fail(res, err); }
});
apiRouter.get('/ledger', async (req, res) => {
  try {
    ok(res, await getLedger(userOf(req), { limit: req.query.limit, offset: req.query.offset }));
  } catch (err) { fail(res, err); }
});
apiRouter.post('/reset', async (req, res) => {
  try { ok(res, await resetGame(userOf(req))); } catch (err) { fail(res, err); }
});
