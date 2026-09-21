# 微生物文明馆：服务端权威账本验收

## 唯一真源

1. 服务端按玩家保存**仅追加账本** `ledger`。
2. 余额必须能由账本逐条重放得到；每次写入前服务端会校验账本投影与余额一致。
3. 前端 localStorage 只保存视图和离线命令队列，不保存收益，不参与结算。
4. `Idempotency-Key + 命令指纹` 在服务端去重；重复请求返回首次回执，不新增流水。
5. 命令按玩家在服务端串行化；双标签页只会形成不同顺序的单条历史，不会双扣。
6. 存档迁移失败时隔离坏档，优先恢复上一份 last-good 存档；没有可用存档则拒绝启动。

## 一键复现

```bash
npm install
npm run acceptance
```

脚本内置可注入服务端时钟，不依赖修改操作系统时间：

- 8 小时后结算；
- 24 小时后结算，但离线收益上限为 8 小时；
- 服务端时钟回拨 24 小时；
- 同一结算凭证提交两次；
- 两个标签页并发提交 10 次升级，对照单序列 10 次；
- 安装损坏 v1 存档并从 last-good v1 恢复。

最近一次验收输出：

```text
8h 与 24h: methane 8.256 / carbon 1186.24 / nitrogen 297.248 / biomass 121.2384
billableHours: 8, clockRewound: true
credential: proof-settle-once-0001
settlementId: set-61gtlh-nce-0001
entriesAfterFirst: 3, entriesAfterSecond: 3, ethanol ≈ 0.860
concurrent 与 sequential: carbon 887.696344 / nitrogen 221.924086 / biomass 41.924086
restoredSchema: 2, restoredCarbon: 222, quarantinedFiles: 1
```

## HTTP 手工复现

```bash
ENABLE_TEST_ROUTES=1 GAME_DATA_DIR=/tmp/wenming-http PORT=3011 npm run server:dev
```

测试路由只用于注入服务端时钟和重置存档：

```bash
curl -s -X POST http://127.0.0.1:3011/api/test/reset \
  -H 'X-Player-ID: http-proof'
curl -s -X POST http://127.0.0.1:3011/api/test/clock \
  -H 'Content-Type: application/json' \
  -d '{"offsetMs":86400000}'
curl -s -X POST http://127.0.0.1:3011/api/settle \
  -H 'X-Player-ID: http-proof' \
  -H 'Idempotency-Key: http-proof-day'
curl -s -X POST http://127.0.0.1:3011/api/settle \
  -H 'X-Player-ID: http-proof' \
  -H 'Idempotency-Key: http-proof-day'
```

最近一次 HTTP 凭证：

```json
{
  "sameSettlementId": true,
  "settlementEntries": 1,
  "capped": true,
  "billableHours": 8,
  "credential": "http-proof-day",
  "settlementId": "set-rfja6d-roof-day"
}
```

注意：测试服务重启后使用同一个固定凭证可再次验证“同一进程/存档中重复提交只入账一次”；凭证记录在玩家存档中。生产环境不启用 `/api/test/*`。
