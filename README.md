# 儿童椅实体资源预约与排座系统

把现场儿童椅从「抽象占位」升级为**可追踪的实体资源预约**：每把椅子有完整生命周期，
儿童宾客席与匿名儿童椅占位必须绑定具体资源；自动/手工排座同时满足桌容量、锁定、
关系约束且儿童椅不超卖；资源故障或撤回不挪动已锁定席，只挂「待处理方案」由人工决定；
所有预留、转移、释放幂等、可回滚、可审计。

## 模型与状态

**椅子实体**（`chairs`）生命周期：

```
available(可用) ──预留──▶ reserved(已预留) ──布置──▶ deployed(已布置)
     ▲                       │                         │
     │清点回库                │释放/换桌                │撤场
     └──── returned(已归还) ◀─┴─────────────────────────┘
reserved/deployed ──故障──▶ faulty ──修复──▶ reserved/deployed（keep）或 available（空闲）
任何状态 ──撤回──▶ decommissioned(停用)
```

**预约**（`reservations`）：active / released / transferred / replaced / revoked，记录完整 history。
**席位**（`seats`）：桌卡标签 `tableCardLabel`、`locked`、`anonymous` 占位、`requiresChair`。
**待处理方案**（`issues`）：资源故障/撤回时生成，只能人工 `replace` / `revoke` / `keep` 解决。

核心不变量（每次事务提交前断言）：

1. **强绑定**：每个儿童宾客席 / 匿名儿童占位都存在一条 active 实体椅预约；无可用椅时直接拒绝建座（`NO_CHAIR_AVAILABLE`），不允许抽象占位。
2. **不超卖**：只有 `available` 椅可被新预约占用；故障/停用/已占用椅绝不可能被第二次分配。
3. **容量/锁定/关系**：换座与自动排座同时检查桌容量、席位/预约锁、`together`/`avoid` 关系。
4. **故障不挪席**：故障或撤回只改椅子状态并开 issue，席位、桌卡、锁、原预约（含已布置状态）原样保留；自动排座与手工换座都不能移动锁定席。
5. **原子事务**：全部校验通过后才提交；任何失败整体回滚，原预约完整保留。

## 幂等、回滚与审计

- 所有写接口接受 `Idempotency-Key`（或 `--idem-key`）：同键同体重放返回首次结果（成功或失败）；同键不同体返回 `IDEMPOTENCY_KEY_REUSED`。失败响应也占用该键，杜绝重复生效。
- 存储层（`src/store.js`）用 FIFO 互斥队列串行化写事务，深拷贝 draft 上执行变更，成功后写临时文件 + 原子 rename；异常则丢弃 draft（回滚）。
- 成功与失败操作都写审计（`audit`），失败审计在回滚时单独补录，可按项目/动作/对象/结果查询历史。

## 旧项目迁移

v1（儿童椅只是抽象占位）通过 `import-legacy` / `migrate-legacy` 迁移：

- 桌容量、桌卡标签、席位锁定原样保留；
- 每个儿童席/匿名占位生成一把 **verification=pending 的待核验实体椅** 并建立 active 预约；
- 待核验椅不能直接布置，核验通过后正常流转；核验发现损坏走与普通资源相同的「故障→待处理→人工处理」流程；
- 迁移幂等：同一旧项目重复导入返回 `LEGACY_PROJECT_EXISTS`。

## 运行

无外部依赖，Node >= 18：

```bash
npm test                 # 19 项验收测试
npm run seed             # 生成演示数据到 data/db.json + data/legacy-example.json
npm start                # HTTP 服务 + Web 界面 http://localhost:3000
PORT=3100 SEATING_DB=/tmp/db.json node src/server.js
```

### Web 界面

- **桌位可视化**：每桌容量/占用率、每张席位卡（宾客/匿名、儿童标记、锁定🔒、绑定实体椅状态、已布置📍、待核验标记），故障席红框警示；
- **椅子资源**：新增、核验、修复、清点回库、故障、撤回；
- **自动排座诊断**：只读可行性推演（逐桌剩余容量、阻塞原因 `NO_AVAILABLE_CHAIR` / `TABLE_FULL` / 关系冲突），执行时默认原子模式，不可排则整体回滚；
- **待处理方案**：人工替换为另一实体椅（锁与布置状态延续）、修复后保留原椅、或显式确认强制撤销锁定席；
- **历史审计**：按动作、成功/失败过滤；
- **迁移 / 导入**：粘贴 v1 JSON 迁移，CSV 批量导入。

## CLI 示例

