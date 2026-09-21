# 文明馆：服务端权威微生物养成

三种舱室（热泉、肠道、土壤）中，古菌、酵母、拟杆菌、链霉菌、根瘤菌消耗碳氮，产出甲烷、酒精和抗生素。产物可点亮馆藏、解锁舱室，文明等级随生态稳定度提升。

## 唯一真源

**服务端 append-only ledger（资源流水）是唯一真源**。

- 服务端存档：`data.state.balances`、舱室等级、展品都只是账本物化缓存。
- 每条流水都有 `seq / type / ref / changes / prevHash / hash`。
- 启动、迁移、验收时都可从第 0 条 genesis 逐笔重放，重建全部余额和舱室等级。
- 前端显示的库存是“服务端已确认状态 + 未确认乐观操作”的临时投影；服务端拒绝即回滚。
- 前端本地队列只保存待提交操作，永不参与权威收益计算。

## 时间模型

- 在线游戏时间只来自服务端 monotonic clock（`performance.now()` 的封装）。
- `Date.now()` 只用于展示、心跳记录和冷启动时估算离线。
- 在线时把系统时钟向后拨一天：tick 不变，收益不变；回拨事件进入 `clockEvents`。
- 冷启动离线时间按服务端保存的 wall timestamp 计算，硬上限为 8 小时：
  `MAX_OFFLINE_MS = 8 * 60 * 60 * 1000`。
- 冷启动时若 wall clock 早于存档时间，离线收益为 0。

## 幂等与并发

- 所有结算/升级/点亮都必须携带客户端生成的 UUID 凭证 `ref`。
- 服务端以 `(type, ref)` 查重；重复提交返回同一张 receipt，不再新增流水、不再改变余额。
- 每个用户有一条服务端 FIFO 串行队列，两个标签页同时升级也只会形成一个确定的串行账本。
- 浏览器使用 Web Locks API 串行化本地写操作；离线操作进入 localStorage 队列，恢复网络后按序重放。
- 乐观更新失败时，前端丢弃该投影并重新应用仍在队列中的操作，避免“扣了两次/少一笔”。

## 存档版本与回退

当前存档版本为 v3。

- 写入采用临时文件 + atomic rename。
- 每次成功写入前保留上一份 v3 为 `.bak`。
- v2 → v3 会重建哈希链并重放物化状态。
- 迁移失败时不覆盖原存档；如果存在上一份可用 v3 `.bak`，自动恢复它。
- 当前 JSON 损坏时同样优先恢复 `.bak`。

## 本地运行

```bash
npm ci
npm run dev
```

- 前端：http://localhost:5173
- API：http://localhost:3001
- 存档目录：`./data/`（可用 `CIV_DATA_DIR` 覆盖）

## 验收命令

```bash
# 纯引擎/时钟/迁移验收：18 项
npm run acceptance

# 真实 HTTP 端到端验收：重复凭证、10 个并发升级、24 小时离线截断
npm run acceptance:http

npm run lint
npm run check
npm run build
```

`acceptance:http` 会当场打印可复现凭证，例如：

```text
POST /api/settle { "ref": "acceptance-..." } -> entry=settle_acceptance-...
```

拿同一个 body 再提交一次，第二次返回：

```json
{ "duplicate": true, "entryId": "settle_acceptance-..." }
```

并且 `GET /api/ledger` 的条目数和 `verifiedSum` 不变。

## 关键数字

- 热泉舱每秒：消耗 3 碳、1 氮，产出 2 甲烷。
- 系统时钟在线向后调 1 天，测试只推进 2,000ms monotonic 时间，因此只产出 4 甲烷。
- 离线 24 小时或 3 天都截断为 8 小时；热泉舱最多入账 57,600 甲烷。
- 10 次热泉升级的总扣费：碳 -780、氮 -520；舱室从 Lv.1 到 Lv.11。
