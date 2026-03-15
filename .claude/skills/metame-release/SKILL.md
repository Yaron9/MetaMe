---
name: metame-release
description: MetaMe npm 发布流程（版本 bump、pre-publish 审计、OTP publish）。触发：发布/打包/出包/bump/release + MetaMe 代码上下文。勿触发：自媒体/内容发布。
---

## 发布前必查清单（不跳过，每次过一遍）

### 1. 未提交变更
```bash
git -C /Users/yaron/AGI/MetaMe status --short
git -C /Users/yaron/AGI/MetaMe diff --stat HEAD
```

### 2. ESLint（改过 daemon*.js 必须零错误才能发）
```bash
npx eslint /Users/yaron/AGI/MetaMe/scripts/daemon*.js 2>&1 | tail -5
```

### 3. 部署完整性验证（新文件是否全部到位）
```bash
node -e "
const fs=require('fs');
const ex=new Set(['sync-readme.js','test_daemon.js']);
const src=fs.readdirSync('/Users/yaron/AGI/MetaMe/scripts')
  .filter(f=>!ex.has(f)&&!/\.test\.js\$/.test(f)&&/\.(js|yaml|sh)\$/.test(f));
const dep=fs.readdirSync('/Users/yaron/.metame')
  .filter(f=>/\.(js|yaml|sh)\$/.test(f));
const miss=src.filter(f=>!dep.includes(f));
console.log('Source:',src.length,'Deployed:',dep.length);
console.log('Missing from ~/.metame:',miss.length?miss:'NONE ✅');
"
```

### 4. plugin/scripts/ 同步（Windows 用户路径）
```bash
cd /Users/yaron/AGI/MetaMe && npm run sync:plugin 2>&1 | tail -2
```

---

## 版本号规范

| 类型 | 命令 | 适用场景 |
|------|------|----------|
| patch | `npm version patch --no-git-tag-version` | bug fix、小功能 |
| minor | `npm version minor --no-git-tag-version` | 新功能模块 |
| major | `npm version major --no-git-tag-version` | 架构变更、破坏性更新 |

查当前版本：`grep '"version"' /Users/yaron/AGI/MetaMe/package.json`

---

## 完整发布步骤

```bash
# 1. 提交变更（precommit 自动运行 sync:plugin）
git -C /Users/yaron/AGI/MetaMe add <files>
git -C /Users/yaron/AGI/MetaMe commit -m "fix/feat: <描述>"

# 2. Bump 版本
cd /Users/yaron/AGI/MetaMe && npm version patch --no-git-tag-version
git -C /Users/yaron/AGI/MetaMe add package.json
git -C /Users/yaron/AGI/MetaMe commit -m "chore: bump version to X.Y.Z"

# 3. 发布（需 OTP）
cd /Users/yaron/AGI/MetaMe && npm publish --otp=<6位数字>

# 4. 验证
npm view metame-cli version
```

**OTP**：来自 Authenticator app 的 6 位数字，不是版本号。等用户提供，不要猜。

---

## 架构要点（避免重蹈覆辙）

- **npm "files"** 包含 `"scripts/"` 通配符 → 所有 `scripts/` 文件自动发布，无需手动维护列表
- **`plugin/`** 是 Claude Code 插件目录，**不是** npm 发布路径
- **`sync:plugin`** 已改为自动扫描：新增文件无需更新任何列表
- **`BUNDLED_SCRIPTS`** 在 `index.js` 也已自动扫描：排除 `*.test.js` / `sync-readme.js` / `test_daemon.js`
- **Windows 用户**：`IS_DEV_MODE=false`，走文件复制，hooks/bin 均由 `index.js` 的 `syncDirFiles` 处理
- **`daemon.yaml`** 是用户配置，永远不被覆盖（`daemon-default.yaml` 是模板）

---

## 常见错误

| 错误 | 原因 | 解决 |
|------|------|------|
| `EOTP` | 需要二步验证 | 让用户提供 Authenticator 6位码 |
| `EPUBLISHCONFLICT` | 版本号已存在 | 再 bump 一次 patch |
| `E403` | 权限问题 | `npm whoami` 确认登录状态 |
| `Cannot find module` | 新文件未部署 | 跑清单第3项验证 |
| precommit `restart:daemon` 失败 | 正常，可忽略 | commit 仍然成功 |
