'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const memExtract = require('./memory-extract');

describe('memory-extract Step4 fact_labels mapping', () => {
  it('maps extracted concepts to saved fact ids', () => {
    const extracted = [
      {
        entity: 'MetaMe.daemon.askClaude',
        relation: 'arch_convention',
        value: '使用单条状态消息进行流式更新，避免消息风暴。',
        concepts: ['流量控制', '状态收敛'],
        domain: 'backend',
      },
      {
        entity: 'MetaMe.memory.extract',
        relation: 'workflow_rule',
        value: '抽取失败时不标记已提取，允许下一轮重试。',
        concepts: ['可恢复性'],
      },
    ];
    const savedFacts = [
      {
        id: 'f-1',
        entity: 'MetaMe.daemon.askClaude',
        relation: 'arch_convention',
        value: '使用单条状态消息进行流式更新，避免消息风暴。',
      },
      {
        id: 'f-2',
        entity: 'MetaMe.memory.extract',
        relation: 'workflow_rule',
        value: '抽取失败时不标记已提取，允许下一轮重试。',
      },
    ];

    const rows = memExtract._private.buildFactLabelRows(extracted, savedFacts);
    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows.filter(r => r.fact_id === 'f-1').map(r => r.label).sort(),
      ['流量控制', '状态收敛']
    );
    assert.equal(rows.find(r => r.fact_id === 'f-1').domain, 'backend');
  });
});
