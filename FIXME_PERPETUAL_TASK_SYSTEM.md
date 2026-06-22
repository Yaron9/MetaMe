# MetaMe 永续任务系统修复任务交接文档

**优先级**: P0/P1/P2
**目标**: 提升 perpetual task 系统的可靠性至生产级别 (需达 8/10 以上评分)
**发起者**: Digital_Me 项目
**发起时间**: 2026-04-27
**目标完成**: ASAP（阻塞 growth-ops Skill 实现）

---

## 背景

MetaMe 的永续任务系统 (perpetual task chain via NEXT_DISPATCH) 将用于 Digital_Me 的自主运营 Agent (growth-ops)。该 Agent 需要：
- 跨 session 持久运行（24/7 定时采集数据、分析、规划）
- 可靠的任务链式调用（5个 sub-agent 顺序执行，任何一个失败都要能恢复）
- 跨循环状态管理（l2cache.md、strategy-log.jsonl）

当前 MetaMe 存在 **3 个关键缺陷**，需要修复才能投入生产使用。

---

## 三大缺陷详解

### P0（关键）：Promise 拒绝未清理 runningTasks

**文件**: `plugin/scripts/daemon-task-scheduler.js` (可能还有 `scripts/daemon-task-scheduler.js`)

**问题描述**:
```
流程：
1. dispatch_to 触发 runningTasks[taskId] = promise
2. Promise 执行（调用 LLM、读写文件等）
3. 如果 Promise reject，exception 被吞（未处理）
4. runningTasks[taskId] 继续存在，永不清理
5. 心跳任务重复检查该 taskId，发现 promise 未 resolve → 卡住
6. 新的 dispatch_to 冲突检查失败 → "task already running"
7. 整个 agent 陷入僵局
```

**表现症状**:
- TTS 合成或 API 调用中断 → Promise reject
- 后续同 agent 无法再触发新任务
- `pending.jsonl` 中任务堆积无人处理
- 需要手动 `kill -9` daemon 重启才能恢复

**根本原因**:
```javascript
// 当前代码（假设位置 daemon-task-scheduler.js:720-750）
const promise = executeTask(taskId, input)
  .then(result => {
    // 处理成功情况
    runningTasks.delete(taskId)
  })
  // ❌ 缺少 .catch() 分支！

// 修复方案：
.then(result => {
  runningTasks.delete(taskId)
  return result
})
.catch(error => {
  runningTasks.delete(taskId)  // ✓ 关键：reject 时也清理
  // 写入死信队列 + 告警
  logDeadLetter(taskId, error)
  throw error  // 重新抛出，让上层处理
})
```

**修复步骤**:
1. 定位 `runningTasks` 赋值的所有位置（预期 <5 处）
2. 每处都加 `.catch()` 确保 reject 时清理
3. catch 中调用现有的 `logDeadLetter()` 或创建新的错误处理函数
4. 单元测试：创建一个 reject 的 mock task，验证 runningTasks 被清理

**影响范围**:
- 所有使用 NEXT_DISPATCH 链式调用的 agent（growth-ops、team-dispatch）
- 关键度最高（1 次失败 = agent 永久卡死）

---

### P1（高）：SQLite 并发超时无重试

**文件**: `plugin/scripts/daemon-task-envelope.js` 或相关数据库抽象层

**问题描述**:
```
流程：
1. metrics_collector 写 task-board.db（记录任务状态）
2. growth_analyzer 同时读 task-board.db（查询历史）
3. SQLite 锁冲突 → SQLITE_BUSY
4. 超时设置为 3000ms，但超时后直接失败（无重试）
5. 任务状态无法持久化 → 重启后丢失进度
6. 跨 session 恢复机制失效
```

**表现症状**:
- 高频率 task 操作时，偶发 "database is locked" 错误
- task-board.db 文件被锁定，无法正常关闭
- 多个 sub-agent 并发运行时容易触发
- TPS < 2 时完全正常，TPS > 5 时开始出错

**根本原因**:
```javascript
// 当前代码（task-board.js 假设位置）
const result = db.prepare(sql).run(params)  // ❌ 无超时配置
// 或
db.configure({ busyTimeout: 3000 })        // ✓ 有超时但无重试逻辑
db.exec(sql)  // 失败直接抛异常
```

**修复步骤**:
1. 定位所有 `db.prepare()`、`db.exec()` 调用
2. 为 db 配置 `busyTimeout: 5000` (增加到 5 秒，给 WAL journal 更多时间)
3. 在调用外包装重试逻辑：
   ```javascript
   async function dbWriteWithRetry(sql, params, maxRetries = 3) {
     for (let i = 0; i < maxRetries; i++) {
       try {
         return db.prepare(sql).run(params)
       } catch (e) {
         if (e.message.includes('SQLITE_BUSY') && i < maxRetries - 1) {
           await sleep(100 * Math.pow(2, i))  // 100ms, 200ms, 400ms
           continue
         }
         throw e
       }
     }
   }
   ```
4. 单元测试：模拟并发 write + read，验证重试成功

**影响范围**:
- metrics_collector 和 growth_analyzer 并发时
- 关键度次高（失败可重试恢复，但会延迟任务链）

---

### P2（中等）：僵尸任务无告警

**文件**: `plugin/scripts/daemon.js` + `plugin/scripts/daemon-remote-dispatch.js`

**问题描述**:
```
流程：
1. 11:00 dispatch_to growth_ops "collect"
2. metrics_collector 开始运行，5分钟后 crash
3. 无错误通知 → growth_ops 不知道 crash 了
4. growth_ops 默认等待 NEXT_DISPATCH 信号，永远等不到
5. 直到 max_depth 超时（120 分钟后），任务才被强制退出
6. 期间任务系统无反应，用户以为挂了

修复后：
1. health-scan daemon 每 5 分钟扫描一次 runningTasks
2. 发现 >30 min 未更新的 task → 告警 + 自动恢复
3. 通知 growth_ops agent 上次 sub-agent 失败
4. growth_ops 可选：重试、跳过、或打回人工审阅
```

