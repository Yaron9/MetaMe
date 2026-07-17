#!/usr/bin/env node

'use strict';

/**
 * recall-report.js — read-only diagnostics over recall_audit.
 *
 * Shows trigger rate, injection volume, reason mix, and inject outcomes so
 * recall threshold tuning and灰度 decisions are data-driven.
 *
 * Usage: node ~/.metame/recall-report.js [days]   (default 30)
 */

const { summarizeAudit } = require('./core/recall-audit-db');

function formatReport(summary) {
  if (!summary) return 'recall_audit 不可用（memory.db 缺失或被锁）';
  const { totals, reasons, outcomes } = summary;
  const rate = totals.turns > 0 ? ((100 * totals.triggered) / totals.turns).toFixed(1) : '0.0';
  const lines = [
    `📡 Recall 审计报告（近 ${summary.days} 天）`,
    `轮次: ${totals.turns} | 触发: ${totals.triggered} (${rate}%) | 注入: ${totals.injected} | 截断: ${totals.truncated} | 平均注入: ${totals.avg_injected_chars} chars | 审计丢弃: ${summary.dropped}`,
  ];
  if (reasons.length > 0) {
    lines.push(`触发原因: ${reasons.map(r => `${r.reason}=${r.n}`).join(', ')}`);
  }
  if (outcomes.length > 0) {
    lines.push(`注入结局: ${outcomes.map(o => `${o.outcome}=${o.n}`).join(', ')}`);
  }
  if (totals.triggered > 0 && totals.injected === 0) {
    lines.push('提示: 有触发但从未注入 — memory_recall_enabled 仍处 observe 模式，可按 project 灰度开启。');
  }
  return lines.join('\n');
}

if (require.main === module) {
  const days = Number(process.argv[2]) || 30;
  console.log(formatReport(summarizeAudit({ days })));
}

module.exports = { formatReport };
