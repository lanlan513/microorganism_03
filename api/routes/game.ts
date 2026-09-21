import { Request, Router } from 'express';
import { Command } from '../../shared/civilization.js';
import { ApiError, gameService } from '../src/game/gameService.js';

export const gameRouter = Router();

function playerId(req: Request): string {
  const value = req.header('X-Player-ID') || 'demo-player';
  if (!/^[a-zA-Z0-9_-]{3,64}$/.test(value)) {
    throw new ApiError(400, 'X-Player-ID 只能包含 3-64 位字母、数字、下划线或短横线');
  }
  return value;
}

function idempotencyKey(req: Request): string {
  const value = req.header('Idempotency-Key');
  if (!value) throw new ApiError(400, '缺少 Idempotency-Key 请求头');
  if (!/^[a-zA-Z0-9_:.-]{8,128}$/.test(value)) throw new ApiError(400, '幂等凭证格式错误');
  return value;
}

gameRouter.get('/bootstrap', async (req, res, next) => {
  try {
    res.json({ success: true, data: await gameService.bootstrap(playerId(req)) });
  } catch (error) {
    next(error);
  }
});

gameRouter.post('/settle', async (req, res, next) => {
  try {
    res.json({ success: true, data: await gameService.settle(playerId(req), idempotencyKey(req)) });
  } catch (error) {
    next(error);
  }
});

gameRouter.post('/commands', async (req, res, next) => {
  try {
    const result = await gameService.command(
      playerId(req),
      idempotencyKey(req),
      req.body as Command,
    );
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

gameRouter.get('/ledger', async (req, res, next) => {
  try {
    const limit = Number(req.query.limit ?? 50);
    const beforeSeq = req.query.beforeSeq ? Number(req.query.beforeSeq) : undefined;
    res.json({ success: true, data: await gameService.ledger(playerId(req), limit, beforeSeq) });
  } catch (error) {
    next(error);
  }
});
