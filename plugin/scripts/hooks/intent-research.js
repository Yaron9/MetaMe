'use strict';

/**
 * Research Intent Module — 科研场景按需注入
 *
 * 仅在用户/agent 涉及科研操作时注入对应提示：
 *   - 文献调研 → 注入调研方法论
 *   - 实验设计 → 注入实验规范
 *   - 论文写作 → 注入写作标准
 *   - 任务推进 → 注入永续循环协议
 *   - 数据分析 → 注入数据溯源规则
 *
 * 只对 paper_rev 项目生效。
 *
 * @param {string} prompt
 * @param {object} config
 * @param {string} projectKey
 * @returns {string|null}
 */

const RESEARCH_INTENTS = [
  {
    // 文献调研
    pattern: /文献|调研|literature|survey|paper|论文.{0,5}(搜|找|查)|state.of.the.art|相关工作|related work/i,
    hint: [
      '[研究方法：文献调研]',
      '1. WebSearch 搜索最新论文（限近3年，关注顶刊 CACAIE/ASCE/CMAME）',
      '2. 每篇记录：标题、方法、数据集、核心发现、与本研究的关联',
      '3. 产出写入 workspace/literature/<topic>.md',
      '4. 识别 research gap 后更新 workspace/research-state.md',
    ].join('\n'),
  },
  {
    // 算法设计/实验设计
    pattern: /算法|设计|design|实验方案|experiment|PINNs?|Bayesian|贝叶斯|POD|DMD|强化学习|reinforcement|EnKF|降阶/i,
    hint: [
      '[研究方法：算法设计]',
      '1. 先确认相关文献调研已完成（查 workspace/literature/）',
      '2. 设计写入 workspace/experiments/<name>/design.md',
      '3. 明确：输入数据、模型架构、损失函数、评价指标、baseline 对比方案',
      '4. 如需 FEM 数据支持，NEXT_DISPATCH: fem_sim "任务描述"',
    ].join('\n'),
  },
  {
    // 代码实现
    pattern: /代码|编写|实现|implement|coding|训练|training|PyTorch|TensorFlow|numpy|脚本/i,
    hint: [
      '[研究方法：代码实现]',
      '1. 代码写入 workspace/experiments/<name>/ 目录',
      '2. 试验数据引用: fem-workspace/experimental_data.csv, optimization_history.csv',
      '3. 运行后记录结果到 workspace/experiments/<name>/results.md',
      '4. 所有数值必须可溯源，不编造结果',
    ].join('\n'),
  },
  {
    // 论文撰写
    pattern: /撰写|写作|draft|论文.{0,3}(写|改|稿)|manuscript|章节|section|abstract|introduction|conclusion/i,
    hint: [
      '[研究方法：论文撰写]',
      '目标期刊: Computer-Aided Civil and Infrastructure Engineering (CACAIE)',
      '写作规范: 被动语态适度、hedging language、术语一致、每段有 topic sentence',
      '产出写入 workspace/drafts/<section>.md',
    ].join('\n'),
  },
  {
    // 任务推进/永续循环
    pattern: /任务|mission|下一步|next|推进|继续|开始|start|进度|progress|REVISION_COMPLETE/i,
    hint: [
      '[永续研究循环协议]',
      '1. 读 workspace/missions.md 取最高优先级 pending 任务',
      '2. 读 workspace/research-state.md 了解当前进度',
      '3. 执行任务，产出写入对应 workspace/ 子目录',
      '4. 更新 research-state.md 记录进展',
      '5. 发现新问题 → 编辑 missions.md 追加 pending',
      '6. 完成 → 输出 REVISION_COMPLETE',
      '7. 派发 FEM 任务 → NEXT_DISPATCH: fem_sim "描述"',
    ].join('\n'),
  },
  {
    // 数据分析
    pattern: /数据|分析|analyze|对比|比较|benchmark|baseline|性能|结果|results|R²|RMSE|score/i,
    hint: [
      '[研究方法：数据分析]',
      'Baseline: SGDE 框架 multi-objective score=0.9685, R²=0.9642',
      '可用数据源: fem-workspace/ 下所有 CSV 和 optimization_results/',
      '分析结果写入对应实验目录的 results.md',
    ].join('\n'),
  },
];

// 负面模式：排除日常对话
const NEGATIVE = [
  /你好|谢谢|OK|好的|收到/i,
];

module.exports = function detectResearch(prompt, config, projectKey) {
  // 只对 paper_rev 项目生效
  if (projectKey && projectKey !== 'paper_rev') return null;

  const text = String(prompt || '').trim();
  if (!text || text.length < 4) return null;
  if (NEGATIVE.some(re => re.test(text) && text.length < 10)) return null;

  const hints = [];
  for (const intent of RESEARCH_INTENTS) {
    if (intent.pattern.test(text)) {
      hints.push(intent.hint);
    }
  }

  return hints.length > 0 ? hints.join('\n\n') : null;
};
