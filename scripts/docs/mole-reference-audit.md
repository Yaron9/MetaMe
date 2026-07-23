# Mole 参考审计与独立实现边界

## 参考基线

- 上游：`https://github.com/tw93/Mole`
- 审阅提交：`17683e1ac501b80456c37b23b2895398c1fe6380`
- 上游许可证：GPL-3.0
- MetaMe 许可证：MIT

审阅范围包括 `bin/purge.sh`、`bin/installer.sh`、`lib/clean/project.sh`、`lib/core/file_ops.sh`、`lib/core/app_protection.sh`、`lib/core/history.sh`、`cmd/analyze/scanner.go`、`cmd/analyze/cleanable.go` 及相应测试。

## 借鉴的行为经验

- 项目产物按项目聚合，过滤嵌套产物，近期项目默认不选择。
- 安装包从有限且明确的下载位置和格式识别，压缩包需进一步验证。
- 大文件统计考虑实际磁盘分配和硬链接。
- `CACHEDIR.TAG`、运行中应用保护、危险路径模糊测试和结构化历史记录值得保留。

这些经验被重新表达为 MetaMe 的声明式规则、受限扫描器、typed-action manifest 和现有 quarantine/audit 状态机；实现、命名、数据结构与测试均独立编写。

## 明确隔离

- 不复制或翻译 Mole 的 Shell/Go 源码、规则表、测试夹具和输出文案。
- 不 vendor、链接、调用或自动安装 Mole；npm 包和运行依赖中不包含 Mole。
- 运行时不执行 `mo` 命令，也不读取 Mole 的配置或 clean-list。
- 应用卸载、系统优化、实时状态面板和通用目录删除不在本次融合范围。
- 新规则优先依据操作系统或具体工具的公开接口；Mole 仅作为缺口清单与安全经验参考。
