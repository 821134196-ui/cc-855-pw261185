# 必填列迁移演练：两代服务 + 本地关系库

在同一个 SQLite 库上，让两代小程序（v1 旧版、v2 新版）**同时读写**，把
`orders.handling` 这一列从「不存在」迁移到「必填」，并在旧客户端仍活跃时
真实演示收紧约束被拒绝、条件满足后才放行。

- 运行时：Node.js ≥ 22.5（用内置 `node:sqlite`，零第三方依赖）
- 数据库：SQLite（WAL），单文件，默认 `.data/rehearsal.db`
- 交付物：迁移程序（CLI + 库）、两代服务、操作页（HTML + JSON API）、演练脚本、测试

---

## 快速开始

```bash
npm run stack -- --reset --rows 240 --traffic
# 操作页： http://127.0.0.1:8090
# v1 旧版： http://127.0.0.1:8091
# v2 新版： http://127.0.0.1:8092
```

`--traffic` 会同时给两代服务开流量。`--probe` 额外起一个纯 v1 探针进程
（8093），用来演示「只停 v1 服务还不够，闸门还要等排空窗口」。

纯命令行演练（不写磁盘，4s/5s 小窗口，跑完自动断言）：

```bash
npm run rehearse        # 退出码 0 = 全部断言成立
npm test                # 22 个用例：expand / backfill / 守卫 / 闸门 / contract / HTTP
```

---

## 迁移的四个阶段

| 阶段 | 做了什么 | 两代服务能否继续读写 |
| --- | --- | --- |
| `baseline` | 原表，没有 `handling` 列 | v1 读写、v2 已上线（读 `NULL AS handling`） |
| `expand` | `ALTER TABLE ADD COLUMN handling TEXT`（可空）+ 触发器 | 都能；v1 插入由触发器补哨兵 `unassigned` |
| `backfill` | 按 `id` 升序分批，把待修复行填成默认值 | 都能；v2 先填的行永远不被选中 |
| `contract` | 重建表为 `NOT NULL`，CHECK 只允许真实取值 | v1 插入被 NOT NULL 拒绝；v2 正常 |

阶段状态存在 `migration_state`，每次写入/拒绝都进 `audit_log`，
`migration_batches` 记录每一批的 尝试/填充/拒绝/剩余。

### expand 阶段的关键设计

1. **可空 + 哨兵**：新列允许 `NULL`，CHECK 允许真实值、`NULL` 和临时哨兵
   `unassigned`。旧行保持 `NULL` 而不是被立即填默认值——这样「还有多少行要修」
   是可观测的，回退也有明确的目标。
2. **填充触发器**：v1 插入不带 `handling`，`AFTER INSERT` 触发器把它改成哨兵，
   并写入 `handling_provenance(origin='legacy_default')`。
3. **来源表**：每一行的当前值来自哪里（`legacy_default` / `backfill` /
   `modern` / `rollback`）单独记录，是守卫判断的依据，不依赖业务列。
4. **单次意图令牌**：任何改写已有非空值都必须先插入一条
   `handling_intent(order_id, value, origin)`，触发器用掉即删。

### 为什么默认值回退动不了新版写入的值

这是题目里的硬约束，由**数据库**保证，而不是靠调用方的 `WHERE`：

```sql
CREATE TRIGGER handling_guard
BEFORE UPDATE OF handling ON orders
WHEN NEW.handling IS NOT OLD.handling
BEGIN
  -- 改写已有非空值却没有匹配的意图 → 拒绝
  SELECT RAISE(ABORT, 'E_OVERWRITE_WITHOUT_INTENT')
  WHERE OLD.handling IS NOT NULL AND NOT EXISTS (...运行意图...);

  -- 携带 backfill/rollback 意图，但该行来源是 modern → 拒绝
  SELECT RAISE(ABORT, 'E_DEFAULT_OVER_MODERN')
  WHERE EXISTS (...意图 origin IN ('backfill','rollback')...)
    AND EXISTS (...来源 origin = 'modern'...);
END;
```

于是：

- `unsafeDefaultSweep`（故意写错的「全部回退」）会逐行收到
  `E_DEFAULT_OVER_MODERN`，新版值原样保留；
- `rollbackDefaults`（安全回退）只挑默认来源的行，把它们变回 `NULL` 等下一轮
  修复，同样碰不到 `modern` 行；
- 连人肉 `UPDATE orders SET handling='normal'` 也会被
  `E_OVERWRITE_WITHOUT_INTENT` 拒绝。

`demo/rehearse.js` 和 `test/guard.test.js` 都直接断言了这两条。

### contract 为什么必须等旧客户端真正安静

`contractPreflight` 的检查项（全部满足才放行，**没有强制开关**）：

| token | 条件 |
| --- | --- |
| `E_WRONG_PHASE` | 阶段为 `backfilled` / `validated` |
| `E_COLUMN_MISSING` | 列已存在 |
| `E_PENDING_ROWS` | 没有 `NULL` 或哨兵行 |
| `E_LEGACY_CLIENTS_ACTIVE` | 最近 `ACTIVE_WINDOW_MS` 内没有 v1 心跳 |
| `E_DRAIN_NOT_SATISFIED` | 距最后一次 v1 写入已超过 `DRAIN_WINDOW_MS` |
| `E_DANGLING_INTENT` | 没有残留意图令牌 |

理由：contract 一旦生效，任何还在跑的 v1 进程下一次插入都会失败。活跃窗口
（心跳）解决「进程还活着」，排空窗口（最后一次**业务写入**）解决「刚停但可能
还有在途请求」。两者分开，是因为进程可能先停心跳、再落最后一个写。

