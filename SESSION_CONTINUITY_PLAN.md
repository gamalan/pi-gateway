# pi-gateway Session Continuity 实现方案

> 基于 Hermes Agent gateway 的 session persistence 机制分析

---

## 一、Hermes 的核心机制分析

### 1.1 核心概念：`resume_pending` 标志

Hermes 用一个 **`resume_pending`** 标志来标记"被中断但可恢复"的会话。核心逻辑链路：

```
网关关闭/重启 → 标记所有活跃会话 resume_pending=True → 网关启动
→ 检测 resume_pending 会话 → 合成一个空消息"恢复轮次"
→ 注入"[System note: The previous turn was interrupted...]"
→ Agent 继续之前的对话上下文
```

### 1.2 关机三阶段（`_stop_impl`，8140-8226 行）

```
Phase 1: Pre-drain 标记
  在开始 drain 之前，对所有 running agents 调用 mark_resume_pending()
  确保即使被 SIGKILL，标记也已写入磁盘（SQLite）

Phase 2: Drain 等待
  等待 running agents 完成（最长 drain_timeout 秒）

Phase 3a: 优雅完成（drain 成功）
  清除 pre-drain 标记：clear_resume_pending()
  写入 .clean_shutdown 标记文件
  → 下次启动时不触发 suspend_recently_active()

Phase 3b: 超时强制中断（drain 超时）
  对仍在运行的 agents 调用 mark_resume_pending()
  中断 agents + 杀死工具子进程
  不写 .clean_shutdown
  → 下次启动时：suspend_recently_active() 不会被调用（因为 resume_pending 已在关机时写入）
  → 但 _schedule_resume_pending_sessions() 会找到它们并自动恢复
```

### 1.3 启动恢复阶段（6990-7320 行）

```python
# 1. 崩溃恢复：无 .clean_shutdown 文件 → 标记最近活跃会话
suspend_recently_active(max_age_seconds=120)
#    扫描 sessions，对 updated_at 在过去 120s 内的会话
#    设置 resume_pending=True, resume_reason="restart_interrupted"

# 2. Stuck-loop 检测
_suspend_stuck_loop_sessions()
#    连续3+次重启仍活跃 → 强制 suspended=True (下次消息自动清空)

# 3. 串行化启动恢复
_startup_restore_in_progress = True   # 阻塞所有入站消息

# 4. 连接平台适配器...

# 5. 发送 restart 通知给之前发起 /restart 的聊天
_send_restart_notification()  # 读取 .restart_notify.json

# 6. ⭐ 核心：自动恢复被中断的会话
_schedule_resume_pending_sessions()
#    扫描所有 resume_pending=True 的会话
#    对每个：创建空文本 MessageEvent → 注入恢复提示 → 运行 agent turn

# 7. 等待所有恢复任务完成
await _finish_startup_restore()
#    收集所有 startup restore tasks → gather → drain 入站队列
_startup_restore_in_progress = False
```

### 1.4 `_schedule_resume_pending_sessions` 细节（6542-6676 行）

```python
def _schedule_resume_pending_sessions(self, platform=None) -> int:
    candidates = [
        entry for entry in self.session_store._entries.values()
        if entry.resume_pending
        and not entry.suspended
        and entry.origin is not None
        and entry.resume_reason in _AUTO_RESUME_REASONS
        # _AUTO_RESUME_REASONS = {"restart_timeout", "shutdown_timeout", "restart_interrupted"}
    ]
    
    # Freshness gate: 只恢复 freshness_window 内的会话（默认1小时）
    for entry in candidates:
        marker = entry.last_resume_marked_at or entry.updated_at
        if (now - marker).total_seconds() > window:
            continue  # 跳过过期会话
        
        # 跳过已在恢复中的
        if entry.session_key in self._running_agents:
            continue
        
        # 跳过 adapter 未就绪的
        adapter = self._adapter_for_source(source)
        if adapter is None:
            continue
        
        # ⭐ 授权检查：重新验证用户是否仍在 allowlist 中
        if not self._is_user_authorized(source):
            continue
        
        # 创建空消息内部事件
        event = MessageEvent(text="", message_type=MessageType.TEXT,
                             source=source, internal=True)
        
        # 异步运行恢复（等待 agent 完成才能解除入站队列阻塞）
        task = asyncio.create_task(
            self._run_startup_resume_event(adapter, event, entry.session_key)
        )
```

### 1.5 `_handle_message_with_agent` 中的恢复注入（18680-18730 行）

当检测到 `resume_pending=True` 时，在用户消息前注入系统提示：

