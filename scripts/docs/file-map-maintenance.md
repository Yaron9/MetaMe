# metame-files：文件地图与安全清理

## 目标与执行路径

`metame-files-mcp-server.js` 提供文件搜索、目录地图、空间评估、候选扫描，以及需要用户确认的可恢复清理。Agent 应按以下状态机执行：

1. 用 `file_overview`、`storage_assess`、`scan_*` 或 `mole_cleanup_preview` 发现候选。
2. 用 `cleanup_propose` 固化快照；把返回的摘要展示给用户。
3. 仅在用户明确同意后，以 `batch_id`、一次性 token 和固定确认串调用 `cleanup_execute`。
4. 用 `cleanup_status` 验收结果；需要撤销时调用 `cleanup_restore`。

Mole 是可选的只读增强器：只允许 `mo --version`、`mo analyze --json <root>` 与 `mo clean --dry-run`。其输出不构成授权，也不能绕过 `cleanup_propose`。

## 硬边界

- 默认只处理普通文件；目录候选拒绝为 `directory-not-supported`。
- 路径必须是规范绝对路径，位于配置 roots 内，且不能经过符号链接或命中 protected 规则。
- proposal v2 只落盘 token 的 SHA-256；原始 token 只在创建响应中返回一次。
- 执行前再次核对 size、mtime、inode、device；任何漂移都跳过。
- quarantine 只允许同卷原子 `rename`；`EXDEV` 直接跳过，禁止回退到 copy + delete。
- 每批先原子迁移到 `inflight`，再逐项写入 `moving`；租约与源/目标状态支持进程崩溃后的幂等恢复。
- 状态目录权限为 `0700`，配置、manifest、lease、audit 为 `0600`。
- v1 proposal 禁止执行；已经执行的 v1 quarantine manifest 继续允许恢复。
- `cleanup_purge` 只把到期 quarantine 批次交给 Finder Trash；永久删除仍由用户在 Finder 中完成。
- 不自动安装 Mole，不接收任意 Mole 参数，不 vendor、链接或复制 Mole 的 GPL 实现代码。

## 验收矩阵

| 能力 | 可验证结果 | 自动化覆盖 |
|---|---|---|
| MCP 兼容 | 原 12 个工具保持，新增 `mole_cleanup_preview` | protocol tests |
| 路径安全 | traversal、symlink、root escape、protected、recent 全部拒绝 | `file-map-protect.test.js` |
| 凭证安全 | manifest 无明文 token，status 不泄露 hash | manifest/server tests |
| 并发安全 | 同一 batch 两次并发只允许一次成功 | server concurrency test |
| 崩溃恢复 | rename 后、manifest 完成前可恢复且不重复移动 | server recovery test |
| 跨卷安全 | `EXDEV` 不复制、不删除源文件 | server EXDEV test |
| 兼容恢复 | v1 executed manifest 可 restore，v1 proposal 不可 execute | server legacy tests |
| Mole 边界 | 仅白名单命令、候选去重/保护/目录拒绝、缓存 TTL | Mole core/server tests |
| 权限 | 状态目录 `0700`、元数据 `0600` | audit/server permission tests |

## 变更后的验证命令

```bash
node --test scripts/core/file-map-*.test.js scripts/metame-files-mcp-server.test.js
npx eslint scripts/core/file-map-*.js scripts/metame-files-mcp-server.js
node --test scripts/daemon-*.test.js
node index.js
```

不使用真实用户文件做自动化验收；集成测试只操作临时目录。部署或手工 smoke test 时，也应先对临时文件完成 propose → execute → status → restore 的闭环。

## 文件入口

- 边缘与 MCP transport：`scripts/metame-files-mcp-server.js`
- 配置模板：`scripts/file-map-default.yaml`
- 路径保护：`scripts/core/file-map-protect.js`
- manifest/token：`scripts/core/file-map-manifest.js`
- 执行恢复：`scripts/core/file-map-execution.js`
- quarantine 映射：`scripts/core/file-map-quarantine.js`
- Mole 解析适配：`scripts/core/file-map-mole.js`
- 审计：`scripts/core/file-map-audit.js`

