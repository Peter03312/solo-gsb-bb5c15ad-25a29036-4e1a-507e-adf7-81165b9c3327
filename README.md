# 剧团排练台词（Rehearsal Lines）

一个用 **Node.js + Express + SQLite（better-sqlite3）** 实现的剧团排练台词管理网页应用。

- **导演**：维护剧本的场次、角色、台词顺序；以“修订”的方式改词并发布版本。
- **演员**：登录后只能看到自己被分配角色的排练稿，按场次逐场确认。

## 核心业务规则

### 版本与发布（不可改写）

1. 新建剧本是**草稿**，导演可直接录入台词；发布**首版**后，现行文本冻结。
2. 首版之后的任何文本改动都必须走**修订**：
   - 修订必须**以某个已发布版本为基准**（可基于旧版）；
   - 每条改动必须标明被改台词的**原文**与**新文**（删除只需原文，新增指定场次/角色/新文）；
   - 提交时即校验原文与基准版本逐字一致，不一致直接拒绝（`OLD_TEXT_MISMATCH`）。
3. **发布**时可勾选多个互不冲突的修订，系统逐条核对“修订声称的原文”与“现行（最新已发布）文本”：
   - 原文已被其他修订/新版改动 → 冲突 `text_changed`；
   - 台词已在现行版本中删除 → 冲突 `line_deleted`；
   - 同批次两个修订改了同一句且结果不同 → 冲突 `batch_cross_edit`；
   - **只要存在冲突，本次发布整体不生效**，不会产生新版本，修订保持“进行中”；
   - 互不冲突的修订（含内容完全相同的幂等改动）可合入同一个新版本。
4. 每次发布尝试（成功或因冲突失败）都留有记录和冲突详情。
5. `versions` 与 `version_lines` 是只增不改的快照，数据库触发器禁止 `UPDATE/DELETE`。

### 排练、派角与确认

1. 创建排练时**必须固定引用一个版本**；之后不会自动跟随新版本。
2. **换版必须显式操作**（选择目标版本），并记录换版历史。导演可先在排练页选定同剧已发布的目标版本进行**换版预演**，再凭预演结果提交换版：
   - `POST /api/rehearsals/:id/switch-version/preview` 返回预演令牌（30 分钟有效）与完整预演结果，**只读不改写**版本、确认、日程、签到快照或通知；
   - 预演逐角色×场次列出确认将**保留 / 重做 / 作废**，逐时段列出有效日程将**继续有效 / 转为待调整**（已取消日程不参与），并给出**参与演员与通知接收人变化**（加入/退出/角色变化、新批次/批次失效/不变）；
   - 预演同时检测与**其他有效日程**（端点相接不算冲突）及**参与演员不可用时段**的冲突（待调整、已取消日程不参与），在 `conflicts` 中分类（`schedule` / `unavailability`）指出演员与双方时段；
   - `POST /api/rehearsals/:id/commit-switch-version` 凭预演令牌提交：预演后若排练版本、派角、相关日程、确认或参与演员的不可用记录发生变化（含“改后又改回原样”），返回 `409 PREVIEW_STALE` 并提示重新预演；存在冲突时**整次换版不生效**并返回与预演一致的冲突详情（令牌未消费、可在冲突解除后重试）；
   - 成功提交与预演结果一致，沿用现有换版的确认、日程与通知语义；已开启的签到快照保持不变；令牌一次性使用。
3. 换版后，只有“角色 × 场次”台词内容发生变化的确认会作废，需要该角色重新确认；文本未变的确认继续有效。
4. 演员只能对**自己获分配角色**的场次确认；角色**改派**后，原演员的历史确认保留但不再计入，新演员需逐场重新确认。
5. 导演页面和总览页显示每个排练的**待确认演员/角色/场次及原因**，以及最近的发布冲突详情。
6. 演员的剧本、版本、排练稿接口均只返回其所派角色的台词；越权访问、无效版本/场次会得到明确的 `403/400/404`。
7. 原显式换版接口 `POST /api/rehearsals/:id/switch-version`（无需预演、直接执行）及其响应保持可用，与“预演-提交”共用同一套执行/冲突/通知语义。

### 排练日程（带时区时段）

1. 导演可为已有排练的**某场次**安排**多段**带时区的起止时间
   （ISO 8601 且必须带时区，如 `2026-10-03T14:00:00+08:00` 或 `...Z`；服务端归一化为 UTC 存储与返回）。
2. 时段的**参与者** = 该排练**当前固定版本**中本场次有台词**且已派角**的演员（动态计算）；
   有台词但**未派角**的角色列为**待补派**，不阻止安排。
3. 场次必须属于该剧且在当前固定版本中有台词；**结束必须晚于开始**。
4. **保存/调整时段、派角/改派、换版**时，若参与演员与其他**未取消**时段（待调整不计入）重叠，
   **整次操作拒绝**并返回冲突演员与时段（`409 SCHEDULE_CONFLICT`，`details.conflicts` 含演员与双方时段）；
   **端点相接**（如 10:00–11:00 与 11:00–12:00）**不算重叠**；失败的换版不会改变版本与确认。
5. 换版后，场次在新版本中已无台词的既有安排标为**待调整**（不参与冲突检测）；
   导演调整其时段/场次（须通过第 3 条校验）后恢复有效。
6. 导演可**取消**安排，并查看待补派、待调整与已取消的安排（`?status=` 可过滤）；
   演员只能看到**自己当前参与的有效时段**。
7. 导演可在排练页**一次批量调整同一排练中至少两条未取消时段**的目标场次与带时区起止时间：
   批次中**重复时段、跨排练时段、无台词场次、无效时间或空批次（不足两条）**一律 `400` 明确拒绝
   （批次内时段不存在为 `404`、已取消时段为 `400`）；按**整批最终状态**统一检测
   批内两两、与其他有效日程（跨排练）及本人不可用时段的重叠（端点相接允许，两条时段**互换时间**
   在最终无冲突时成功）；**任一冲突整批不生效**，沿用 `409 SCHEDULE_CONFLICT` /
   `UNAVAILABILITY_CONFLICT` 与 `details.conflicts`。成功时返回更新后的时段与**通知摘要**：
   仅为实质变化（含待调整合法化）的时段各生成一批新通知，未变化的不重发；
   已开启的到场登记与台词确认保持原快照。原单条调整（`PATCH`）与查询语义不变。

