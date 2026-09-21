import cors from 'cors';
import express from 'express';
import { gameRouter } from './routes/game.js';
import { testRouter } from './routes/test.js';
import { ApiError } from './src/game/gameService.js';

const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/', (_req, res) => {
  res.json({
    name: '微生物文明馆 API',
    version: '2.0.0',
    sourceOfTruth: 'server-side append-only ledger',
    endpoints: {
      'GET /api/bootstrap': '获取存档快照与图鉴',
      'POST /api/settle': '按服务端时钟结算（需要 Idempotency-Key）',
      'POST /api/commands': '提交入舱/升级/点亮命令（需要 Idempotency-Key）',
      'GET /api/ledger': '分页读取服务端流水账本',
    },
  });
});

app.use('/api', gameRouter);
if (process.env.NODE_ENV === 'test' || process.env.ENABLE_TEST_ROUTES === '1') {
  app.use('/api/test', testRouter);
}

app.use((_req, res) => {
  res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '接口不存在' } });
});

app.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  void next;
  if (error instanceof ApiError) {
    res.status(error.status).json({ success: false, error: { code: error.code, message: error.message } });
    return;
  }
  console.error(error);
  res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: '服务端处理失败' } });
});

export default app;