被拒绝时 `contract` 抛 `E_CONTRACT_REFUSED` 并写
`audit_log.kind='migrate.contract_refused'`，操作页与 CLI 看到的是同一份记录。

### contract 重建的两个 SQLite 细节

- `PRAGMA foreign_keys` 在事务内是空操作，必须在事务**外**切换；否则
  `DROP TABLE orders` 会级联删掉来源表和意图表。
- `DROP TABLE` 会一并丢掉触发器和 `sqlite_sequence` 行：重建后要重新建触发器，
  并把序列钉到 `MAX(id)`，否则新插入会复用旧 id。
- 重建在**一个** IMMEDIATE 事务里完成，行数在写锁内读取——闸门放行之后、重建
  之前提交的一条 v2 插入会被一起搬进新表，而不是误判成 `E_ROW_COUNT_MISMATCH`。

---

## 迁移程序

### CLI（`node migrate.js <命令>`）

```bash
node migrate.js status          # 阶段、列信息、待修复数、来源分布、闸门结论
node migrate.js expand
node migrate.js backfill --batch 25 [--batches 1] [--pace 300]
node migrate.js backfill-loop --slices 8 --pace 400
node migrate.js validate        # 有哨兵/无来源/悬挂令牌都会失败
node migrate.js preflight       # 只读，打印每个检查项
node migrate.js contract        # 不满足就拒绝（退出码 2），并写审计
node migrate.js rollback --batch 25
node migrate.js unsafe-sweep    # 演示错误回退：逐行被守卫拒绝
node migrate.js seed --reset --rows 240
```

### 库（`lib/migration.js`）

`expand` / `backfill` / `validate` / `contractPreflight` / `contract` /
`rollbackDefaults` / `unsafeDefaultSweep` / `columnSnapshot`。
CLI、操作页、演练脚本调用的都是这些函数——操作页不可能比命令行更宽松。

### 操作页（`http://127.0.0.1:8090`）

- 顶部：阶段、总行数、待修复（主数字 + 进度条）、旧版默认值、新版已填写
- 取值来源：分段条 + 图例 + **完整表格**（不依赖悬停或颜色也能读全）
- 收紧闸门：每个检查项逐条显示 ✓/✗、当前值、说明；不满足时按钮禁用
- 会话表、批次表、事件流（页内动作 + 审计）
- 动作按钮：展开、修复一批、修复到清空、校验、收紧、错误回退、安全回退、
  收紧后插入对照、停探针、重置基线

API：`GET /api/snapshot`、`GET /api/preflight`、
`POST /api/action/{expand|backfill-batch|backfill-all|validate|attempt-contract|rollback-defaults|unsafe-sweep|probe-inserts|stop-probes|reseed}`。

---

## 目录

```
lib/
  config.js      环境变量与窗口配置
  schema.js      两套 DDL、触发器、词表
  db.js          连接、IMMEDIATE 事务重试、意图令牌、审计
  migration.js   expand / backfill / preflight / contract / rollback
  service.js     两代服务共用运行时（会话注册、心跳、流量）
  session.js     会话登记与「活跃 / 排空」查询
  orders.js      两代各自的读列与流量目标
  seed.js        基线播种 + VACUUM INTO 冷备
  http.js        路由、JSON 错误令牌、:id 参数传递
  workload.js    格式化小工具
services/
  legacy-service.js  v1：只认旧列，插入不带 handling
  modern-service.js  v2：知道新列，能补真实值
ops/
  server.js      API + 页面
  assets/        ops.html / ops.css / ops.js
scripts/stack.js 一条命令拉起 v2、v1、操作页
tools/v1-probe.js 可暂停/停止的合成旧客户端
demo/rehearse.js  带断言的端到端演练
test/             node --test 用例
```

## 环境变量

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `DB_PATH` | `.data/rehearsal.db` | 库文件 |
| `OPS_PORT` / `LEGACY_PORT` / `MODERN_PORT` / `PROBE_PORT` | 8090 / 8091 / 8092 / 8093 | 端口 |
| `ACTIVE_WINDOW_MS` | 15000 | 心跳多久内算「活跃」 |
| `DRAIN_WINDOW_MS` | 10000 | 最后一次 v1 写入后要静默多久 |
| `HEARTBEAT_MS` | 2000 | 心跳间隔 |
| `BATCH_SIZE` | 25 | 每批修复行数 |
| `BUSY_TIMEOUT_MS` | 8000 | SQLite 锁等待 |

`scripts/stack.js` 会把这些值原样传给三个子进程，保证操作页的闸门和服务
自己注册的会话读的是同一套窗口。

## 一次完整的现场演示

1. `npm run stack -- --reset --rows 240 --traffic`，打开操作页。
2. 点「1 · 展开」——两代服务都不停机；v1 新插入的行立刻带哨兵。
3. 点「修复到清空」——批次表滚动，待修复归零；「新版已填写」不为零。
4. 点「演示：错误的批量回退」——事件里逐行出现 `E_DEFAULT_OVER_MODERN`，
   「新版已填写」数量不变。
5. 点「4 · 收紧约束」——**被拒绝**：`E_LEGACY_CLIENTS_ACTIVE` +
   `E_DRAIN_NOT_SATISFIED`（若 v1 还在插，还多一条 `E_PENDING_ROWS`）。
6. 停掉 v1 服务（Ctrl-C 那个子进程，或 `kill -TERM`）——闸门先因排空窗口
   继续拒绝约 10 秒，然后放行。
7. 再点「4 · 收紧约束」——成功。点「收紧后插入对照」：v1 插入返回
   `NOT_NULL`，v2 插入成功。