### 演员不可用时段

1. 演员可**登记、修改、撤销**自己的不可用时段：输入**带时区**的起止时间（ISO 8601，如
   `2026-10-03T14:00:00+08:00` 或 `...Z`）与**原因**；服务端归一化为 **UTC** 保存，
   **结束必须晚于开始**，**端点相接不算重叠**（半开区间 `[start, end)`）。
2. 演员**提交或修改**时，若与本人**当前参与的有效排练日程**重叠，**整次拒绝**并在
   `details.conflicts` 中指出冲突日程（`409 UNAVAILABILITY_CONFLICT`）。
3. 导演**安排/调整日程、派角/改派、显式换版**时，同样检查受影响演员的不可用时段：
   一旦相撞，**整次操作不生效**，`details.conflicts` 返回**演员、日程及不可用时段**；
   **已取消和待调整日程不参与**检测；已有日程之间的互撞仍按现有 `409 SCHEDULE_CONFLICT` 处理。
4. 开启过的**到场登记名单与签到不因不可用时段变化而改写**（登记仍是开启时的冻结快照）。
5. 演员可查看**本人**不可用记录（接口仅对演员开放）；导演在排期冲突响应中看到必要的
   演员/日程/不可用时段信息。

### 到场登记（按时段一次性签到）

1. 导演可为**有效**（`active`）日程时段**开启一次**到场登记；已取消、待调整或已有登记
   （含已关闭/已作废）的时段不得开启（重复开启返回 `409 ATTENDANCE_EXISTS`）。
2. **开启即冻结**：场次、UTC 起止时段、排练当时固定版本，以及当时“本场次有台词且已派角”
   的演员名单；有台词但**未派角**的角色记为**缺口**，仅展示、**不计应到**。
3. **签到**：仅名单内演员本人在开放期签到（首次 `201`）；**重试返回首次签到结果**
   （`200`，`alreadyCheckedIn: true`，`checkedInAt` 为首次时间）；名单外演员（含开启后才派角的
   **后来加入者**）与导演签到均 `403`。
4. **关闭**：仅导演、仅开放中的登记；关闭后未签到者记**缺席**，后续签到
   （`409 ATTENDANCE_NOT_OPEN`）与再次关闭（`400`）均拒绝。
5. **不回写**：开启后的改派、换版、调整日程均不回写名单与签到——名单、缺口、冻结版本与
   UTC 时段保持开启时快照；原演员被改派后仍在冻结名单内，仍可签到。
6. **日程取消联动**：
   - 开放期取消日程 → 登记**作废**（`voided`）：停止签到，已签到痕迹保留但**不计出勤**；
   - 关闭后取消日程 → 仅标注 `scheduleCancelled`，原统计保留。
7. **可见性**：导演查看名单、缺口与状态统计（应到/已签到/待签到或缺席/是否计入出勤）；
   演员只看本人记录（不在名单上 `403`）。导演与演员的日程列表均带 `attendance` 摘要字段。

### 时段通知（知悉确认）

1. 有效时段**创建**、**起止/场次调整**（单条或**批量调整**，批量按整批最终状态逐时段比对），以及**派角、撤派、显式换版**导致该时段的参与演员、
   角色或固定版本变化时，系统按**最终结果**为该时段生成新的**通知批次**，冻结：UTC 起止时段、
   场次、固定版本与当时参与演员（含各自角色）；**无实质变化不重复生成**（如同值调整、
   派角未改变参与者）。
2. 每个时段至多一个**当前批次**（`current`）；旧批次保留可查
   （`superseded` 已被取代 / `inactive` 已失效）但**不计当前待确认**。
   时段**取消或转为待调整**时当前批次失效、不再待确认；待调整时段**恢复有效**（调整合法化）
   时生成新批次。
3. 演员只能查看**本人为接收人**的批次，且只能确认**当前有效**批次；确认**幂等**——
   重试返回首次确认时间（`200`，`alreadyConfirmed: true`）；确认**过期批次**
   （已被取代/已失效）返回 `409 NOTIFICATION_EXPIRED`；非接收人（含批次生成后才加入者）`403`。
4. 导演可查看每个时段当前批次的**已确认 / 待确认名单**及**历史批次**；
   导演与演员的日程列表均带 `notification` 摘要字段。
5. 批次与源操作**同一事务**提交：排期/不可用冲突导致源操作失败时**不会留下批次**；
   已开启的**到场登记名单**与台词**逐场确认**不受通知影响。

## 一键启动（Docker，推荐）

前置：已安装 Docker 与 Docker Compose v2。

```bash
docker compose up --build -d
```

启动后：

- 访问地址：<http://localhost:3000>
- 健康检查：<http://localhost:3000/api/health>
- SQLite 数据库保存在命名卷 `rehearsal-data`（容器内 `/data/app.db`），首次启动自动建表并写入演示数据。

停止 / 清除数据：

```bash
docker compose down            # 停止（保留数据卷）
docker compose down -v         # 停止并删除数据库卷（下次启动重新初始化）
```

查看日志：

```bash
docker compose logs -f
```

> 镜像构建时优先使用 better-sqlite3 的预编译二进制；若构建机无法从 GitHub Release 下载，
> 构建阶段已内置 `python3/make/g++` 工具链会自动改为源码编译。也可用构建参数
> `--build-arg` 配合环境变量 `BETTER_SQLITE3_BINARY_URL`（指向离线 tar 包）加速离线构建。

## 本地直接运行（Node 20+）

```bash
npm install        # 安装依赖（必要时自动拉取 better-sqlite3 预编译包）
npm start          # 默认监听 0.0.0.0:3000
```

