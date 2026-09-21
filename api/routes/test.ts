import { Request, Router } from 'express';
import { getClockOffset, setClockOffset } from '../src/game/clock.js';
import { gameService } from '../src/game/gameService.js';

export const testRouter = Router();

function playerId(req: Request): string {
  return req.header('X-Player-ID') || 'acceptance-player';
}

testRouter.post('/reset', async (req, res, next) => {
  try {
    setClockOffset(0);
    await gameService.resetForTest(playerId(req));
    res.json({ success: true, data: { reset: true, offsetMs: 0 } });
  } catch (error) {
    next(error);
  }
});

testRouter.post('/migration-failure', async (req, res, next) => {
  try {
    const id = playerId(req);
    const validV1 = {
      version: 1,
      playerId: id,
      resources: { carbon: 222, nitrogen: 33, methane: 4 },
      chambers: { hotSpring: { level: 2 } },
      lastTick: Date.now() - 60_000,
    };
    await gameService.installBrokenV1ForTest(id, (req.body as { noLastGood?: boolean } | undefined)?.noLastGood ? undefined : validV1);
    const restored = await gameService.bootstrap(id);
    res.json({
      success: true,
      data: {
        restored: true,
        schemaVersion: restored.snapshot.schemaVersion,
        carbon: restored.snapshot.state.balances.carbon,
        quarantineMessage: '损坏的 v1 当前档已隔离，并已从上一份可用 v1 迁移恢复',
      },
    });
  } catch (error) {
    next(error);
  }
});

testRouter.post('/clock', async (req, res) => {
  const offsetMs = Number((req.body as { offsetMs?: unknown }).offsetMs);
  if (!Number.isFinite(offsetMs)) {
    res.status(400).json({ success: false, error: { code: 'BAD_CLOCK', message: 'offsetMs 必须是数字' } });
    return;
  }
  setClockOffset(offsetMs);
  res.json({ success: true, data: { offsetMs: getClockOffset() } });
});