```
[System note: The previous turn was interrupted by a gateway restart;
the gateway is now back online. Any restart/shutdown command in the 
history has already run — do NOT re-execute or verify it. 
Address the user's NEW message below FIRST and focus on what the 
user is asking now. Do NOT re-execute old tool calls — skip any 
unfinished work from the conversation history.]
```

如果是空消息（启动自动恢复轮次）：
```
[System note: ...Report to the user that the session was restored 
successfully and ask what they would like to do next.]
```

### 1.6 数据存储架构

**primary**: `~/.hermes/state.db` SQLite（`SessionDB`）
- `gateway_routing` 表：session_key → session_id 映射（含所有 `SessionEntry` 字段）
- `sessions` 表：session 元数据和消息转录
- 多进程共享同一个 `state.db`（gateway + CLI + TUI）

**legacy**: `~/.hermes/sessions/{profile}/sessions.json`（JSON 文件镜像）
- 保留用于兼容性，可通过配置关闭

### 1.7 restart 通知机制

- **chat-originated** `/restart`：写入 `.restart_notify.json`（含 chat 定位信息）
  - 启动时读取 → 恢复成功消息发送回发起 /restart 的聊天
- **non-chat restart**（terminal/SIGUSR1/service）：写入 `.restart_pending.json`
  - 启动时读取 → 向所有 home channels 发送"gateway is back"通知

---

## 二、pi-gateway 现状

### 2.1 现有优势 ✅

| 特性 | 状态 |
|------|------|
| SQLite 持久化 | 已有 `~/.pi/gateway/gateway-sessions.db` |
| Session 表结构 | 已有 `sessions` 表（id, platform, channel_id, user_id, last_activity 等） |
| `getOrCreateSession` | 已有，支持 idle/daily 重置 |
| 后台会话隔离 | 已有 `is_background` 字段 |
| SIGHUP 优雅重启 | 已有 daemon 模式 |
| Shutdown 广播 | 已有向所有活跃 channel 发送 shutdown 消息 |

### 2.2 缺失的关键能力 ❌

| 缺失 | 影响 |
|------|------|
| **无 `resume_pending` 标志** | 重启后无法识别哪些会话需要恢复 |
| **无 shutdown 时标记保存** | 关机时不知道哪些 RPC 会话是活跃的 |
| **无启动自动恢复** | 重启后用户发消息时没有恢复提示 |
| **无 `.clean_shutdown` 标记** | 无法区分优雅关机和崩溃 |
| **无 freshness window** | 崩溃后所有旧会话都可能被错误恢复 |
| **无 stuck-loop 检测** | 坏会话可能造成无限恢复循环 |
| **RPC 历史不持久化** | RPC 子进程重启后丢失所有对话上下文 |

### 2.3 RPC 上下文丢失的根本原因

pi-gateway 通过 `pi --mode rpc --extension ...` 启动 RPC 子进程，所有对话历史保存在子进程内存中。重启后新 RPC 进程是空白的，之前的对话上下文完全丢失。

---

## 三、实施方案

### 3.1 总体策略

**Phase 1（最小可行方案）：实现 resume_pending 信号链**
- 增删 DB 列 + 标记/恢复逻辑
- 先实现"重启后用户发消息时 smart resume"（不实现自动恢复轮次）

**Phase 2（完整方案）：实现自动恢复轮次**
- 启动时自动合成恢复消息并注入 system note
- 需要 RPC 子进程或 agent 支持历史注入

**建议先做 Phase 1**，因为 Phase 2 需要 pi agent RPC 模式支持传入历史上下文——这是 pi agent 侧改动。

### 3.2 Phase 1 修改清单

#### 文件 1：`src/sessions/store.ts`

**新建 DB 迁移，增加 `resume_pending` 相关列：**

```sql
-- 在 initSessionStore() 中添加 ALTER TABLE（幂等）
ALTER TABLE sessions ADD COLUMN resume_pending INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN resume_reason TEXT;
ALTER TABLE sessions ADD COLUMN last_resume_marked_at INTEGER;
ALTER TABLE sessions ADD COLUMN suspended INTEGER NOT NULL DEFAULT 0;
```

**更新 `SessionConfig` 接口：**

```typescript
export interface SessionConfig {
  // ... 现有字段 ...
  resumePending: boolean;          // 新增
  resumeReason?: string;           // 新增 "restart_timeout" | "shutdown_timeout" | "restart_interrupted"
  lastResumeMarkedAt?: number;     // 新增
  suspended: boolean;              // 新增（/stop 命令强制清空）
}
```

**更新 `SessionRow` 接口和 `rowToSession`：**