浏览器打开 <http://localhost:3000>。首次启动在 `./data/app.db` 自动建表并初始化演示数据；
删除 `data/` 目录即可回到全新状态。

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | HTTP 监听端口（Compose 已映射宿主机 `3000:3000`） |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DATA_DIR` | `./data` | SQLite 数据库目录（Docker 中为 `/data`） |
| `DB_PATH` | `$DATA_DIR/app.db` | 可直接指定数据库文件完整路径 |
| `BETTER_SQLITE3_BINARY_URL` | 空 | 安装依赖时 better-sqlite3 预编译包的自定义/离线下载地址 |

修改端口示例：

```bash
PORT=8080 docker compose up --build -d
# 同时把 docker-compose.yml 的端口映射改为 "8080:8080"
```

## 演示账号

| 角色 | 用户名 | 密码 | 说明 |
| --- | --- | --- | --- |
| 导演 | `director` | `director123` | 维护剧本、修订发布、创建排练、派角 |
| 演员 | `lin` | `actor123` | 林晚，饰演《夜航灯塔》守塔人 |
| 演员 | `chen` | `actor123` | 陈默，饰演船员 |
| 演员 | `zhou` | `actor123` | 周海，初始未派角 |

演示数据包含剧本《夜航灯塔》（2 个场次、2 个角色、7 句台词，已发布 v1）和一个固定 v1 的排练
（含一段 2026-10-10 的示例日程，该日程自带一条待林晚、陈默知悉确认的时段通知批次）。

## 页面与操作路径

- **导演 → 剧本与版本**：建剧本、加场次/角色、录入草稿台词、发布首版、查看各版本快照。
- **导演 → 修订发布**：选基准版本建修订、逐条添加改/增/删（界面可一键填入所选台词原文）、
  勾选多个修订发布；冲突时页面展示每处冲突的“修订声称原文 vs 现行文本”，并可在发布记录中回看。
- **导演 → 排练与确认**：创建固定版本的排练、显式换版、派角/改派，查看待确认清单与冲突；
  为场次安排/调整/取消带时区的排练时段，查看参与者与待补派；勾选至少两条未取消时段可**批量调整**
  （整批校验冲突，成功后提示有实质变化并重发通知的条数，未变化不重发）；对有效时段**开启/查看/关闭到场登记**
  （名单、缺口、应到/签到/缺席统计）；在“知悉通知”列查看各时段**当前批次的已确认/待确认名单与
  历史批次**。排期/调期/派角/换版若撞上演员不可用时段，页面会提示冲突演员及其不可用时段与原因。
- **导演 → 总览**：所有排练的待确认汇总与最近冲突详情。
- **演员**：进入排练后仅显示本人角色台词，按场次点“确认本场台词”；换版或改派后相应场次会回到待确认；
  可查看自己当前参与的排练时段，并在登记开放期为本人**到场签到**；
  在“我的时段通知”或排练时段行内**确认知悉当前通知批次**（旧批次保留可查但不能确认）；
  在“我的不可用时段”中**登记/修改/撤销**不可用时间（与本人有效日程重叠会被整次拒绝并指出冲突日程）。

## HTTP API 摘要（均返回 JSON，会话用 Cookie 或 `Authorization: Bearer <token>`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/login` · `/api/logout` | 登录 / 退出 |
| GET | `/api/me` | 当前用户 |
| POST/GET | `/api/plays` | 建剧本（导演）/ 剧本列表（演员仅见参演剧本） |
| GET | `/api/plays/:id` | 剧本结构与现行台词（演员只返回所派角色） |
| POST | `/api/plays/:id/scenes` `/roles` `/lines` | 草稿期维护 |
| POST | `/api/plays/:id/publish-initial` | 发布首版 |
| GET | `/api/plays/:id/versions` · `/api/versions/:vid` | 版本列表 / 版本快照 |
| POST/GET | `/api/plays/:id/revisions` | 建修订 / 列表 |
| POST | `/api/revisions/:id/items` | 添加修订条目（校验原文） |
| POST | `/api/revisions/:id/abandon` | 作废修订 |
| POST | `/api/plays/:id/publish` | 发布（冲突返回 409 且不生效） |
| GET | `/api/plays/:id/publish-attempts` | 发布记录与冲突详情 |
| POST/GET | `/api/plays/:id/rehearsals` · `/api/rehearsals` | 建排练 / 列表 |
| GET | `/api/rehearsals/:id` | 派角、待确认、换版历史、最近冲突 |
| POST | `/api/rehearsals/:id/switch-version` | 显式换版（原接口，保持可用） |
| POST | `/api/rehearsals/:id/switch-version/preview` | 换版预演（导演；只读）：确认保留/重做/作废、日程继续有效/转待调整、参与演员与通知接收人变化、冲突；返回 30 分钟有效的预演令牌 |
| POST | `/api/rehearsals/:id/commit-switch-version` | 凭预演令牌提交换版：过期 `409 PREVIEW_STALE`、冲突整次不生效返冲突详情、成功与预演一致 |
| POST/DELETE | `/api/rehearsals/:id/cast[/:roleId]` | 派角/改派/取消 |
| GET | `/api/rehearsals/:id/script` | 演员排练稿（仅本人角色） |
| POST | `/api/rehearsals/:id/confirm` | 演员逐场确认 |
| POST/GET | `/api/rehearsals/:id/schedules` | 安排时段（导演）/ 日程列表（导演含待补派·待调整·已取消，`?status=` 可过滤；演员仅自己参与的有效时段） |
| PATCH | `/api/rehearsals/:id/schedules/:sid` | 调整时段/场次（导演；待调整的时段借此恢复有效） |
| POST | `/api/rehearsals/:id/schedules/batch-adjust` | 批量调整（导演）：一次提交同一排练至少两条未取消时段的目标场次与带时区起止；按整批最终状态统一冲突检测，任一冲突整批不生效；仅实质变化时段重发通知 |
| POST | `/api/rehearsals/:id/schedules/:sid/cancel` | 取消时段（导演，记录保留可查；联动到场登记见下） |
| POST | `/api/rehearsals/:id/schedules/:sid/attendance` | 开启到场登记（导演；冻结名单/缺口/版本/UTC 时段，每时段至多一次） |
| POST | `/api/rehearsals/:id/schedules/:sid/attendance/close` | 关闭登记（导演；未签到者记缺席） |
| POST | `/api/rehearsals/:id/schedules/:sid/attendance/check-in` | 演员本人签到（开放期+名单内；重试返回首次结果） |
| GET | `/api/rehearsals/:id/schedules/:sid/attendance` | 登记详情（导演：名单/缺口/统计；演员：仅本人记录） |
| GET | `/api/rehearsals/:id/schedules/:sid/notifications` | 导演：该时段当前通知批次（已确认/待确认名单）与历史批次 |
| GET | `/api/me/schedule-notifications` | 演员：本人通知批次列表（当前待确认 + 历史） |
| POST | `/api/schedule-notifications/:id/confirm` | 演员确认当前有效批次（幂等重试返回首次时间；过期 409） |
| GET/POST | `/api/me/unavailability` | 演员查看 / 登记本人不可用时段（带时区起止+原因，UTC 保存；撞本人有效日程 409） |
| PATCH/DELETE | `/api/me/unavailability/:id` | 演员修改 / 撤销本人不可用时段（修改同样做重叠校验） |
| GET | `/api/dashboard` | 导演总览 |