**表现症状**:
- Sub-agent crash 或超时无反应
- 用户无法感知任务卡死
- 需要 24+ 小时才自动超时退出
- 没有可观测的错误日志

**根本原因**:
无 zombie task 检测机制。当前 daemon-agent-lifecycle.js 只检查 max_depth，不检查单个 sub-agent 的执行时间。

**修复步骤**:
1. 在 daemon-health-scan.js 添加 zombie 检测：
   ```javascript
   function detectZombieTasks() {
     const zombies = []
     for (const [taskId, task] of runningTasks.entries()) {
       const age = Date.now() - task.startedAt
       if (age > 30 * 60 * 1000) {  // 30 分钟无进度 = 僵尸
         zombies.push({ taskId, age, lastUpdate: task.lastUpdate })
       }
     }
     if (zombies.length > 0) {
       // 写入告警
       notifySlack(`🔴 ${zombies.length} zombie tasks detected`, zombies)
       // 强制杀死或标记为失败
       zombies.forEach(z => markTaskFailed(z.taskId, 'zombie_timeout'))
     }
   }
   ```
2. 集成到 health-scan 的定时检查（每 5 分钟一次）
3. 关键：将 zombie 信息传给 parent agent（growth_ops），使其能感知 sub-agent 失败
4. 单元测试：创建一个永不 resolve 的 promise，等 30 分钟后验证被标记为 zombie

**影响范围**:
- 所有长链任务（>2 个 sub-agent）
- 关键度较低（是 observability 问题，不是功能问题，但严重影响用户体验）

---

## 修复优先级与依赖关系

```
P0（阻塞）→ P1（阻塞） → P2（可选，但强烈建议）
  |              |            |
  1周             1周         1周
```

**必须顺序**：P0 > P1 > P2（上游修复后下游才能正确测试）

---

## 验收标准

### P0 验收
- [ ] daemon-task-scheduler.js 所有 Promise 都有 .catch()
- [ ] 单元测试：reject promise → runningTasks 被清理 ✓
- [ ] 集成测试：growth-ops → metrics_collector fail → growth-ops 感知到并恢复 ✓

### P1 验收
- [ ] busyTimeout 设置为 5000ms 或更高
- [ ] 数据库写入包装 dbWriteWithRetry 重试逻辑
- [ ] 单元测试：模拟 SQLITE_BUSY → 重试成功 ✓
- [ ] 性能测试：5 个并发 task 写入无锁冲突 ✓

### P2 验收
- [ ] health-scan daemon 包含 zombie 检测逻辑
- [ ] zombie task 告警正确发送（Slack/邮件）
- [ ] zombie task 被正确标记为失败
- [ ] parent agent 收到 sub-agent 失败通知 ✓

---

## 测试计划

### 单元测试
```bash
npm test -- daemon-task-scheduler.js
npm test -- daemon-task-envelope.js
npm test -- daemon-health-scan.js
```

### 集成测试（必做）
使用 growth-ops 设计中的测试场景：
1. **成功链路**：dispatch_to growth_ops → metrics_collector → growth_analyzer → ✓
2. **P0 测试**：metrics_collector crash → runningTasks 清理 → growth_ops 恢复
3. **P1 测试**：高并发（5+ task）→ 无 SQLITE_BUSY 错误
4. **P2 测试**：metrics_collector 挂起 30min → health-scan 告警 + 自动恢复

### 性能基准
- TPS (tasks/sec): >= 10
- MTBF (mean time between failures): >= 168h (1 week)
- RTO (recovery time): < 5min

---

## 相关文件快速索引

| 文件 | 行数 | 关键位置 |
|------|------|---------|
| daemon-task-scheduler.js | ~800 | Promise 处理 (≈line 720-750) |
| daemon-task-envelope.js | ~400 | SQLite 操作 (≈line 150-200) |
| daemon-health-scan.js | ~600 | zombie 检测 (新增) |
| daemon-agent-lifecycle.js | ~500 | task 超时配置 |
| task-board.js (如存在) | ~200 | db.configure() |

---

## 交接清单

- [ ] 已读本文档
- [ ] 确认 3 个缺陷的影响范围
- [ ] 规划修复顺序和时间表
- [ ] 创建 feature branch (e.g., `fix/perpetual-task-p0-p1-p2`)
- [ ] 修复 P0 + 单元测试通过
- [ ] 修复 P1 + 单元测试通过
- [ ] 修复 P2 + 单元测试通过
- [ ] 集成测试场景通过
- [ ] PR 提交，请求 code review
- [ ] Merge 到 main 分支
- [ ] 部署到 ~/.metame（或生产环境）
- [ ] 通知 Digital_Me：修复完成，ready for growth-ops implementation

---

## 联系方式与支持

- **问题澄清**: Digital_Me 项目 (当前工作目录)
- **设计文档**: `/Users/yaron/AGI/Digital_Me/.agent/GROWTH_OPS_DESIGN.md`
- **Skill 设计**: `/Users/yaron/AGI/Digital_Me/.claude/skills/biz-reel/` (参考 biz-reel 的 skill_loader 动态加载模式)
- **预计用途**: growth-ops 永续任务系统（每天 06:00 自动启动，运行数据采集→分析→选题→优化循环）

---

**文档版本**: 1.0
**最后更新**: 2026-04-28
**状态**: Ready for assignment to metame_ops
