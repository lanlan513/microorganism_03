import express from 'express';
import cors from 'cors';
import { apiRouter } from './routes/index.mjs';

const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/', (_req, res) => {
  res.json({
    name: '文明馆：服务端权威养菌存档',
    sourceOfTruth: 'server append-only ledger',
    endpoints: [
      'GET /api/state',
      'POST /api/heartbeat',
      'POST /api/settle {ref}',
      'POST /api/actions/upgrade {ref, chamberId}',
      'POST /api/actions/unlock {ref, exhibitId}',
      'GET /api/ledger',
      'POST /api/reset',
    ],
  });
});

app.use('/api', apiRouter);
app.use((_req, res) => res.status(404).json({ success: false, error: '接口不存在' }));

export default app;