错误统一形如 `{ "error": "CODE", "message": "...", "details": ... }`，
典型状态码：`400`（无效版本/场次/参数、状态不允许的操作）、`401`（未登录）、`403`（越权）、`404`（不存在）、
`409`（业务冲突，如 `OLD_TEXT_MISMATCH`、`PUBLISH_CONFLICT`、`SCHEDULE_CONFLICT`、
`UNAVAILABILITY_CONFLICT`、`PREVIEW_STALE`、`ATTENDANCE_EXISTS`、`ATTENDANCE_NOT_OPEN`、`NOTIFICATION_EXPIRED`）。

日程列表响应（导演与演员）均带 `notification` 摘要：导演见 `{id, seq, status, expected, confirmed, pending}`
（仅当前批次计 `pending`）；演员见 `{id, seq, myState, confirmedAt}`（本人不在当前批次接收人中或无批次时为 `null`）。

## 日程接口调用示例（curl）

```bash
# 1. 导演登录，拿到 token
curl -s -X POST http://localhost:3000/api/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"director","password":"director123"}'
# -> {"token":"<TOKEN>","expiresAt":"...","user":{...}}

# 2. 为排练 1 的场次 1 安排带时区时段（+08:00 14:00–15:30）
curl -s -X POST http://localhost:3000/api/rehearsals/1/schedules \
  -H "Authorization: Bearer <TOKEN>" -H 'Content-Type: application/json' \
  -d '{"sceneId":1,"startAt":"2026-10-03T14:00:00+08:00","endAt":"2026-10-03T15:30:00+08:00"}'
# -> 201 {"schedule":{"id":2,"status":"active","startAt":"2026-10-03T06:00:00.000Z",
#        "participants":[{"actorId":2,"actorName":"林晚","roles":[...]}, ...],
#        "pendingCast":[], ...}}
#    时间归一化为 UTC 返回；participants=当前版本本场有台词且已派角的演员，
#    有台词未派角的角色出现在 pendingCast（待补派），不阻止安排。

# 3. 与其他未取消时段重叠 -> 整次拒绝（端点相接不算重叠）
curl -s -X POST http://localhost:3000/api/rehearsals/1/schedules \
  -H "Authorization: Bearer <TOKEN>" -H 'Content-Type: application/json' \
  -d '{"sceneId":2,"startAt":"2026-10-03T15:00:00+08:00","endAt":"2026-10-03T16:00:00+08:00"}'
# -> 409 {"error":"SCHEDULE_CONFLICT","message":"参与演员与其他未取消时段重叠，本次操作未生效",
#        "details":{"conflicts":[{"actorId":2,"actorName":"林晚",
#          "schedule":{"id":null,"sceneId":2,"startAt":"...","endAt":"..."},
#          "overlapsWith":{"id":2,"rehearsalId":1,"sceneId":1,"startAt":"...","endAt":"..."}}]}}

# 4. 导演查看全部日程（含待补派/待调整/已取消；?status=needs_adjustment 可过滤）
curl -s "http://localhost:3000/api/rehearsals/1/schedules" \
  -H "Authorization: Bearer <TOKEN>"
curl -s "http://localhost:3000/api/rehearsals/1/schedules?status=cancelled" \
  -H "Authorization: Bearer <TOKEN>"

# 5. 调整时段（可改场次/起止；待调整的时段调整合法后恢复有效）
curl -s -X PATCH http://localhost:3000/api/rehearsals/1/schedules/2 \
  -H "Authorization: Bearer <TOKEN>" -H 'Content-Type: application/json' \
  -d '{"startAt":"2026-10-04T14:00:00+08:00","endAt":"2026-10-04T15:00:00+08:00"}'

# 6. 取消时段（记录保留，导演列表中可见“已取消”）
curl -s -X POST http://localhost:3000/api/rehearsals/1/schedules/2/cancel \
  -H "Authorization: Bearer <TOKEN>"

# 7. 演员查看日程：只有自己当前参与的有效时段
curl -s "http://localhost:3000/api/rehearsals/1/schedules" \
  -H "Authorization: Bearer <ACTOR_TOKEN>"
# -> {"schedules":[{"id":3,"sceneCode":"I","sceneTitle":"风暴前夜",
#      "startAt":"...","endAt":"...","status":"active","myRoles":[{"roleId":1,"roleName":"守塔人"}]}]}
```

派角/改派（`POST /api/rehearsals/:id/cast`）与显式换版（`POST /api/rehearsals/:id/switch-version`）
同样做日程冲突校验：若新的参与演员与其他未取消时段重叠，返回 `409 SCHEDULE_CONFLICT` 且整次操作不生效
（换版失败时版本与确认均不变）；换版成功时响应新增 `needsAdjustmentSchedules`（被标为待调整的时段 id 列表）。

## 换版预演与提交接口调用示例（curl）

导演可先**预演**（只读，不改任何数据），再凭预演返回的令牌**提交**换版。

