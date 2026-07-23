# metame-files：文件地图与原生维护

## 执行路径

`metame-files-mcp-server.js` 原生提供搜索、目录地图、空间评估、维护候选和带确认的清理事务，不依赖外部清理器。

1. 用 `file_overview` 或 `storage_assess` 判断空间分布。
2. 用 `maintenance_scan` 发现项目产物、安装包和已知缓存；普通大文件、陈旧文件、重复文件继续使用对应的 `scan_*`。
3. 对明确选中的路径，或 `scan_id + candidate_ids`，调用 `cleanup_propose` 固化快照和一次性 token。
4. 把 `summary_for_user` 及每项可恢复性展示给用户；只有明确同意后才能调用 `cleanup_execute`。
5. 用 `cleanup_status` 验收；进入 quarantine 的文件可以 `cleanup_restore`，原生工具动作不可恢复。

旧客户端调用已移除的 `mole_cleanup_preview` 时只会收到 `tool_removed` 和 `maintenance_scan` 迁移提示；该兼容别名不在工具列表中，也不会执行命令或读写文件。

## 维护扫描语义

- `artifact`：基于项目标志识别 `node_modules`、Rust `target`、Swift `.build`、Python 虚拟环境和 `build/dist`，命中后不再向下扫描，避免嵌套重复。
- `installer`：DMG、PKG、MPKG、ISO、XIP 可直接识别；ZIP 最多检查 50 个条目，只有包含 app/pkg/mpkg 结构才成立。
- `cache`：直接复用 `storage_assess` 的缓存目录分类和运行中应用保护，不维护第二份路径表。
- 统计优先使用 allocated blocks，并按 device + inode 去重硬链接；不跟随符号链接。
- 扫描受深度、条目数、时间和候选数约束，超限返回 `partial`；分页读取同一份 0600 私有快照，不重复扫描。
- 近期候选默认不返回；即使扫描时显式包含，`cleanup_propose` 仍会拒绝近期项。

## 执行边界

| execution_mode | 行为 |
|---|---|
| `report_only` | 只解释和建议，不能进入 proposal |
| `quarantine_file` | 复用现有同卷原子隔离，可由 `cleanup_restore` 恢复 |
| `native_adapter` | 固定程序和 argv，proposal 预演，execute 再预演并比对；不可恢复 |

当前仅有两个原生适配器：

- `cargo_clean`：预演 `cargo metadata --no-deps --format-version 1 --manifest-path <Cargo.toml>`，执行 `cargo clean --manifest-path <Cargo.toml>`。
- `brew_cleanup`：预演 `brew cleanup --dry-run`，执行 `brew cleanup`。

适配器不接收 Shell 字符串、不使用 `shell: true`，也不允许用户配置命令。Docker prune、通用目录删除、浏览器缓存批量删除、Xcode 目录删除均保持 `report_only`。

## 清理事务

- 路径 proposal 保持 manifest v2；维护候选使用 typed-action manifest v3，二者共享 token、claim、lease、audit 和状态目录。
- 原始 token 只返回一次，落盘仅保存 SHA-256；执行前核对 size、mtime、inode、device。
- quarantine 只允许同卷原子 rename；`EXDEV` 失败关闭，不回退到 copy + delete。
- proposal 原子迁入 `inflight`；逐项结果实时落盘。移动操作可按源/目标状态恢复，原生动作结果不确定时标记 `adapter-outcome-unknown`，不猜测成功。
- 状态目录权限 0700，配置、快照、manifest、lease、audit 为 0600。
- v1 proposal 禁止执行；历史 v1 executed quarantine 和所有 v2 batch 保持可恢复兼容。
- `cleanup_purge` 只把到期 quarantine 批次交给 Finder Trash，永久删除仍由用户在 Finder 中完成。

## 验收

```bash
node --test scripts/core/file-map-*.test.js scripts/metame-files-mcp-server.test.js
npx eslint scripts/core/file-map-*.js scripts/metame-files-mcp-server.js
node --test scripts/daemon-*.test.js
```

自动化测试只操作临时目录，并覆盖嵌套折叠、普通 ZIP 误判、近期保护、硬链接、符号链接、分页快照、v2/v3 兼容、并发 claim、崩溃恢复、EXDEV、固定 argv、预演变化拒绝和恢复。

## 文件入口

- MCP 边缘与事务编排：`scripts/metame-files-mcp-server.js`
- 规则与扫描：`scripts/core/file-map-maintenance-rules.js`、`file-map-maintenance-scan.js`
- 固定动作：`scripts/core/file-map-maintenance-actions.js`
- 配置、保护与事务：`file-map-config.js`、`file-map-protect.js`、`file-map-manifest.js`、`file-map-execution.js`
- 来源与许可证边界：`scripts/docs/mole-reference-audit.md`