```typescript
interface SessionRow {
  // ... 现有字段 ...
  resume_pending: number;          // 新增
  resume_reason: string | null;    // 新增
  last_resume_marked_at: number | null;  // 新增
  suspended: number;               // 新增
}
```

**新增函数：**

```typescript
// 1. 标记会话为可恢复（关机时调用）
export function markResumePending(
  platform: string,
  channelId: string,
  reason: "restart_timeout" | "shutdown_timeout" | "restart_interrupted"
): boolean

// 2. 清除恢复标志（agent 成功回复后调用）
export function clearResumePending(sessionId: string): boolean

// 3. 获取所有待恢复会话
export function getResumePendingSessions(
  maxAgeSeconds?: number  // freshness window，默认3600
): SessionConfig[]

// 4. 标记最近活跃会话为可恢复（崩溃恢复，启动时调用）
export function suspendRecentlyActive(
  maxAgeSeconds?: number  // 默认120s
): number

// 5. 检查是否为优雅关机
export function wasCleanShutdown(): boolean

// 6. 写入优雅关机标记
export function markCleanShutdown(): void

// 7. 暂停会话（/stop 命令）
export function suspendSession(sessionId: string): boolean
```

**markResumePending 实现逻辑：**

```typescript
export function markResumePending(
  platform: string,
  channelId: string,
  reason: "restart_timeout" | "shutdown_timeout" | "restart_interrupted"
): boolean {
  const database = initSessionStore();
  
  // 找到该 channel 的最新活跃非后台会话
  const row = database.prepare(`
    SELECT id, suspended FROM sessions 
    WHERE platform = ? AND channel_id = ? AND is_background = 0
    ORDER BY last_activity DESC LIMIT 1
  `).get(platform, channelId) as { id: string; suspended: number } | undefined;
  
  if (!row || row.suspended) return false;
  
  database.prepare(`
    UPDATE sessions 
    SET resume_pending = 1, resume_reason = ?, last_resume_marked_at = ?
    WHERE id = ?
  `).run(reason, Date.now(), row.id);
  
  return true;
}
```

**getResumePendingSessions 实现逻辑：**

```typescript
export function getResumePendingSessions(
  maxAgeSeconds: number = 3600
): SessionConfig[] {
  const database = initSessionStore();
  const cutoff = Date.now() - maxAgeSeconds * 1000;
  
  const rows = database.prepare(`
    SELECT * FROM sessions 
    WHERE resume_pending = 1 
      AND suspended = 0 
      AND is_background = 0
      AND (last_resume_marked_at > ? OR 
           (last_resume_marked_at IS NULL AND last_activity > ?))
    ORDER BY last_activity DESC
  `).all(cutoff, cutoff) as SessionRow[];
  
  return rows.map(rowToSession);
}
```

#### 文件 2：`src/index.ts` — 关机流程

在 `stopGatewayServer()` 前新增一个 pre-shutdown 标记阶段：

```typescript
// 在 stopGatewayServer() 函数开头新增：
function stopGatewayServer(skipBroadcast = false): void {
  if (!state.running) return;
  
  // ===== 新增：Phase 1 - Pre-drain 标记 =====
  // 在停止 RPC 之前标记活跃会话为可恢复
  // 这样即使进程被强制终止，SQLite 中也有记录
  const activeSessions = new Map<string, SessionConfig>();
  for (const [key, session] of state.sessions) {
    activeSessions.set(key, session);
  }
  for (const [key, session] of activeSessions) {
    try {
      markResumePending(
        session.platform,
        session.channelId,
        restartRequested ? "restart_timeout" : "shutdown_timeout"
      );
    } catch (e) {
      logger.debug(`[gateway] pre-drain markResumePending failed: ${e}`);
    }
  }
  // =============================================
  
  // ... 原有 shutdown 逻辑 ...
}
```

在 `shutdown` 信号处理器末尾（2357行后）新增 clean shutdown 标记：

```typescript
// 在 process.on("SIGTERM", shutdown) 的 shutdown 函数末尾：
const shutdown = async () => {
  // ... 原有逻辑 ...
  
  // 写入 .clean_shutdown 标记文件（如果优雅关机完成）
  const cleanMarker = join(GATEWAY_DIR, ".clean_shutdown");
  writeFileSync(cleanMarker, Date.now().toString());
  
  process.exit(0);
};
```

#### 文件 3：`src/index.ts` — 启动流程

在 `onMessage` 回调中找到 session 之后，检测 `resume_pending`：