```bash
# 1. 导演登录
curl -s -X POST http://localhost:3000/api/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"director","password":"director123"}'
# -> {"token":"<TOKEN>",...}

# 2. 预演：选定同剧已发布的目标版本（如换到 v3）
curl -s -X POST http://localhost:3000/api/rehearsals/1/switch-version/preview \
  -H "Authorization: Bearer <TOKEN>" -H 'Content-Type: application/json' \
  -d '{"versionId":3}'
# -> 200 {
#      "ok": true,
#      "rehearsal": { ...当前仍固定旧版本... },
#      "preview": {
#        "id": 7, "token": "8acb09b2...", "expiresAt": "2026-10-04T13:10:55.000Z", "ttlSeconds": 1800
#      },
#      "plan": {
#        "fromVersionId": 1, "targetVersionId": 3, "targetVersionNo": 3,
#
#        # —— 各角色 × 场次的确认：保留不计入列表；其余逐条列出 ——
#        "confirmations": [
#          { "action": "redo", "roleId": 1, "roleCode": "KEEPER", "roleName": "守塔人",
#            "actorId": 2, "actorName": "林晚", "sceneId": 1, "sceneTitle": "I 风暴前夜",
#            "reason": "换版后台词文本已变化，需重新确认",
#            "discardedConfirmations": [ { "confirmationId": 1, ..., "reason": "当前确认对应旧版台词，换版后将作废重确" } ] },
#          { "action": "discard", "roleId": 2, ..., "sceneId": 2,
#            "reason": "新版本中该角色在此场次已无台词，既有确认作废",
#            "discardedConfirmations": [ ... ] }
#        ],
#        "confirmationStats": { "keep": 1, "redo": 3, "discard": 1, "discardedConfirmationRows": 2 },
#
#        # —— 各有效日程：继续有效 / 转为待调整，含参与者与通知变化 ——
#        "schedules": [
#          { "scheduleId": 1, "sceneId": 1, "sceneTitle": "I 风暴前夜",
#            "startAt": "...", "endAt": "...", "statusBefore": "active",
#            "currentNotification": { "id": 1, "seq": 1, "status": "current" },
#            "outcome": "stay_active", "scheduleStatusAfter": "active",
#            "participantsBefore": [ ... ], "participantsAfter": [ ... ],
#            "participantChange": {
#              "added":   [ { "actorId": 3, "actorName": "陈默", "roles": [ ... ] } ],
#              "removed": [], "rolesChanged": [] },
#            "notification": { "action": "new_batch",
#              "reason": "固定版本或参与演员发生变化，将生成新通知批次，旧批次转为已取代",
#              "newSeq": 2 } },
#          { "scheduleId": 4, ..., "outcome": "become_needs_adjustment",
#            "scheduleStatusAfter": "needs_adjustment",
#            "participantChange": { "added": [], "removed": [ ... ], "rolesChanged": [] },
#            "notification": { "action": "inactive", "newSeq": null } }
#        ],
#        "scheduleCounts": { "total": 3, "cancelled": 1, "stayActive": 1,
#                            "becomeNeedsAdjustment": 1, "alreadyNeedsAdjustment": 0 },
#        "needsAdjustmentSchedules": [4],
#
#        # —— 参与演员变化汇总（按演员）与通知批次汇总 ——
#        "participantChangesAggregated": [
#          { "actorId": 3, "actorName": "陈默",
#            "addedTo": [ { "scheduleId": 1, "sceneTitle": "I 风暴前夜", "roles": [...] } ],
#            "removedFrom": [], "rolesChangedOn": [] } ],
#        "notificationSummary": { "newBatches": 1, "inactiveBatches": 1, "unchangedBatches": 0 },
#
#        # —— 冲突（端点相接不算；已取消/待调整不参与）——
#        "conflicts": [], "hasConflicts": false
#      }
#    }

# 3. 凭预演令牌提交
curl -s -X POST http://localhost:3000/api/rehearsals/1/commit-switch-version \
  -H "Authorization: Bearer <TOKEN>" -H 'Content-Type: application/json' \
  -d '{"previewToken":"8acb09b2..."}'
# -> 200 {
#      "ok": true, "committed": true, "previewId": 7, "previewToken": "8acb09b2...",
#      "rehearsal": { ...已固定到目标版本... },
#      "pending": [ ...换版后待确认清单（与预演一致）... ],
#      "needsAdjustmentSchedules": [4]
#    }
```

预演结果中的字段含义：

- `confirmations[].action`：`redo`（该角色×场次需重新确认，含原因；`discardedConfirmations` 为将被删除的旧确认）、
  `discard`（新版本该角色在此场次已无台词，既有确认作废）；文本未变、继续有效的确认不列出，计入 `confirmationStats.keep`。
- `schedules[].outcome`：`stay_active`（继续有效，按新版本重算参与者）、`become_needs_adjustment`（新版本该场次无台词，转待调整）、
  `already_needs_adjustment`（原本就待调整，换版不触碰）；已取消日程不列出（只计入 `scheduleCounts.cancelled`）。
- `participantChange` / `participantChangesAggregated`：逐时段与按演员汇总的通知接收人变化（`added` 加入 / `removed` 退出 / `rolesChanged` 角色变化）。
- `notification.action`：`new_batch`（将生成新通知批次，`newSeq` 为批次序号，旧批次转 `superseded`）、
  `inactive`（时段转待调整，当前批次失效）、`unchanged`（无实质变化不重发）。
- `conflicts[]`：`{ "type": "schedule", actorId, actorName, schedule, overlapsWith }`
  或 `{ "type": "unavailability", ..., unavailability: {id,startAt,endAt,reason} }`；
  `schedule`/`overlapsWith` 为冲突双方时段（UTC、场次、所属排练）。

异常情形：

```bash
# 预演后发生了任何相关变化（换版/派角改派、相关日程增改取消、演员确认、参与演员登记/修改/撤销不可用）
# -> 拒绝过期提交，要求重新预演（即使变化后又改回原样也会被识别）：
# 409 {"error":"PREVIEW_STALE",
#      "message":"预演之后排练版本、派角、相关日程或参与演员不可用记录已变化，请重新预演后再提交",
#      "details":{"reason":"state_changed", ...}}

# 预演存在冲突时提交 -> 整次换版不生效，返回与预演一致的冲突详情；
# 令牌不被消费，冲突解除后可用同一令牌重试（冲突解除本身会令令牌过期，需重新预演）：
# 409 {"error":"SCHEDULE_CONFLICT",
#      "message":"预演显示换版后参与演员与其他未取消时段重叠，本次换版未生效",
#      "details":{"conflicts":[ ...与预演完全相同的结构... ], "previewToken":"8acb09b2..."}}
# 撞上演员不可用时段时为 409 UNAVAILABILITY_CONFLICT（details.conflicts 含 unavailability）。

# 令牌不属于该排练 / 伪造 / 已使用 / 已过期（30 分钟）-> 400 或 409 PREVIEW_STALE；
# 演员调用预演或提交 -> 403；目标版本就是当前版本 -> 400。
```

预演不产生任何通知、不改动确认与日程；成功提交才按现有换版语义同事务生成通知批次、标记待调整时段，
已开启的到场登记名单/签到与冻结版本保持不变。原接口 `POST /api/rehearsals/:id/switch-version`
（请求体 `{"versionId":3}`，无需预演）与原响应继续可用。

