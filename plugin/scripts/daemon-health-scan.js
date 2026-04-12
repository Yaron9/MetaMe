'use strict';

/**
 * daemon-health-scan.js — Daily Daemon Health Report
 *
 * Reads ~/.metame/daemon.log for last 24h ERROR/WARN entries,
 * calls LLM (Haiku) to analyze root causes and propose fixes,
 * saves report to ~/.metame/health-report-latest.json,
 * then prints a formatted summary to stdout.
 *
 * Heartbeat: daily at 08:30 via daemon.yaml
 * notify: true → daemon sends stdout to Feishu automatically.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { callHaiku, buildDistillEnv } = require('./providers');

const HOME = os.homedir();
const LOG_FILE = path.join(HOME, '.metame', 'daemon.log');
const REPORT_FILE = path.join(HOME, '.metame', 'health-report-latest.json');
const WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_UNIQUE_ERRORS = 8;
const MAX_LINE_LEN = 280;

// Match log lines that contain an ERROR or WARN level tag
const LEVEL_PATTERN = /\[(ERROR|WARN)\]/;
// Extract ISO timestamp from log line prefix like [2026-04-10T08:00:00
const TS_PATTERN = /^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/;

function readRecentErrors(logFile, windowMs) {
  let content;
  try {
    content = fs.readFileSync(logFile, 'utf8');
  } catch {
    return [];
  }

  const cutoff = Date.now() - windowMs;
  const lines = content.split('\n').filter(Boolean);
  const result = [];

  for (const line of lines) {
    if (!LEVEL_PATTERN.test(line)) continue;
    const tsMatch = line.match(TS_PATTERN);
    if (tsMatch) {
      const ts = new Date(tsMatch[1]).getTime();
      if (ts < cutoff) continue;
    }
    result.push(line.slice(0, MAX_LINE_LEN));
  }

  return result;
}

function groupErrors(lines) {
  const counts = new Map();
  for (const line of lines) {
    // Normalize numbers to reduce noise, use first 100 chars as bucket key
    const key = line.slice(0, 100).replace(/\d+/g, 'N').replace(/[a-f0-9]{8,}/gi, 'HASH');
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  // Sort by frequency descending
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_UNIQUE_ERRORS)
    .map(([key, count]) => ({ key: key.trim(), count }));
}

async function analyzeWithLLM(grouped, totalCount) {
  const errorList = grouped
    .map(({ key, count }) => `[×${count}] ${key}`)
    .join('\n');

  const prompt = `你是 MetaMe daemon 的健康分析师。以下是过去24小时的错误/警告日志（已去重，按频次排序）：

${errorList}

请分析并以 JSON 格式回复：
{
  "summary": "一句话总结（20字以内）",
  "severity": "low|medium|high",
  "issues": [
    {
      "name": "问题名称（10字以内）",
      "count": 频次,
      "cause": "根因（30字以内）",
      "fix": "修复建议（50字以内）"
    }
  ],
  "action": "最紧迫的下一步行动（30字以内）"
}

severity 判断：high=影响功能/数据/重复崩溃，medium=有异常但仍可运行，low=轻微警告。
只输出 JSON，不要解释。`;

  let distillEnv = {};
  try { distillEnv = buildDistillEnv(); } catch { /* ignore */ }

  try {
    const raw = await Promise.race([
      callHaiku(prompt, distillEnv, 60000),
      new Promise((_, reject) => setTimeout(() => reject(new Error('llm_timeout')), 90000)),
    ]);
    const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(cleaned);
    // Basic validation
    if (!parsed.summary || !parsed.severity || !Array.isArray(parsed.issues)) {
      throw new Error('invalid structure');
    }
    return parsed;
  } catch {
    // Fallback: no LLM
    return {
      summary: `发现 ${totalCount} 条错误/警告`,
      severity: 'medium',
      issues: grouped.slice(0, 5).map(({ key, count }) => ({
        name: key.slice(0, 30),
        count,
        cause: '待分析',
        fix: '手动检查 daemon.log',
      })),
      action: '手动检查 ~/.metame/daemon.log',
    };
  }
}

function formatReport(analysis, totalCount, uniqueTypes) {
  const emoji = { low: '🟡', medium: '🟠', high: '🔴' }[analysis.severity] || '🟠';
  const date = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });

  const issueLines = (analysis.issues || []).slice(0, 5).map(issue =>
    `• ${issue.name}（×${issue.count}）\n  根因：${issue.cause}\n  建议：${issue.fix}`
  ).join('\n\n');

  return [
    `${emoji} Daemon 健康报告 · ${date}`,
    ``,
    `📊 过去24h：${totalCount} 条错误/警告，${uniqueTypes} 种类型`,
    `📝 摘要：${analysis.summary}`,
    ``,
    `🔍 问题详情：`,
    issueLines,
    ``,
    `⚡ 建议：${analysis.action}`,
    ``,
    `---`,
    `需要修复？回复「修」，我来处理。`,
  ].join('\n');
}

async function run() {
  const errorLines = readRecentErrors(LOG_FILE, WINDOW_MS);

  if (errorLines.length === 0) {
    console.log('✅ Daemon 健康正常 · 过去24小时无错误/警告');
    return;
  }

  const grouped = groupErrors(errorLines);
  const analysis = await analyzeWithLLM(grouped, errorLines.length);

  // Save full report for "修" handler to load
  const report = {
    generated_at: new Date().toISOString(),
    total_errors: errorLines.length,
    unique_types: grouped.length,
    analysis,
    raw_grouped: grouped,
  };

  try {
    fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2), 'utf8');
  } catch (e) {
    process.stderr.write(`[health-scan] failed to write report: ${e.message}\n`);
  }

  console.log(formatReport(analysis, errorLines.length, grouped.length));
}

run().catch(e => {
  process.stderr.write(`[daemon-health-scan] fatal: ${e.message}\n`);
  process.exit(1);
});