```typescript
// 在 adapterCallbacks.onMessage 中，getOrCreateSession 调用之后新增：

const session = getOrCreateSession(
  message.platform, message.channelId, message.userId, { ... }
);

// ===== 新增：检测 resume_pending 并注入恢复提示 =====
if (session.resumePending) {
  const reasonPhrase = session.resumeReason === "restart_timeout" 
    ? "a gateway restart"
    : session.resumeReason === "shutdown_timeout"
    ? "a gateway shutdown"
    : "a gateway interruption";
  
  // 在用户消息前注入 system note
  const systemNote = `[System note: The previous turn was interrupted by ${reasonPhrase}; the gateway is now back online. Any restart/shutdown command in the history has already run — do NOT re-execute or verify it. Focus on the user's NEW message below. Do NOT re-execute old tool calls — skip any unfinished work from the conversation history.]`;
  
  message.content = `${systemNote}\n\n${message.content}`;
  
  // 清除标志（成功处理后由 sendPromptRpc 结果清除）
  // 注意：这里不清除，等 agent 成功回复后再清除
}
// ==============================================

// ... 原有逻辑 ...
```

在 `sendPromptRpc` 成功后清除 `resume_pending`：

```typescript
// 在 responseText 收到后（约970行附近），发回消息后：
try {
  const responseText = await sendPromptRpc(/* ... */);
  
  // ... 编辑/发送回复 ...
  
  // ===== 新增：清除 resume_pending 标志 =====
  if (session.resumePending) {
    try {
      clearResumePending(session.id);
    } catch (e) {
      logger.debug(`[gateway] clearResumePending failed: ${e}`);
    }
  }
  // ===========================================
  
} catch (err) {
  // ... 错误处理 ...
}
```

#### 文件 4：`src/index.ts` — 崩溃恢复

在 daemon 启动函数（`startGatewayServer` 之前的位置，或 main 函数的 SIGHUP handler 之前）新增：

```typescript
// 在 startGatewayServer() 或 daemon 初始化时：
const cleanMarker = join(GATEWAY_DIR, ".clean_shutdown");
if (!existsSync(cleanMarker)) {
  // 上次不是优雅关机 → 崩溃恢复
  logger.info("[pi-gateway] Previous shutdown was not clean — marking recently active sessions as resumable");
  try {
    const count = suspendRecentlyActive(120); // 120s 窗口
    if (count > 0) {
      logger.info(`[pi-gateway] Marked ${count} session(s) as resumable from crash`);
    }
  } catch (e) {
    logger.warn(`[pi-gateway] Crash recovery marking failed: ${e}`);
  }
} else {
  // 删除标记文件，防止下次误判
  try { unlinkSync(cleanMarker); } catch {}
}
```

### 3.3 Phase 2 修改清单（Phase 1 基础上）

Phase 2 需要实现启动时的自动恢复轮次——即使没有用户消息，也主动向 agent 发起"恢复对话"的轮次。这需要：

1. **在 `startGatewayServer()` 的 `initializeAdapters()` 之后**，调用 `getResumePendingSessions()` 扫描待恢复会话
2. 对每个会话，构建一个带 system note 的空消息发送给 RPC
3. 等待 RPC agent 处理完成
4. 解除入站队列阻塞

**关键依赖**：pi agent RPC 模式需要支持接收 history/session_id，否则新进程没有上下文。

如果 pi agent RPC 不支持历史注入，一个 workaround：
- 网关维护一个内存中的消息历史缓存（存在 SQLite 中）
- RPC 调用 prompt 时，同时传入历史消息（前 N 轮）
- 或在 prompt 中直接拼接 system note + 历史摘要

### 3.4 DB 迁移实现细节

使用 `user_version` 做版本管理（SQLite PRAGMA）：

```typescript
function migrateSessionsSchema(database: Database.Database): void {
  // 读取当前 schema 版本
  const { user_version: currentVersion } = database
    .prepare("PRAGMA user_version")
    .get() as { user_version: number };
  
  if (currentVersion < 1) {
    // Version 0 → 1: 添加 resume 相关列
    const migrations = [
      "ALTER TABLE sessions ADD COLUMN resume_pending INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE sessions ADD COLUMN resume_reason TEXT",
      "ALTER TABLE sessions ADD COLUMN last_resume_marked_at INTEGER",
      "ALTER TABLE sessions ADD COLUMN suspended INTEGER NOT NULL DEFAULT 0",
    ];
    
    for (const sql of migrations) {
      try { database.exec(sql); } catch (e) {
        // 列已存在的错误可以忽略
        if (!String(e).includes("duplicate column")) throw e;
      }
    }
    
    database.pragma("user_version = 1");
    logger.info("[SessionStore] Migrated schema to version 1");
  }
}
```

在 `initSessionStore()` 的 `CREATE TABLE` 之后调用 `migrateSessionsSchema(db)`。

---

## 四、完整流程对比

### Hermes 流程（参考）

```
/restart 命令
  ├── 设置 _restart_requested = True
  ├── 写入 .restart_notify.json
  │
  ▼ _stop_impl()
  ├── Phase 1: markResumePending() → 写入 SQLite
  ├── Phase 2: drain_active_agents(timeout)
  ├── Phase 3: 超时 → 再次 markResumePending()
  ├── 写入/不写入 .clean_shutdown
  └── exit(75) → systemd 重启进程
  │
  ▼ 新进程启动
  ├── 检测 .clean_shutdown
  │   └── 不存在 → suspendRecentlyActive(120s)
  ├── 连接平台适配器
  ├── _send_restart_notification() → 读取 .restart_notify.json
  ├── _schedule_resume_pending_sessions()
  │   ├── 扫描 resume_pending=True 的会话
  │   ├── freshness gate（默认1小时）
  │   ├── 权限重检查
  │   └── 创建空消息事件 → 异步恢复
  ├── await _finish_startup_restore()
  │   └── gather 所有恢复 task → drain 入站队列
  └── 正常运行
      ├── 收到消息 → get_or_create_session
      │   └── resume_pending=True → 注入 system note
      └── turn 成功 → clearResumePending()