## 批量调整时段接口调用示例（curl）

```bash
# 1. 导演登录，拿到 token
curl -s -X POST http://localhost:3000/api/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"director","password":"director123"}'
# -> {"token":"<TOKEN>",...}

# 2. 一次提交同一排练中至少两条“未取消”时段的目标场次与带时区起止时间
curl -s -X POST http://localhost:3000/api/rehearsals/1/schedules/batch-adjust \
  -H "Authorization: Bearer <TOKEN>" -H 'Content-Type: application/json' \
  -d '{"items":[
    {"scheduleId":2,"sceneId":1,"startAt":"2026-10-04T14:00:00+08:00","endAt":"2026-10-04T15:00:00+08:00"},
    {"scheduleId":3,"sceneId":2,"startAt":"2026-10-04T15:00:00+08:00","endAt":"2026-10-04T16:30:00+08:00"}
  ]}'
# -> 200 {"ok":true,
#        "schedules":[{ ...更新后的完整时段（participants/pendingCast/attendance/notification 摘要同列表接口）,
#                       "notificationChanged":true,"newNotificationId":6}, ...],
#        "notifications":[{"scheduleId":2,"notificationId":6,"seq":2},
#                         {"scheduleId":3,"notificationId":7,"seq":2}],
#        "unchanged":[]}
#    - 时间同样归一化为 UTC 返回；参与演员仍按排练当前固定版本与派角动态推导。
#    - 两条互换时间（scheduleId 2 改成 3 的旧时间、3 改成 2 的旧时间）在最终无冲突时成功。
#    - notifications 仅包含“有实质变化”的时段（起止/场次变化，或待调整合法化）；
#      unchanged 列出未变化、未重发通知的时段 id，对应 schedule.notificationChanged=false。
#    - 已开启的到场登记名单/签到与台词逐场确认保持开启时快照，不因批量调整改写。

# 3. 明确拒绝的批次（均为 400，源时段不会有任何变化）：
#    - items 缺失/不是数组/少于两条（空批次）：
#      {"error":"BAD_REQUEST","message":"批量调整一次至少提交两条时段；单条调整请使用 PATCH ..."}
#    - 同一批次出现重复 scheduleId：        400 "批次中存在重复时段 #2"
#    - 时段属于其他排练（跨排练）：          400 "时段 #9 不属于排练…，批量调整仅限同一排练"
#    - 时段已取消：                         400 "时段 #3 已取消，不能纳入批量调整，请重新创建"
#    - 目标场次不存在/不属于该剧/当前固定版本无台词：400（与单条调整同一套校验文案）
#    - 时间不带时区、非法或结束不晚于开始：  400
#    - 批次内时段不存在：404 NOT_FOUND

# 4. 按“整批最终状态”检测冲突（端点相接不算重叠）；任一冲突整批不生效：
#    下面两条改完后在 10:30–11:00 交叠且参与演员相同 -> 409，两条都保持原时间
curl -s -X POST http://localhost:3000/api/rehearsals/1/schedules/batch-adjust \
  -H "Authorization: Bearer <TOKEN>" -H 'Content-Type: application/json' \
  -d '{"items":[
    {"scheduleId":2,"startAt":"2026-10-05T10:00:00+08:00","endAt":"2026-10-05T11:00:00+08:00"},
    {"scheduleId":3,"startAt":"2026-10-05T10:30:00+08:00","endAt":"2026-10-05T11:30:00+08:00"}
  ]}'
# -> 409 {"error":"SCHEDULE_CONFLICT",
#        "message":"批量调整后参与演员与其他未取消时段重叠，本次整批调整未生效",
#        "details":{"conflicts":[{"actorId":2,"actorName":"林晚",
#          "schedule":{"id":2,...,"startAt":"2026-10-05T02:00:00.000Z",...},
#          "overlapsWith":{"id":3,"rehearsalId":1,...}}]}}
#    - 与其他排练的有效日程、或与本人已登记不可用时段相撞：分别为
#      409 SCHEDULE_CONFLICT / UNAVAILABILITY_CONFLICT，details.conflicts 结构与单条接口一致
#      （不可用冲突含 unavailability: {id,startAt,endAt,reason}）。
#    - 冲突失败不生成任何新通知批次（演员的待确认列表无变化）。

# 5. 待调整时段可随批恢复有效：把换版后失去台词的待调整时段改到当前版本有台词的场次/时间，
#    合法化后状态回到 active，并在 notifications 中各得一批新通知（恢复批自身有冲突同样整批拒绝、保持待调整）。
```

## 到场登记接口调用示例（curl）

