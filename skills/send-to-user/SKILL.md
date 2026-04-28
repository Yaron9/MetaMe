---
name: send-to-user
description: |
  把本地文件直接发到用户手机（飞书 / Telegram / iMessage），而不是只在群里报路径。
  触发：用户说「把 X 文件发我 / 给我下载 / 发到手机 / 发文件」、要 PDF/CSV/PNG/log
  下载、要查看文件内容(超过聊天可读长度)。
---

# Send-to-User — 把文件交付到用户手机

## 它解决什么问题

聊天里贴长文本/大块代码体验很糟。当用户要的是一个**文件**（截图、报表、日志、
压缩包、构件），最佳交付方式是直接把文件推到他们手机上的对话里——飞书会显示成
附件卡片、可下载、可分享。MetaMe 已经把上传、`file_key` 转换、消息发送全部封装
好,你只需要在回复里贴一个 marker。

## 怎么用——一行 marker 协议

完成你正常的回答后，**在回复末尾**为每个要交付的文件追加一行:

```
[[FILE:/absolute/path/to/file]]
```

约束:

1. **绝对路径**。不写 `~`、不写相对路径——daemon 不会做 shell 展开。
2. **一行一个文件**。多个文件就多行。每行只放一个 marker，前后不要再加文字。
3. **文件必须已经存在**。daemon 在发送前会校验存在性，不存在的会被静默丢弃。
4. **marker 独占行**。不要把 marker 写在 markdown 列表项里、不要包在反引号里。
5. 用户**看不到**这一行 marker——daemon 解析后会从输出里剥掉再回显文本，所以
   你的正文该写什么写什么,marker 是给 daemon 看的「附录」。
6. **路径含空格/中文是 OK 的**,不要做 shell 转义、不要加引号——daemon 直接当
   字面字符串送给 `fs.statSync` 与上传 API。例:`[[FILE:/Users/王总/桌面/今日报表.xlsx]]`。

## 完整示例

```
我已经把今天的访问日志整理好了，9–11 点有一波 502 集中在 nginx-edge-3，
原因是上游 keepalive 池被打满，详情见附件。

[[FILE:/var/log/metame/edge-2026-04-28.csv]]
[[FILE:/Users/yaron/Desktop/edge-error-summary.png]]
```

daemon 会:
- 文本部分作为飞书消息正常发送（"我已经把..."）
- CSV 与 PNG 各上传一次，作为飞书附件出现在用户对话里
- 上传失败时回退为文本告知文件路径,你不需要自己处理失败

## 何时**不**用

- 用户问的是文件**内容**，且文件 < ~200 行 → 直接把内容贴进消息更直接
- 用户在做代码 review，不需要文件本体只想看代码 → 用代码块更方便
- 你刚刚生成的临时文件还没写到磁盘 → 先 `Write` 工具落盘,再贴 marker

## 调试

如果用户说「没收到附件」:

1. 你的 marker 是否独占一行？多检查反引号、列表项、空格。
2. 文件是否真的存在?在 marker 之前先 `ls -la /the/path` 确认。
3. 是否大于飞书附件大小限制(单文件 30MB)？大文件请压缩或分片。
4. 飞书应用是否拥有 `im:resource` 权限?这是首装环节的事,你这边没办法补救,
   告诉用户去 https://open.feishu.cn 应用后台核对。

## 技术细节(供你判断使用)

- 解析器: `scripts/daemon-claude-engine.js` 里 `parseFileMarkers()`
- 发送器: `scripts/daemon-file-browser.js` 里 `sendFileButtons()`,优先调用
  `bot.sendFile`(飞书走 `client.im.file.create` 上传 → file_key → 消息)
- 飞书适配器: `scripts/feishu-adapter.js` 的 `sendFile(chatId, filePath, caption)`
- 失败兜底: 文本文件会被截断到 3000 字以纯文本回显;二进制文件抛错给用户。

不需要自己调以上 API——你只负责贴 marker，剩下的 daemon 都做了。
