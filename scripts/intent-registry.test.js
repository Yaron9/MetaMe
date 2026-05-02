'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  collectIntentHints,
  buildIntentHintBlock,
} = require('./intent-registry');

describe('intent-registry', () => {
  it('injects agent capability hints for real agent management intents', () => {
    const block = buildIntentHintBlock('给这个群创建一个 agent，目录是 ~/repo', {}, '');
    assert.match(block, /\[Agent 能力提示\]/);
    assert.match(block, /\/activate|\/agent bind|创建并绑定当前群/);
  });

  it('injects reset capability for natural reset phrasing instead of missing it', () => {
    const block = buildIntentHintBlock('帮我重置当前 agent 的角色', {}, '');
    assert.match(block, /\[Agent 能力提示\]/);
    assert.match(block, /\/agent reset/);
  });

  it('detects file transfer hints through the shared registry', () => {
    const hints = collectIntentHints('把报告发给我', {}, '');
    assert.equal(hints.some(item => item.key === 'file_transfer'), true);
    assert.match(buildIntentHintBlock('把报告发给我', {}, ''), /\[\[FILE:\/absolute\/path\]\]/);
  });

  it('respects daemon hook toggles', () => {
    const block = buildIntentHintBlock('把报告发给我', {
      hooks: { file_transfer: false },
    }, '');
    assert.equal(block, '');
  });

  it('prefers concrete capability hints over doc-router fallback hints', () => {
    const block = buildIntentHintBlock('帮我创建一个 agent', {}, '');
    assert.match(block, /\[Agent 能力提示\]/);
    assert.doesNotMatch(block, /agent-guide\.md/);
  });

  it('keeps agent doc routing for explicit documentation requests', () => {
    const block = buildIntentHintBlock('帮我看看 agent 怎么配置，给我文档', {}, '');
    assert.match(block, /agent-guide\.md/);
  });

  it('passes project-aware config into team dispatch detection', () => {
    const block = buildIntentHintBlock('告诉工匠处理这个', {
      projects: {
        business: {
          name: 'Business',
          team: [{ key: 'builder', name: '工匠', nicknames: ['工匠'] }],
        },
      },
    }, 'business');
    assert.match(block, /dispatch_to/);
    assert.match(block, /builder/);
  });

  it('drops stale task-create hints from the default registry surface', () => {
    const block = buildIntentHintBlock('每天九点提醒我看预算', {}, '');
    assert.doesNotMatch(block, /\/task-add/);
  });

  it('injects weixin bridge hints by default for explicit weixin setup prompts', () => {
    const block = buildIntentHintBlock('帮我配置微信桥接并开始绑定账号', {}, '');
    assert.match(block, /\[微信桥接提示\]/);
    assert.match(block, /weixin\.enabled=true/);
    assert.match(block, /\/weixin login start/);
    assert.match(block, /text-only/);
  });

  it('allows disabling weixin bridge hints explicitly', () => {
    const block = buildIntentHintBlock('帮我配置微信桥接并开始绑定账号', {
      hooks: { weixin_bridge: false },
    }, '');
    assert.doesNotMatch(block, /\[微信桥接提示\]/);
  });

  it('does not inject weixin bridge hints for generic wechat mentions', () => {
    const block = buildIntentHintBlock('我想研究微信生态的商业模式', {
      hooks: { weixin_bridge: true },
    }, '');
    assert.doesNotMatch(block, /\[微信桥接提示\]/);
  });

  it('does not inject weixin bridge hints for generic wechat complaints without bind/setup intent', () => {
    const block = buildIntentHintBlock('微信用户说怎么还没回他，你帮我排查下模型链路', {
      hooks: { weixin_bridge: true },
    }, '');
    assert.doesNotMatch(block, /\[微信桥接提示\]/);
  });

  it('does not inject weixin bridge hints for generic no-response complaints without weixin context', () => {
    const block = buildIntentHintBlock('为什么没回，用户那边一直没收到回复', {}, '');
    assert.doesNotMatch(block, /\[微信桥接提示\]/);
  });

  it('uses CLI-only memory recall hints instead of workspace-relative require paths', () => {
    const block = buildIntentHintBlock('你还记得上次我们怎么改的吗', {}, '');
    assert.match(block, /memory-search\.js/);
    assert.doesNotMatch(block, /require\("\.\/memory"\)/);
  });

  it('does not inject memory recall hints for current issue reports that merely mention a previous artifact', () => {
    const block = buildIntentHintBlock('我之前那个 agent 现在有 bug', {}, '');
    assert.doesNotMatch(block, /\[跨会话记忆提示\]/);
  });

  it('caps multi-hit injection breadth and excludes fallback docs when stronger hints exist', () => {
    const block = buildIntentHintBlock('给这个项目建个长期研究 agent，并记得上次方案', {
      projects: {
        paper_rev: { name: 'Paper Rev', reactive: true },
      },
    }, 'paper_rev');
    const titles = (block.match(/\[[^\]]+\]/g) || []);
    assert.ok(titles.length <= 2);
    assert.doesNotMatch(block, /pointer-map|hook-config|agent-guide/);
  });

  it('preserves doc routing alongside stronger hints when user explicitly asks for docs', () => {
    const block = buildIntentHintBlock('帮我创建 agent，顺便给我看看 agent 配置文档', {}, '');
    assert.match(block, /\[Agent 能力提示\]/);
    assert.match(block, /agent-guide\.md/);
  });

  it('PR2: suppressKeys filters specified intent modules out of the result', () => {
    // memory_recall hits this prompt by default — confirmed in baseline.
    const baseline = buildIntentHintBlock('你还记得上次我们怎么改的吗', {}, '');
    assert.match(baseline, /memory-search\.js/);

    // With suppressKeys, the recall hint disappears.
    const suppressed = buildIntentHintBlock('你还记得上次我们怎么改的吗', {}, '', {
      suppressKeys: ['memory_recall'],
    });
    assert.doesNotMatch(suppressed, /\[跨会话记忆提示\]/);
    assert.doesNotMatch(suppressed, /memory-search\.js/);
  });

  it('PR2: omitting opts argument keeps all intents (backward compatible)', () => {
    // 4-param overload must behave identically to legacy 3-param when opts unset.
    const a = buildIntentHintBlock('你还记得上次我们怎么改的吗', {}, '');
    const b = buildIntentHintBlock('你还记得上次我们怎么改的吗', {}, '', {});
    assert.equal(a, b);
  });

  it('PR2: empty suppressKeys array is a no-op', () => {
    const a = buildIntentHintBlock('你还记得上次我们怎么改的吗', {}, '');
    const b = buildIntentHintBlock('你还记得上次我们怎么改的吗', {}, '', { suppressKeys: [] });
    assert.equal(a, b);
  });

  it('PR2: suppressKeys does not affect non-matching intents (other hints still fire)', () => {
    // file_transfer fires on this prompt; suppressing memory_recall should not affect it.
    const block = buildIntentHintBlock('把报告发给我，还记得上次的格式吗', {}, '', {
      suppressKeys: ['memory_recall'],
    });
    assert.match(block, /\[\[FILE:\/absolute\/path\]\]/);
    assert.doesNotMatch(block, /\[跨会话记忆提示\]/);
  });
});