```bash
# 1. 导演登录，拿到 token（演员同理：lin / actor123）
curl -s -X POST http://localhost:3000/api/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"director","password":"director123"}'
# -> {"token":"<TOKEN>",...}

# 2. 为有效时段开启到场登记（每个时段至多一次；已取消/待调整时段 400，重复开启 409）
curl -s -X POST http://localhost:3000/api/rehearsals/1/schedules/1/attendance \
  -H "Authorization: Bearer <TOKEN>"
# -> 201 {"session":{"id":1,"status":"open","startAt":"2026-10-10T06:00:00.000Z",
#        "versionId":1,"versionNo":1,
#        "roster":[{"actorId":2,"actorName":"林晚","state":"pending","checkedInAt":null,...}, ...],
#        "gaps":[{"roleId":3,"roleName":"船员"}],            <- 有台词未派角，不计应到
#        "stats":{"expected":2,"checkedIn":0,"pending":2,"absent":0,"counted":true}}}
#    场次、UTC 时段、固定版本、名单与缺口在开启这一刻冻结。

# 3. 名单内演员本人签到（首次 201；重试 200 返回首次结果）
curl -s -X POST http://localhost:3000/api/rehearsals/1/schedules/1/attendance/check-in \
  -H "Authorization: Bearer <ACTOR_TOKEN>"
# -> 201 {"checkIn":{"sessionId":1,"actorId":2,"checkedInAt":"2026-10-03T04:48:12.267Z",
#        "alreadyCheckedIn":false}}
# 再次调用 -> 200 {"checkIn":{...,"checkedInAt":"<首次时间>","alreadyCheckedIn":true}}
# 名单外演员（含开启后才派角的后来加入者）-> 403

# 4. 导演查看名单、缺口与统计；演员同一接口只看本人记录
curl -s http://localhost:3000/api/rehearsals/1/schedules/1/attendance \
  -H "Authorization: Bearer <TOKEN>"
# 演员视角 -> {"session":{"id":1,"status":"open",...,"my":{"state":"checked_in",
#              "checkedInAt":"...","roles":[...]}}}（无 roster/gaps 字段；不在名单上 403）

# 5. 导演关闭登记：未签到者记缺席；此后签到 409、再次关闭 400
curl -s -X POST http://localhost:3000/api/rehearsals/1/schedules/1/attendance/close \
  -H "Authorization: Bearer <TOKEN>"
# -> {"session":{"status":"closed","stats":{"expected":2,"checkedIn":1,"absent":1,...},
#        "roster":[{"actorName":"林晚","state":"checked_in",...},
#                  {"actorName":"陈默","state":"absent",...}], ...}}

# 6. 日程取消的联动（POST /api/rehearsals/1/schedules/1/cancel 之后）：
#    - 登记仍开放 -> 变为 voided：停止签到（409），已签到痕迹保留但不计出勤
#      （stats.counted=false，roster 中 checkedInAt 仍可查）；
#    - 登记已关闭 -> 仅 scheduleCancelled=true，原统计保留。

# 7. 日程列表自带登记摘要，无需逐个查询
curl -s http://localhost:3000/api/rehearsals/1/schedules -H "Authorization: Bearer <TOKEN>"
# -> {"schedules":[{"id":1,...,"attendance":{"id":1,"status":"closed","expected":2,
#        "checkedIn":1,"absent":1,"counted":true,"scheduleCancelled":true}}]}
# 演员列表中 attendance 为 {"id":1,"status":"open","myState":"pending","checkedInAt":null}
# （本人不在该次登记名单上或未开启时为 null）。
```

开启登记后的改派、换版、调整日程（`PATCH /schedules/:sid`）均**不回写**名单与签到：
登记响应中的 `versionId`、`startAt/endAt`、`roster`、`gaps` 始终保持开启时快照。

## 时段通知接口调用示例（curl）

```bash
# 1. 导演登录，拿到 token（演员同理：lin / actor123）
curl -s -X POST http://localhost:3000/api/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"director","password":"director123"}'
# -> {"token":"<TOKEN>",...}

# 2. 创建/调整时段、派角/撤派、显式换版都会按最终结果生成新通知批次（无实质变化不生成）。
#    以“调整时段”为例：响应的 schedule.notification 即为新批次摘要
curl -s -X PATCH http://localhost:3000/api/rehearsals/1/schedules/1 \
  -H "Authorization: Bearer <TOKEN>" -H 'Content-Type: application/json' \
  -d '{"startAt":"2026-10-10T15:00:00+08:00","endAt":"2026-10-10T16:30:00+08:00"}'
# -> {"schedule":{"id":1,...,"notification":{"id":2,"seq":2,"status":"current",
#        "expected":2,"confirmed":0,"pending":2}}}
#    批次冻结：UTC 时段、场次、固定版本与当时参与演员（接收人）。

# 3. 导演查看该时段当前批次的已确认/待确认名单及历史批次
curl -s http://localhost:3000/api/rehearsals/1/schedules/1/notifications \
  -H "Authorization: Bearer <TOKEN>"
# -> {"schedule":{"id":1,"status":"active"},
#     "current":{"id":2,"seq":2,"status":"current","sceneId":1,"versionId":1,
#        "startAt":"2026-10-10T07:00:00.000Z","endAt":"2026-10-10T08:30:00.000Z",
#        "recipients":[{"actorId":2,"actorName":"林晚","state":"pending","confirmedAt":null,
#          "roles":[{"roleId":1,"roleName":"守塔人",...}]}, ...],
#        "stats":{"expected":2,"confirmed":0,"pending":2}},
#     "history":[{"id":1,"seq":1,"status":"superseded",...}]}   <- 旧批次保留但不计当前待确认

# 4. 演员查看本人批次（仅自己为接收人的批次；非接收人/越权 403）
curl -s http://localhost:3000/api/me/schedule-notifications \
  -H "Authorization: Bearer <ACTOR_TOKEN>"
# -> {"notifications":[{"id":2,"seq":2,"status":"current","myState":"pending",
#        "rehearsalName":"首演排练（固定 v1）","sceneTitle":"风暴前夜",
#        "startAt":"...","endAt":"...","versionNo":1,"myRoles":[...],"confirmedAt":null}, ...]}

# 5. 演员确认当前有效批次（首次 201；重试 200 返回首次确认时间）
curl -s -X POST http://localhost:3000/api/schedule-notifications/2/confirm \
  -H "Authorization: Bearer <ACTOR_TOKEN>"
# -> 201 {"confirmation":{"notificationId":2,"actorId":2,
#        "confirmedAt":"2026-10-03T12:00:00.000Z","alreadyConfirmed":false}}
# 再次调用 -> 200 {"confirmation":{...,"confirmedAt":"<首次时间>","alreadyConfirmed":true}}

# 6. 过期批次拒绝：时段再被调整/取消/转待调整后，旧批次确认返回 409
curl -s -X POST http://localhost:3000/api/schedule-notifications/1/confirm \
  -H "Authorization: Bearer <ACTOR_TOKEN>"
# -> 409 {"error":"NOTIFICATION_EXPIRED",
#        "message":"该批次已过期（已有新批次或时段已取消/待调整），请确认最新通知"}

# 7. 取消或待调整的时段不再有待确认批次（current 为 null，旧批次在历史中标记 inactive）；
#    待调整时段经 PATCH 恢复有效时会生成新批次。排期/不可用冲突导致源操作失败时不留批次。
```

## 不可用时段接口调用示例（curl）