```

### pi-gateway 新流程（提案）

```
/restart 命令
  ├── 写入 restart 通知标记（建议文件: ~/.pi/gateway/.restart_notify.json）
  │
  ▼ SIGHUP / stopGatewayServer()
  ├── Phase 1: markResumePending() → 写入 SQLite (NEW)
  ├── 停止 RPC 进程
  ├── 停止适配器
  ├── 写入/不写入 .clean_shutdown (NEW)
  └── exit / 重 spawn
  │
  ▼ 新进程启动 (startGatewayServer)
  ├── 检测 .clean_shutdown (NEW)
  │   └── 不存在 → suspendRecentlyActive(120s) (NEW)
  ├── 连接平台适配器
  ├── [Phase 2] getResumePendingSessions() → 自动恢复轮次 (NEW)
  ├── 恢复正常
  │
  ▼ 用户发送消息
  ├── getOrCreateSession()
  ├── resume_pending=True → 注入 system note (NEW)
  ├── sendPromptRpc(prompt_with_note)
  └── RPC 成功 → clearResumePending() (NEW)
```

---

## 五、风险点和建议

### 5.1 关键风险

| 风险 | 缓解措施 |
|------|----------|
| RPC 子进程无法接收历史上下文 | Phase 1 阶段只做标记 + 注入 system note 到消息中；如果 pi agent 支持 session_id，可后续接入 |
| `sendPromptRpc` 不支持注入 system note | 直接在 `message.content` 前拼接文本（上面已实现） |
| 重复恢复（并发消息） | 用 `resume_pending` + freshness gate 确保只恢复一次 |
| stuck-loop（坏会话无限恢复） | 参考 Hermes 的 `_restart_failure_counts` 计数器，3次后自动 suspend |

### 5.2 建议先后顺序

1. **先实现 schema 迁移** → 添加 4 个新列（无破坏性变更）
2. **实现 `markResumePending` / `clearResumePending`** → 关机/恢复标记
3. **实现 `suspendRecentlyActive`** → 崩溃恢复
4. **修改 `onMessage` + `sendPromptRpc`** → 注入 system note
5. **添加 `.clean_shutdown` 标记** → 区分优雅关机
6. **（Phase 2）实现 `getResumePendingSessions` + 自动恢复轮次** → 需要 pi agent 侧配合

### 5.3 不需要修改的部分

- `security/auth.ts`、`security/tool-policy.ts` — 独立模块，无影响
- `adapters/` — 平台适配器只负责收发消息，不感知 session 恢复
- `paths.ts`、`logger.ts` — 无变化
- HTTP/WebSocket API — 不影响
- 现有 `resetPolicy`（idle/daily/both）— 与 `resume_pending` 互不干扰

---

## 六、总结

Hermes 的 session continuity 核心就四个字：**标记+恢复**。

1. **关机时**：把"哪些会话可能被打断"写入 SQLite（`resume_pending=true`）
2. **启动时**：读 SQLite 找到这些会话 → 合成恢复消息 → agent 继续对话
3. **成功后**：清除标记

pi-gateway 已经具备 SQLite 持久化的基础，缺少的只是这个"标记+恢复"的信号链。Phase 1 实现后，用户重启后发消息时就能看到 agent 的恢复提示和上下文延续。Phase 2 需要 pi agent 配合支持历史上下文注入才能真正做到"无缝恢复"。
