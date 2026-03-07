cd /Users/yaron/AGI/MetaMe && npm version patch --no-git-tag-version && git add package.json
  plugin/.claude-plugin/plugin.json && git commit -m "bump $(node -p
  'require("./package.json").version')" && npm publish --otp=`<OTP>` && git push


```Bash
# 这样运行
codex --dangerously-bypass-approvals-and-sandbox
```

---

# MetaMe 双仓库结构

## Remote 配置
- **origin** → `git@github.com:Yaron9/MetaMe-private.git`（Private，日常开发）
- **public** → `git@github.com:Yaron9/MetaMe.git`（Public，公开镜像）

## 日常开发
正常 push/pull origin，两台机器都用 private repo。

## 同步公开版
```bash
./scripts/publish-public.sh --push
```
会自动把 `.private-modules` 中列出的文件替换为 stub，推送到公开 repo。

## 新机器配置
```bash
git remote rename origin public
git remote add origin git@github.com:Yaron9/MetaMe-private.git
git fetch origin
```

## 闭源模块清单（.private-modules）
- 记忆系统：memory.js, memory-extract.js, memory-gc.js, memory-index.js, memory-nightly-reflect.js, memory-search.js, memory-write.js, distill.js
- 技能进化：skill-evolution.js
- 手机端链接：daemon-bridges.js, feishu-adapter.js, telegram-adapter.js
- 认知反思：self-reflect.js, signal-capture.js, session-summarize.js