```bash
node src/cli.js create-project --id p1 --name 年会
node src/cli.js add-table --project p1 --id t1 --capacity 10
node src/cli.js import-chairs --project p1 --file chairs.csv     # 批量导入
node src/cli.js export-chairs --project p1 --out snapshot.csv    # 批量导出
node src/cli.js add-guest --project p1 --name 小娃 --type child
node src/cli.js seat --project p1 --table t1 --guest gst_xxx --chair chair_xxx --label A-1
node src/cli.js deploy --seat seat_xxx
node src/cli.js lock --seat seat_xxx
node src/cli.js fault --chair chair_xxx --comment "椅腿裂了"     # -> 待处理
node src/cli.js resolve-issue --issue iss_xxx --resolution replace
node src/cli.js transfer --seat seat_xxx --to-table t2          # 无可用椅时原预约保留
node src/cli.js diagnose --project p1
node src/cli.js auto-seat --project p1
node src/cli.js table-view --project p1
node src/cli.js audit --project p1 --result failed
node src/cli.js migrate-legacy --file old.json
# 所有写命令支持 --idem-key <key> --actor <who>
```

## HTTP API 摘要

| 方法 路径 | 说明 |
| --- | --- |
| `POST /api/projects/:p/tables` / `guests` / `chairs` / `seats` | 建桌/宾客/椅/席（儿童席必须拿到椅） |
| `POST /api/projects/:p/chairs-import` | CSV/rows 批量导入（坏行整批回滚） |
| `GET  /api/projects/:p/chairs?format=csv` | 批量导出 |
| `POST /api/projects/:p/relations` | together / avoid 关系 |
| `POST /api/projects/:p/auto-seat/diagnose` | 只读诊断 |
| `POST /api/projects/:p/auto-seat` | 自动排座（默认全有或全无） |
| `GET  /api/projects/:p/table-view` | 桌位资源可视化 |
| `POST /api/seats/:id/{reserve,deploy,undeploy,release,transfer,swap-chair,lock,unlock}` | 席位/预约操作 |
| `POST /api/chairs/:id/{fault,withdraw,repair,checkin,verify}` | 资源生命周期 |
| `POST /api/issues/:id/resolve` | `replace` / `revoke` / `keep` |
| `GET  /api/projects/:p/audit` / `GET /api/audit` | 历史审计 |
| `POST /api/projects/:p/import-legacy` | v1 迁移 |

写请求可带 `Idempotency-Key` 头与 `actor`（或 `X-Actor` 头）。

## 主要错误码

`CHAIR_NOT_AVAILABLE`（椅不可用/被抢）、`NO_CHAIR_AVAILABLE`（无可用椅，拒绝抽象占位）、
`TABLE_CAPACITY_EXCEEDED`、`SEAT_LOCKED` / `RESERVATION_LOCKED`、`RELATION_VIOLATION`、
`CHAIR_UNVERIFIED`、`ISSUE_ALREADY_OPEN`、`IDEMPOTENCY_KEY_REUSED`、`AUTOSEAT_HAS_UNRESOLVED`、
`LEGACY_PROJECT_EXISTS`。

## 代码结构

```
src/
  constants.js   状态枚举（椅/预约/核验/方案/关系）
  store.js       FIFO 互斥事务 + 原子落盘 + 幂等键 + 失败回滚/审计补录
  invariants.js  容量、锁定、关系、强绑定、超卖防护等纯不变量
  migration.js   v1 -> v2 迁移（待核验资源）
  service.js     领域服务（预留/换座/故障/待处理/自动排座/查询可视化）
  csv.js         CSV 解析/生成
  server.js      HTTP API + 静态界面
  cli.js         命令行
public/          桌位可视化 / 资源 / 诊断 / 待处理 / 历史 / 迁移界面
test/            19 项验收测试（node --test，零依赖）
```

## 验收场景对应测试

| 验收点 | 测试 |
| --- | --- |
| 两把实体椅分别预留后刷新仍保持 | `AC1` |
| 最后一把椅重复/并发争抢仅一个成功 | `AC2` / `AC2b` / `AC2c` |
| 换桌目标无可用椅时原预约完整保留 | `AC3`（容量/关系回滚见 `AC3b`/`AC3c`） |
| 已布置/已锁定资源故障后仅进入待处理 | `AC4` / `AC4b` / `AC4c` |
| 旧占位迁移为待核验资源且保留容量/锁定/桌卡 | `AC5` / `AC5b` |
| 幂等失败重放、失败回滚与审计 | 幂等重放用例 + 失败审计用例 |
