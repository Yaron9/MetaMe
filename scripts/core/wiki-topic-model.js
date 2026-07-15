'use strict';

const crypto = require('node:crypto');
const { toSlug } = require('./wiki-slug');

const DOSSIER_THRESHOLD = 3;
const CLAIM_SECTIONS = Object.freeze([
  'current_state',
  'decisions',
  'workflows',
  'failures',
  'milestones',
  'open_questions',
]);
const SECTION_TITLES = Object.freeze({
  current_state: '当前状态',
  decisions: '关键决策',
  workflows: '工作流',
  failures: '失败与教训',
  milestones: '里程碑',
  open_questions: '待确认问题',
});
const RESERVED_SEGMENTS = new Set(['.', '..', '_index', 'projects', 'curated']);

function normalizeTopicKey(raw) {
  return String(raw ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

function normalizeProjectKey(raw) {
  const normalized = normalizeTopicKey(raw);
  if (!normalized || normalized === '*' || normalized === 'unknown') return null;
  return normalized;
}

function shortHash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 8);
}

function safePathSegment(raw, { existing = [] } = {}) {
  const normalized = normalizeProjectKey(raw);
  if (!normalized) throw new Error(`invalid project key: ${raw}`);
  let segment = toSlug(normalized).slice(0, 64);
  if (segment !== normalized) segment = `${segment.slice(0, 55)}-${shortHash(normalized)}`;
  if (RESERVED_SEGMENTS.has(segment.toLowerCase())) segment = `p-${segment}`;
  const collisions = new Set(existing.map(value => String(value).toLowerCase()));
  if (collisions.has(segment.toLowerCase())) segment = `${segment.slice(0, 55)}-${shortHash(normalized)}`;
  return segment;
}

function buildDossierSlug(topicSlug, projectKey, options = {}) {
  const topic = String(topicSlug || '').trim();
  if (!topic || topic.startsWith('/') || topic.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`invalid topic slug: ${topicSlug}`);
  }
  return `${topic}/projects/${safePathSegment(projectKey, options)}`;
}

function isAtomicMemoryFact(item = {}) {
  const state = String(item.state || 'active');
  const kind = String(item.kind || 'insight');
  const relation = String(item.relation || '');
  return state === 'active'
    && (kind === 'insight' || kind === 'convention')
    && relation !== 'synthesized_insight'
    && relation !== 'knowledge_capsule';
}

function groupTopicEvidence(items = []) {
  const projects = new Map();
  const sparse = [];
  for (const item of items) {
    if (!isAtomicMemoryFact(item)) continue;
    const projectKey = normalizeProjectKey(item.project || item.scope);
    if (!projectKey) {
      sparse.push(item);
      continue;
    }
    if (!projects.has(projectKey)) projects.set(projectKey, []);
    projects.get(projectKey).push(item);
  }
  const dossiers = [];
  for (const [projectKey, facts] of projects) {
    const distinct = [...new Map(facts.map(fact => [String(fact.id), fact])).values()];
    if (distinct.length >= DOSSIER_THRESHOLD) dossiers.push({ projectKey, facts: distinct });
    else sparse.push(...distinct);
  }
  dossiers.sort((a, b) => a.projectKey.localeCompare(b.projectKey));
  return { dossiers, sparse };
}

function selectDossierEvidence(facts = [], { limit = 20, charBudget = 6000, perFactChars = 1200 } = {}) {
  const buckets = new Map();
  for (const fact of facts) {
    const key = String(fact.relation || 'unspecified');
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(fact);
  }
  const keys = [...buckets.keys()].sort();
  const selected = [];
  let used = 0;
  while (selected.length < limit && keys.some(key => buckets.get(key).length > 0)) {
    for (const key of keys) {
      const fact = buckets.get(key).shift();
      if (!fact) continue;
      const text = String(fact.content || fact.title || '').slice(0, perFactChars);
      if (selected.length > 0 && used + text.length > charBudget) continue;
      selected.push({ ...fact, _promptText: text });
      used += text.length;
      if (selected.length >= limit) break;
    }
  }
  return selected;
}

function sourceMembershipHash(evidence = []) {
  const members = evidence
    .filter(item => item && (item.evidence_id !== undefined || item.id !== undefined))
    .map(item => {
      const id = item.evidence_id || item.id;
      const controls = ['content', 'title', 'state', 'kind', 'relation', 'project', 'scope', 'tags', 'confidence']
        .map(key => item[key] ?? null);
      return `${item.evidence_type || 'memory_item'}:${id}:${JSON.stringify(controls)}`;
    })
    .sort();
  return crypto.createHash('sha256').update(members.join('\n')).digest('hex');
}

function parseStructuredClaims(raw, allowedEvidence) {
  const text = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const parsed = JSON.parse(text);
  if (!parsed || !Array.isArray(parsed.claims)) throw new Error('structured wiki output requires claims[]');
  const allowed = new Set(allowedEvidence || []);
  const claims = parsed.claims.map((claim, index) => {
    if (!CLAIM_SECTIONS.includes(claim?.section)) throw new Error(`claim ${index}: invalid section`);
    const body = String(claim?.text || '').trim();
    if (!body) throw new Error(`claim ${index}: empty text`);
    const refs = Array.isArray(claim?.evidenceRefs) ? [...new Set(claim.evidenceRefs.map(String))] : [];
    if (refs.length === 0 || refs.some(ref => !allowed.has(ref))) throw new Error(`claim ${index}: invalid evidence reference`);
    if (claim.section !== 'open_questions' && refs.some(ref => ref.startsWith('C:'))) {
      throw new Error(`claim ${index}: candidate evidence is only valid in open_questions`);
    }
    return { section: claim.section, text: body, evidenceRefs: refs };
  });
  return { claims };
}