```bash
# 1. 演员登录，拿到 token（lin / actor123）
curl -s -X POST http://localhost:3000/api/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"lin","password":"actor123"}'
# -> {"token":"<ACTOR_TOKEN>",...}

# 2. 登记不可用时段：带时区起止 + 原因；服务端按 UTC 保存（结束须晚于开始）
curl -s -X POST http://localhost:3000/api/me/unavailability \
  -H "Authorization: Bearer <ACTOR_TOKEN>" -H 'Content-Type: application/json' \
  -d '{"startAt":"2026-10-12T09:00:00+08:00","endAt":"2026-10-12T12:00:00+08:00","reason":"家中有事"}'
# -> 201 {"unavailability":{"id":1,"actorId":2,
#        "startAt":"2026-10-12T01:00:00.000Z","endAt":"2026-10-12T04:00:00.000Z",
#        "reason":"家中有事",...}}
#    若与本人当前参与的有效排练日程重叠 -> 409 整次拒绝并指出冲突日程：
#    {"error":"UNAVAILABILITY_CONFLICT","message":"不可用时段与本人当前参与的有效排练日程重叠，本次操作未生效",
#     "details":{"conflicts":[{"actorId":2,"actorName":"林晚",
#        "schedule":{"id":1,"rehearsalId":1,"sceneId":1,"sceneTitle":"I 风暴前夜",
#                    "startAt":"...","endAt":"..."},
#        "unavailability":{"id":null,"startAt":"...","endAt":"...","reason":"家中有事"}}]}}
#    已取消与待调整的日程不参与；端点相接（如 12:00 接 12:00）不算重叠。

# 3. 查看本人不可用记录（仅演员本人；导演调用 403）
curl -s http://localhost:3000/api/me/unavailability \
  -H "Authorization: Bearer <ACTOR_TOKEN>"
# -> {"unavailability":[{"id":1,"startAt":"...","endAt":"...","reason":"家中有事",...}]}

# 4. 修改（可只改部分字段；改后与本人有效日程重叠同样 409 且原记录不变）
curl -s -X PATCH http://localhost:3000/api/me/unavailability/1 \
  -H "Authorization: Bearer <ACTOR_TOKEN>" -H 'Content-Type: application/json' \
  -d '{"endAt":"2026-10-12T13:00:00+08:00","reason":"家中有事（改）"}'

# 5. 撤销
curl -s -X DELETE http://localhost:3000/api/me/unavailability/1 \
  -H "Authorization: Bearer <ACTOR_TOKEN>"
# -> {"ok":true}

# 6. 导演侧联动：安排/调整日程、派角/改派、显式换版时若撞上演员不可用时段，
#    整次操作不生效，返回演员、日程及不可用时段（409 UNAVAILABILITY_CONFLICT）：
curl -s -X POST http://localhost:3000/api/rehearsals/1/schedules \
  -H "Authorization: Bearer <TOKEN>" -H 'Content-Type: application/json' \
  -d '{"sceneId":1,"startAt":"2026-10-12T10:00:00+08:00","endAt":"2026-10-12T11:00:00+08:00"}'
# -> 409 {"error":"UNAVAILABILITY_CONFLICT","message":"参与演员在该时段已登记不可用，本次安排未生效",
#        "details":{"conflicts":[{"actorId":2,"actorName":"林晚",
#          "schedule":{"id":null,"rehearsalId":1,"sceneId":1,"startAt":"...","endAt":"..."},
#          "unavailability":{"id":1,"startAt":"...","endAt":"...","reason":"家中有事"}}]}}
#    已有日程之间的互撞仍返回 409 SCHEDULE_CONFLICT，二者互不影响。
```

## 测试

端到端测试会用临时数据目录自动起停服务器，覆盖：认证与越权、修订原文校验、
多种发布冲突与幂等合并、版本快照不可改写触发器、换版后按内容变化重确认、改派后原确认失效、
日程时段校验与重叠冲突（含跨时区/端点相接/跨排练）、派角与换版的日程冲突回滚、待调整与已取消可见性、
批量调整（入参拒绝：重复/跨排练/已取消/无台词/无效时间/空批次；两条互换时间成功；批内/跨排练/不可用冲突整批回滚；
端点相接；无实质变化不重发通知；保持到场登记快照；待调整随批恢复有效）、
换版预演与提交（预演只读：确认保留/重做/作废、日程继续有效/转待调整、参与演员与通知接收人变化、
日程/不可用冲突且端点相接与已取消/待调整不参与；预演不改写任何业务数据；
派角/日程/确认/不可用变化后提交判过期 PREVIEW_STALE 并要求重新预演；
冲突时提交整次不生效且令牌可重试；成功提交与预演一致、签到快照不变；原换版接口保持可用）、
到场登记（开启冻结名单/缺口、签到幂等、改派换版调日程不回写、关闭记缺席、开放期取消作废与关闭后取消标注、
导演/演员可见性）、演员不可用时段（登记/修改/撤销与本人可见、UTC 归一化、端点相接、
已取消与待调整不参与、与本人有效日程重叠整次拒绝、导演排期/调期/派角/换版撞不可用整次不生效、
不改写已开启的到场登记）、时段通知（创建/调整/派角/撤派/换版生成批次与冻结快照、
无实质变化不重复生成、确认幂等与过期拒绝、取消/待调整不计待确认与恢复生成新批次、
冲突失败不留批次、不影响签到名单与逐场确认）等：

```bash
npm test
# 或：scripts/run-e2e.sh（可 TEST_PORT=xxxx 指定端口）
```

## 目录结构

```
src/
  schema.sql       数据库结构（含版本防改写触发器）
  db.js            连接、建表、轻量迁移、密码哈希、内容指纹
  seed.js          首次启动演示数据
  errors.js        统一错误
  auth.js          登录/会话/鉴权
  plays.js         剧本、场次、角色、台词、版本
  revisions.js     修订与发布（冲突检测核心）
  rehearsals.js    排练、派角、换版（原 switch-version 与预演/提交路由）、逐场确认
  version-switch.js 换版预演（只读投影：确认/日程/参与者/通知/冲突）与凭预演提交（状态序号判过期、同事务执行）
  schedules.js     排练日程（带时区时段、参与者/待补派、重叠冲突与不可用时段检测、取消联动登记、
                   时段通知批次生成：随排期/调期/取消/派角/换版事务提交）
  attendance.js    到场登记（开启冻结名单/缺口、本人签到、关闭记缺席、作废与统计）
  unavailability.js 演员不可用时段（登记/修改/撤销/本人查看，与本人有效日程重叠即整次拒绝）
  notifications.js 时段通知（知悉确认）：导演查看批次名单与历史、演员本人批次列表与幂等确认
  server.js        Express 入口
public/            原生 JS 单页前端
scripts/           安装兜底脚本与端到端测试
Dockerfile, docker-compose.yml
```