function renderDossier({ title, projectKey, hubSlug, claims, evidence = [] }) {
  const bySection = new Map(CLAIM_SECTIONS.map(section => [section, []]));
  for (const claim of claims || []) bySection.get(claim.section).push(claim);
  const lines = [`# ${title}`, '', `> 项目：${projectKey} · 主题总览：[[topics/${hubSlug}|${title}]]`, ''];
  for (const section of CLAIM_SECTIONS) {
    const entries = bySection.get(section);
    if (entries.length === 0) continue;
    lines.push(`## ${SECTION_TITLES[section]}`, '');
    for (const claim of entries) lines.push(`- ${claim.text} ${claim.evidenceRefs.map(ref => `[^${ref}]`).join('')}`);
    lines.push('');
  }
  lines.push('## 证据索引', '');
  const evidenceByRef = new Map(evidence.map(item => [item.ref, item]));
  const used = [...new Set((claims || []).flatMap(claim => claim.evidenceRefs))].sort();
  for (const ref of used) {
    const item = evidenceByRef.get(ref);
    if (!item) throw new Error(`missing rendered evidence: ${ref}`);
    lines.push(`[^${ref}]: ${String(item.text || '').trim()}`);
  }
  return `${lines.join('\n').trim()}\n`;
}

function buildDossierPrompt({ topic, projectKey, evidence }) {
  const rows = evidence.map(item => ({
    ref: item.ref,
    state: item.state,
    kind: item.kind,
    relation: item.relation || null,
    created_at: item.created_at || null,
    text: item.text,
  }));
  return `你正在维护本地项目知识库，不是在写百科词条。\n主题：${topic}\n项目：${projectKey}\n\n`+
    `只根据下面证据总结项目当前状态、已做决策、实际工作流、失败教训、里程碑和待确认问题。`+
    `不要解释名词，不要补充常识，不要生成 wikilink。每个 claim 必须引用至少一个给定 ref。`+
    `candidate 证据只能放入 open_questions。\n\n证据：\n${JSON.stringify(rows)}\n\n`+
    `只返回 JSON：{"claims":[{"section":"current_state|decisions|workflows|failures|milestones|open_questions","text":"...","evidenceRefs":["M:id"]}]}`;
}

function renderTopicHub({ title, topicSlug, dossiers = [], sparse = [], related = [], research = [] }) {
  const lines = [`# ${title}`, '', '> 本页是主题导航与跨项目索引；项目事实保留在各项目档案中。', ''];
  if (dossiers.length > 0) {
    lines.push('## 项目档案', '');
    for (const dossier of dossiers) {
      lines.push(`- [[topics/${dossier.slug}|${dossier.projectKey}]] — ${dossier.factCount} 条本地事实`);
    }
    lines.push('');
  }
  if (sparse.length > 0) {
    lines.push('## 零散本地证据', '');
    for (const fact of sparse) lines.push(`- ${String(fact.content || fact.title || '').trim()} [^M:${fact.id}]`);
    lines.push('', '## 本地证据索引', '');
    for (const fact of sparse) lines.push(`[^M:${fact.id}]: ${String(fact.content || fact.title || '').trim()}`);
    lines.push('');
  }
  if (research.length > 0) {
    lines.push('## 研究证据', '', '> 以下内容来自导入论文或资料，不等同于本地项目事实。', '');
    for (const item of research) lines.push(`- [[sources/${item.slug}|${item.title || item.slug}]] — ${item.factCount} 条证据`);
    lines.push('');
  }
  if (related.length > 0) {
    lines.push('## 相关主题', '');
    for (const item of related) lines.push(`- [[topics/${item.slug}|${item.label || item.slug}]]`);
    lines.push('');
  }
  if (dossiers.length === 0 && sparse.length === 0 && research.length === 0) lines.push('暂无可用证据。', '');
  lines.push(`<!-- canonical-topic: ${topicSlug} -->`);
  return `${lines.join('\n').trim()}\n`;
}

function relatedTopics(rows = [], { limit = 5 } = {}) {
  return rows
    .filter(row => row.shared >= 2 && row.leftTotal > 0 && row.rightTotal > 0)
    .map(row => ({ ...row, score: row.shared / Math.sqrt(row.leftTotal * row.rightTotal) }))
    .sort((a, b) => b.score - a.score || String(a.slug).localeCompare(String(b.slug)))
    .slice(0, limit);
}

function planCanonicalTopics(topics = []) {
  const groups = new Map();
  for (const topic of topics) {
    const key = normalizeTopicKey(topic.tag);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(topic);
  }
  return [...groups.entries()].map(([normalizedKey, members]) => {
    const preferredSlug = toSlug(normalizedKey);
    const canonical = members.find(item => item.slug === preferredSlug)
      || [...members].sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')) || a.slug.localeCompare(b.slug))[0];
    return {
      ...canonical,
      normalizedKey,
      aliases: members.map(item => item.tag).sort((a, b) => a.localeCompare(b)),
      legacySlugs: members.filter(item => item.slug !== canonical.slug).map(item => item.slug).sort(),
    };
  }).sort((a, b) => a.slug.localeCompare(b.slug));
}

module.exports = {
  CLAIM_SECTIONS,
  DOSSIER_THRESHOLD,
  buildDossierSlug,
  buildDossierPrompt,
  groupTopicEvidence,
  isAtomicMemoryFact,
  normalizeProjectKey,
  normalizeTopicKey,
  parseStructuredClaims,
  planCanonicalTopics,
  relatedTopics,
  renderDossier,
  renderTopicHub,
  safePathSegment,
  selectDossierEvidence,
  sourceMembershipHash,
};
