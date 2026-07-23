'use strict';

require('./test-support/env-setup');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { callTool, handleMessage, _private } = require('./metame-files-mcp-server');
const { normalizeConfig } = require('./core/file-map-config');
const { quarantinePathFor } = require('./core/file-map-quarantine');

const HOME = '/home/u';
const NOW = Date.parse('2026-07-18T00:00:00Z');
const OLD = NOW - 200 * 24 * 3600 * 1000;

function tempDeps(overrides = {}) {
  return {
    loadConfig: () => { throw new Error('loadConfig not stubbed'); },
    runLines: () => { throw new Error('runLines not stubbed'); },
    runCapture: () => { throw new Error('runCapture not stubbed'); },
    fsx: { statSync: () => { throw new Error('statSync not stubbed'); } },
    home: HOME,
    fileMapDir: '/nonexistent/file-map',
    now: () => NOW,
    randomHex: n => 'a'.repeat(n * 2),
    pid: 4242,
    isPidAlive: () => false,
    ...overrides,
  };
}

function stubConfig() {
  return { ok: true, source: 'defaults', config: normalizeConfig(null, HOME) };
}

function fsxWith(files) {
  return {
    statSync: (p) => {
      if (!(p in files)) throw new Error('ENOENT');
      const f = files[p];
      return { size: f.size, mtimeMs: f.mtimeMs ?? OLD, isDirectory: () => false };
    },
  };
}

describe('metame-files-mcp-server protocol', () => {
  it('initialize / tools/list follow MCP shape with safety annotations', async () => {
    const init = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    assert.equal(init.result.serverInfo.name, 'metame-files');
    assert.ok(init.result.protocolVersion);

    const list = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const byName = new Map(list.result.tools.map(t => [t.name, t]));
    assert.equal(list.result.tools.length, 13);
    for (const name of [
      'file_search', 'file_overview', 'file_last_used', 'scan_large', 'scan_stale',
      'storage_assess', 'maintenance_scan',
    ]) {
      assert.ok(byName.has(name), `${name} must be listed`);
    }
    const destructive = new Set(['cleanup_execute', 'cleanup_purge']);
    const writesMetadata = new Set(['cleanup_propose', 'cleanup_restore']);
    for (const tool of list.result.tools) {
      assert.ok(tool.description.length > 20, `${tool.name} needs a real description`);
      assert.equal(tool.inputSchema.type, 'object');
      assert.ok(tool.annotations, `${tool.name} must declare annotations`);
      assert.equal(tool.annotations.destructiveHint, destructive.has(tool.name), `${tool.name} destructiveHint`);
      assert.equal(
        tool.annotations.readOnlyHint,
        !destructive.has(tool.name) && !writesMetadata.has(tool.name),
        `${tool.name} readOnlyHint`
      );
    }
  });

  it('notifications ignored, unknown method/tool error correctly', async () => {
    assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
    const bad = await handleMessage({ jsonrpc: '2.0', id: 3, method: 'no/such' });
    assert.equal(bad.error.code, -32601);
    await assert.rejects(() => callTool('no_such_tool', {}, tempDeps()), /unknown tool/);
  });
});

describe('maintenance_scan', () => {
  function maintenanceWorld() {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'metame-maintenance-api-')));
    const write = (rel, content = 'x') => {
      const file = path.join(home, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      return file;
    };
    write('rust/Cargo.toml', '[package]');
    write('rust/target/debug/app', 'artifact');
    write('web/package.json', '{}');
    write('web/node_modules/pkg/index.js', 'artifact');
    write('Downloads/App.dmg', 'installer');
    write('Downloads/source.zip', 'archive');
    write('Downloads/Product.zip', 'archive');
    const now = Date.now();
    const old = (now - 30 * 86400000) / 1000;
    const touchOld = current => {
      const stat = fs.lstatSync(current);
      if (stat.isDirectory()) for (const name of fs.readdirSync(current)) touchOld(path.join(current, name));
      fs.utimesSync(current, old, old);
    };
    for (const name of ['rust', 'web', 'Downloads']) touchOld(path.join(home, name));
    const calls = [];
    const deps = tempDeps({
      home,
      fileMapDir: path.join(home, '.state'),
      fsx: fs,
      now: () => now,
      randomHex: n => 'b'.repeat(n * 2),
      loadConfig: () => ({ ok: true, source: 'test', config: normalizeConfig({ roots: [home] }, home) }),
      runCapture: async (cmd, args) => {
        calls.push([cmd, args]);
        if (cmd === 'ps') return { stdout: '', error: null };
        if (cmd === 'unzip') {
          return args[1].endsWith('Product.zip')
            ? { stdout: 'Product.app/Contents/Info.plist\n', error: null }
            : { stdout: 'src/index.js\n', error: null };
        }
        return { stdout: '', error: `unexpected ${cmd}` };
      },
    });
    return { home, deps, calls, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
  }

  it('creates a private native snapshot and pages it without rescanning', async () => {
    const w = maintenanceWorld();
    const first = await callTool('maintenance_scan', { min_size_mb: 0, limit: 1 }, w.deps);
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.match(first.scan_id, /^s-\d{8}-b{32}$/);
    assert.equal(first.returned, 1);
    assert.equal(first.total, 4);
    assert.ok(first.next_cursor);
    assert.equal(first.candidates[0].snapshot, undefined, 'filesystem identity stays private');
    const scanFile = path.join(w.deps.fileMapDir, 'scans', `${first.scan_id}.json`);
    assert.equal(fs.statSync(scanFile).mode & 0o777, 0o600);

    const callsBeforePage = w.calls.length;
    const second = await callTool('maintenance_scan', {
      scan_id: first.scan_id,
      cursor: first.next_cursor,
      limit: 1,
    }, w.deps);
    assert.equal(second.ok, true);
    assert.notEqual(second.candidates[0].candidate_id, first.candidates[0].candidate_id);
    assert.equal(w.calls.length, callsBeforePage, 'snapshot pagination performs no process or filesystem scan commands');
    w.cleanup();
  });

  it('rejects roots outside the configured boundary', async () => {
    const w = maintenanceWorld();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-maintenance-outside-'));
    const out = await callTool('maintenance_scan', { roots: [outside], kinds: ['artifact'] }, w.deps);
    assert.equal(out.ok, false);
    assert.equal(out.rejected_roots[0].rule, 'outside-roots');
    fs.rmSync(outside, { recursive: true, force: true });
    w.cleanup();
  });
});

describe('file_search', () => {
  it('requires query or name', async () => {
    const out = await callTool('file_search', {}, tempDeps());
    assert.equal(out.ok, false);
    assert.match(out.error, /query.*name/);
  });

  it('expands ~ root, pages with offset/limit, enriches with stat', async () => {
    let seen = null;
    const paths = ['/home/u/a.pdf', '/home/u/b.pdf', '/home/u/c.pdf'];
    const deps = tempDeps({
      runLines: async (cmd, args, opts) => { seen = { cmd, args, opts }; return { lines: paths, truncated: false, error: null }; },
      fsx: fsxWith({ '/home/u/b.pdf': { size: 10 }, '/home/u/c.pdf': { size: 20 } }),
    });
    const out = await callTool('file_search', { query: 'report', root: '~/Docs', offset: 1, limit: 2 }, deps);
    assert.equal(seen.cmd, 'mdfind');
    assert.deepEqual(seen.args.slice(0, 2), ['-onlyin', '/home/u/Docs']);
    assert.equal(seen.opts.limit, 4, 'collects offset+limit+1 lines');
    assert.equal(out.ok, true);
    assert.equal(out.returned, 2);
    assert.equal(out.results[0].path, '/home/u/b.pdf');
    assert.equal(out.results[0].size, 10);
    assert.equal(out.results[1].size, 20);
    assert.equal(out.truncated, false, 'exactly consumed — nothing beyond the page');
  });

  it('flags truncation when more results exist and stat errors stay in-band', async () => {
    const deps = tempDeps({
      runLines: async () => ({ lines: ['/a', '/b'], truncated: false, error: null }),
      fsx: fsxWith({}),
    });
    const out = await callTool('file_search', { query: 'x', limit: 1 }, deps);
    assert.equal(out.truncated, true);
    assert.equal(out.results[0].stat_error, true);
  });

  it('count_only issues a -count query', async () => {
    let seen = null;
    const deps = tempDeps({ runCapture: async (cmd, args) => { seen = args; return { stdout: '78\n', error: null }; } });
    const out = await callTool('file_search', { query: 'x', count_only: true }, deps);
    assert.ok(seen.includes('-count'));
    assert.equal(out.count, 78);
  });
});

describe('file_overview', () => {
  it('scans a real tree, runs du under budget, caches, and honors refresh', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-fmap-srv-'));
    const root = path.join(work, 'root');
    fs.mkdirSync(path.join(root, 'Docs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'Docs', 'a.pdf'), 'a');
    let duCalls = 0;
    const deps = tempDeps({
      loadConfig: stubConfig,
      fsx: fs,
      fileMapDir: path.join(work, 'file-map'),
      runCapture: async (cmd, args) => {
        assert.equal(cmd, 'du');
        duCalls++;
        return { stdout: `77\t${args[args.length - 1]}\n`, error: null };
      },
    });
    const first = await callTool('file_overview', { root, format: 'markdown' }, deps);
    assert.equal(first.ok, true);
    assert.equal(first.cached, false);
    assert.match(first.markdown, /# File Map/);
    assert.match(first.markdown, /Docs — 77 KB · 1 files/);
    assert.ok(duCalls >= 2, 'du runs for root and Docs');
    const cacheDir = path.join(work, 'file-map', 'overviews');
    assert.equal(fs.readdirSync(cacheDir).length, 1, 'scope-keyed cache written atomically');

    const before = duCalls;
    const second = await callTool('file_overview', { root, format: 'json' }, deps);
    assert.equal(second.cached, true);
    assert.equal(duCalls, before, 'cache hit — no rescan');
    assert.equal(second.overview.nodes[0].kb, 77);

    const third = await callTool('file_overview', { root, refresh: true }, deps);
    assert.equal(third.cached, false);
    assert.ok(duCalls > before, 'refresh forces rescan');

    const nested = path.join(root, 'Docs');
    await callTool('file_overview', { root: nested, format: 'json' }, deps);
    assert.equal(fs.readdirSync(cacheDir).length, 2, 'a narrow scope cannot overwrite the wider overview');
    const wideAgain = await callTool('file_overview', { root, format: 'json' }, deps);
    assert.equal(wideAgain.cached, true, 'wide scope remains independently cached');
    fs.rmSync(work, { recursive: true, force: true });
  });

  it('du budget of zero leaves sizes null instead of blocking', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-fmap-srv-'));
    const root = path.join(work, 'root');
    fs.mkdirSync(root, { recursive: true });
    const cfg = stubConfig();
    cfg.config.overview.duBudgetSeconds = 0;
    const deps = tempDeps({
      loadConfig: () => cfg,
      fsx: fs,
      fileMapDir: path.join(work, 'file-map'),
      runCapture: async () => { throw new Error('du must not run with zero budget'); },
    });
    const out = await callTool('file_overview', { root, format: 'json' }, deps);
    assert.equal(out.ok, true);
    assert.equal(out.overview.nodes[0].kb, null);
    fs.rmSync(work, { recursive: true, force: true });
  });
});

describe('file_last_used', () => {
  it('rejects empty/relative input, resolves batch mdls for existing files', async () => {
    const bad = await callTool('file_last_used', { paths: ['relative.txt'] }, tempDeps());
    assert.equal(bad.ok, false);

    let mdlsArgs = null;
    const deps = tempDeps({
      fsx: fsxWith({ '/home/u/x.dmg': { size: 5 } }),
      runCapture: async (cmd, args) => { mdlsArgs = { cmd, args }; return { stdout: '2025-01-01 00:00:00 +0000\0', error: null }; },
    });
    const out = await callTool('file_last_used', { paths: ['/home/u/x.dmg', '/home/u/gone.txt'] }, deps);
    assert.equal(mdlsArgs.cmd, 'mdls');
    assert.ok(mdlsArgs.args.includes('-raw'));
    assert.equal(mdlsArgs.args.filter(a => a.startsWith('/')).length, 1, 'only existing files hit mdls');
    assert.equal(out.items[0].last_used_known, true);
    assert.match(out.items[0].last_used, /2025-01-01/);
    assert.equal(out.items[1].exists, false);
  });
});

describe('scan_large', () => {
  it('sorts by size desc, flags protected entries, reports total count', async () => {
    const files = {
      '/home/u/Downloads/small.zip': { size: 100 },
      '/home/u/Downloads/big.iso': { size: 900 },
      '/home/u/Library/big.dat': { size: 500 },
    };
    const deps = tempDeps({
      loadConfig: stubConfig,
      fsx: fsxWith(files),
      runLines: async () => ({ lines: Object.keys(files), truncated: false, error: null }),
      runCapture: async () => ({ stdout: '3\n', error: null }),
    });
    const out = await callTool('scan_large', { root: '~/x' }, deps);
    assert.equal(out.ok, true);
    assert.deepEqual(out.results.map(r => r.size), [900, 500, 100]);
    assert.equal(out.results[1].protected, true, '~/Library entry must be flagged');
    assert.equal(out.results[0].protected, undefined);
    assert.equal(out.total_count, 3);
    assert.equal(out.listed_bytes, 1500);
  });
});

describe('scan_duplicates', () => {
  it('requires root and falls back to the builtin engine when fclones is missing', async () => {
    const noRoot = await callTool('scan_duplicates', {}, tempDeps());
    assert.equal(noRoot.ok, false);

    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-fmap-srv-'));
    const big = 'D'.repeat(1024 * 1024 + 1);
    fs.mkdirSync(path.join(work, 'x'));
    fs.writeFileSync(path.join(work, 'x', 'one.bin'), big);
    fs.writeFileSync(path.join(work, 'x', 'two.bin'), big);
    fs.writeFileSync(path.join(work, 'x', 'other.bin'), big.replace('D', 'E'));
    const srv = require('./metame-files-mcp-server')._private;
    const deps = tempDeps({
      loadConfig: stubConfig,
      fsx: fs,
      hashHead: srv.defaultDeps().hashHead,
      hashFull: srv.defaultDeps().hashFull,
      runCapture: async (cmd) => {
        assert.equal(cmd, 'fclones');
        return { stdout: '', error: 'spawn fclones ENOENT' };
      },
    });
    const out = await callTool('scan_duplicates', { root: work }, deps);
    assert.equal(out.ok, true);
    assert.equal(out.engine, 'builtin');
    assert.equal(out.group_count, 1);
    assert.equal(out.groups[0].count, 2);
    assert.equal(out.groups[0].confidence, 'confirmed');
    assert.equal(out.total_wasted_bytes, big.length);
    fs.rmSync(work, { recursive: true, force: true });
  });

  it('prefers fclones JSON when the binary responds', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-fmap-srv-'));
    const deps = tempDeps({
      loadConfig: stubConfig,
      fsx: fs,
      runCapture: async (cmd, args) => {
        if (args[0] === '--version') return { stdout: 'fclones 0.35.0', error: null };
        assert.equal(args[0], 'group');
        return { stdout: JSON.stringify({ groups: [{ file_len: 9, files: ['/a/1', '/a/2'] }] }), error: null };
      },
    });
    const out = await callTool('scan_duplicates', { root: work }, deps);
    assert.equal(out.engine, 'fclones');
    assert.equal(out.groups[0].wasted_bytes, 9);
    fs.rmSync(work, { recursive: true, force: true });
  });
});

describe('cleanup pipeline', () => {
  function pipelineWorld() {
    // realpath: os.tmpdir() sits behind the /var → /private/var symlink, and the
    // default protection net covers /private/** — resolve first so the test
    // world is its own clean "home".
    const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'metame-fmap-clean-')));
    fs.mkdirSync(path.join(work, 'Downloads'), { recursive: true });
    fs.mkdirSync(path.join(work, '.ssh'), { recursive: true });
    const old = (Date.now() - 100 * 24 * 3600 * 1000) / 1000;
    const mk = (rel) => {
      const p = path.join(work, rel);
      fs.writeFileSync(p, `content of ${rel}`);
      fs.utimesSync(p, old, old);
      return p;
    };
    const stale1 = mk('Downloads/old1.dmg');
    const stale2 = mk('Downloads/old2.zip');
    const secret = mk('.ssh/id_rsa');
    let clock = Date.now();
    let seq = 0;
    const osascriptCalls = [];
    const deps = tempDeps({
      // custom protected list: the default net would (correctly) reject the
      // /private tmp world; keep the .ssh rule to exercise protection.
      loadConfig: () => ({ ok: true, source: 'test', config: normalizeConfig({ protected: ['**/.ssh/**'] }, work) }),
      fsx: fs,
      home: work,
      fileMapDir: path.join(work, 'file-map'),
      now: () => clock,
      randomHex: (n) => (seq++).toString(16).padStart(n * 2, '0'),
      runCapture: async (cmd, args) => {
        if (cmd === 'osascript') { osascriptCalls.push(args); return { stdout: '', error: null }; }
        return { stdout: '', error: `spawn ${cmd} ENOENT` };
      },
    });
    return {
      work, stale1, stale2, secret, deps, osascriptCalls,
      tick: (ms) => { clock += ms; },
      cleanup: () => fs.rmSync(work, { recursive: true, force: true }),
    };
  }

  function addOldMaintenanceProjects(w) {
    const write = (rel, content = 'x') => {
      const file = path.join(w.work, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      return file;
    };
    write('rust/Cargo.toml', '[package]');
    write('rust/target/debug/app', 'artifact');
    write('web/package.json', '{}');
    write('web/node_modules/pkg/index.js', 'artifact');
    const old = (w.deps.now() - 100 * 86400000) / 1000;
    const touchOld = current => {
      const stat = fs.lstatSync(current);
      if (stat.isDirectory()) for (const name of fs.readdirSync(current)) touchOld(path.join(current, name));
      fs.utimesSync(current, old, old);
    };
    touchOld(path.join(w.work, 'rust'));
    touchOld(path.join(w.work, 'web'));
  }

  it('full lifecycle: propose gates → execute moves to quarantine → restore brings back', async () => {
    const w = pipelineWorld();
    // propose: protected + missing paths rejected, valid ones snapshotted
    const prop = await callTool('cleanup_propose', {
      paths: [w.stale1, w.stale2, w.secret, path.join(w.work, 'gone.txt')],
      reason: 'stale downloads cleanup',
      source: 'scan_stale',
    }, w.deps);
    assert.equal(prop.ok, true);
    assert.equal(prop.accepted, 2);
    assert.equal(prop.rejected.length, 2);
    assert.ok(prop.rejected.some(r => r.path === w.secret && /protected/.test(r.rule)), 'ssh key must be protected');
    assert.match(prop.summary_for_user, /explicit consent/);
    const proposalFile = path.join(w.work, 'file-map', 'proposals', `${prop.batch_id}.json`);
    const storedProposal = JSON.parse(fs.readFileSync(proposalFile, 'utf8'));
    assert.equal(storedProposal.token, undefined, 'raw capability token is never persisted');
    assert.equal(typeof storedProposal.token_hash, 'string');
    assert.equal(fs.statSync(proposalFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(proposalFile)).mode & 0o777, 0o700);

    // wrong confirm / wrong token / fake batch all refuse
    const noConfirm = await callTool('cleanup_execute', { batch_id: prop.batch_id, token: prop.token, confirm: 'yes' }, w.deps);
    assert.equal(noConfirm.ok, false);
    const badToken = await callTool('cleanup_execute', { batch_id: prop.batch_id, token: 'ffffffff', confirm: 'USER CONFIRMED' }, w.deps);
    assert.equal(badToken.ok, false);
    assert.match(badToken.error, /token/);
    const fake = await callTool('cleanup_execute', { batch_id: 'b-20260718-9999', token: prop.token, confirm: 'USER CONFIRMED' }, w.deps);
    assert.equal(fake.ok, false);
    assert.ok(fs.existsSync(w.stale1), 'nothing moved by refused attempts');

    // drift: touch stale2 between propose and execute → skipped
    fs.appendFileSync(w.stale2, 'changed');

    const exec = await callTool('cleanup_execute', { batch_id: prop.batch_id, token: prop.token, confirm: 'USER CONFIRMED' }, w.deps);
    assert.equal(exec.ok, true);
    assert.equal(exec.moved, 1);
    assert.equal(exec.skipped.length, 1);
    assert.ok(!fs.existsSync(w.stale1), 'stale1 moved out');
    assert.ok(fs.existsSync(w.stale2), 'drifted file untouched');
    const qDir = path.join(w.work, 'file-map', 'quarantine', prop.batch_id);
    const [quarantinedName] = fs.readdirSync(qDir);
    const qPath = path.join(qDir, quarantinedName);
    assert.match(quarantinedName, /^[0-9a-f]{64}--old1\.dmg$/);
    assert.ok(fs.existsSync(qPath), 'quarantine uses an opaque contained path');
    assert.ok(!fs.existsSync(path.join(w.work, 'file-map', 'proposals', `${prop.batch_id}.json`)), 'proposal consumed');

    // replay refused
    const replay = await callTool('cleanup_execute', { batch_id: prop.batch_id, token: prop.token, confirm: 'USER CONFIRMED' }, w.deps);
    assert.equal(replay.ok, false);

    // status shows executed + restorable, audit trail recorded
    const status = await callTool('cleanup_status', { audit_tail: 50 }, w.deps);
    assert.equal(JSON.stringify(status).includes('token_hash'), false, 'status must not disclose token hashes');
    assert.equal(status.executed.length, 1);
    assert.equal(status.executed[0].restorable, true);
    assert.ok(status.quarantine_bytes > 0);
    assert.deepEqual(status.purge_due, []);
    assert.ok(status.audit.some(r => r.event === 'propose'));
    assert.ok(status.audit.some(r => r.event === 'execute' && r.outcome === 'moved'));
    assert.ok(status.audit.some(r => r.event === 'skip'));

    // restore
    const restore = await callTool('cleanup_restore', { batch_id: prop.batch_id }, w.deps);
    assert.equal(restore.ok, true);
    assert.equal(restore.restored, 1);
    assert.ok(fs.existsSync(w.stale1), 'file back in place');
    assert.equal(fs.readFileSync(w.stale1, 'utf8'), 'content of Downloads/old1.dmg');
    const status2 = await callTool('cleanup_status', { batch_id: prop.batch_id }, w.deps);
    assert.equal(status2.manifest.status, 'restored');
    w.cleanup();
  });

  it('executes a mixed v3 batch through quarantine and exact native argv', async () => {
    const w = pipelineWorld();
    addOldMaintenanceProjects(w);
    const calls = [];
    w.deps.runCapture = async (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'ps') return { stdout: '', error: null };
      if (cmd === 'unzip') return { stdout: 'src/index.js\n', error: null };
      if (cmd === 'cargo' && args[0] === 'metadata') return { stdout: '{"workspace_root":"rust"}\n', error: null };
      if (cmd === 'cargo' && args[0] === 'clean') return { stdout: 'Removed files\n', error: null };
      return { stdout: '', error: `unexpected ${cmd}` };
    };
    const scan = await callTool('maintenance_scan', {
      roots: [w.work], kinds: ['artifact', 'installer'], min_size_mb: 0, limit: 100,
    }, w.deps);
    assert.equal(scan.ok, true);
    const cargo = scan.candidates.find(item => item.rule_id === 'rust-target');
    const nodeModules = scan.candidates.find(item => item.rule_id === 'javascript-node-modules');
    const installer = scan.candidates.find(item => item.path === w.stale1);
    assert.ok(cargo && nodeModules && installer);

    const proposal = await callTool('cleanup_propose', {
      scan_id: scan.scan_id,
      candidate_ids: [cargo.candidate_id, nodeModules.candidate_id, installer.candidate_id],
      reason: 'reviewed rebuildable output and installer',
    }, w.deps);
    assert.equal(proposal.ok, true);
    assert.equal(proposal.proposal_version, 3);
    assert.equal(proposal.accepted, 2);
    assert.equal(proposal.recoverable_items, 1);
    assert.equal(proposal.non_restorable_actions, 1);
    assert.equal(proposal.rejected[0].rule, 'report-only');
    assert.match(proposal.summary_for_user, /NOT restorable/);

    const executed = await callTool('cleanup_execute', {
      batch_id: proposal.batch_id, token: proposal.token, confirm: 'USER CONFIRMED',
    }, w.deps);
    assert.equal(executed.ok, true);
    assert.equal(executed.moved, 1);
    assert.equal(executed.actions_completed, 1);
    assert.equal(executed.bytes_freed_estimated, true);
    assert.match(executed.restore_hint, /remain non-restorable/);
    assert.ok(!fs.existsSync(w.stale1));
    const cargoCalls = calls.filter(([cmd]) => cmd === 'cargo');
    assert.deepEqual(cargoCalls, [
      ['cargo', ['metadata', '--no-deps', '--format-version', '1', '--manifest-path', path.join(w.work, 'rust', 'Cargo.toml')]],
      ['cargo', ['metadata', '--no-deps', '--format-version', '1', '--manifest-path', path.join(w.work, 'rust', 'Cargo.toml')]],
      ['cargo', ['clean', '--manifest-path', path.join(w.work, 'rust', 'Cargo.toml')]],
    ]);
    const restored = await callTool('cleanup_restore', { batch_id: proposal.batch_id }, w.deps);
    assert.equal(restored.restored, 1);
    assert.ok(fs.existsSync(w.stale1));
    const status = await callTool('cleanup_status', { batch_id: proposal.batch_id }, w.deps);
    assert.equal(status.manifest.status, 'restored_with_nonreversible_actions');
    w.cleanup();
  });

  it('fails closed when an adapter preflight changes after proposal', async () => {
    const w = pipelineWorld();
    addOldMaintenanceProjects(w);
    let metadata = 'before';
    let cleaned = false;
    w.deps.runCapture = async (cmd, args) => {
      if (cmd === 'ps') return { stdout: '', error: null };
      if (cmd === 'unzip') return { stdout: 'src/index.js\n', error: null };
      if (cmd === 'cargo' && args[0] === 'metadata') return { stdout: metadata, error: null };
      if (cmd === 'cargo' && args[0] === 'clean') { cleaned = true; return { stdout: '', error: null }; }
      return { stdout: '', error: `unexpected ${cmd}` };
    };
    const scan = await callTool('maintenance_scan', { roots: [w.work], kinds: ['artifact'], min_size_mb: 0 }, w.deps);
    const cargo = scan.candidates.find(item => item.rule_id === 'rust-target');
    const proposal = await callTool('cleanup_propose', {
      scan_id: scan.scan_id, candidate_ids: [cargo.candidate_id], reason: 'reviewed rust build output',
    }, w.deps);
    metadata = 'after';
    const executed = await callTool('cleanup_execute', {
      batch_id: proposal.batch_id, token: proposal.token, confirm: 'USER CONFIRMED',
    }, w.deps);
    assert.equal(executed.actions_completed, 0);
    assert.equal(executed.skipped[0].reason, 'preflight-changed');
    assert.equal(cleaned, false);
    w.cleanup();
  });

  it('keeps Homebrew cleanup behind dry-run parity and fixed argv', async () => {
    const w = pipelineWorld();
    const cache = path.join(w.work, 'Library', 'Caches', 'Homebrew');
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(path.join(cache, 'download.tar'), 'cache');
    const old = (w.deps.now() - 100 * 86400000) / 1000;
    fs.utimesSync(path.join(cache, 'download.tar'), old, old);
    fs.utimesSync(cache, old, old);
    const calls = [];
    w.deps.runCapture = async (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'ps') return { stdout: '', error: null };
      if (cmd === 'brew' && args[1] === '--dry-run') return { stdout: 'Would remove download.tar\n', error: null };
      if (cmd === 'brew' && args[0] === 'cleanup') return { stdout: 'Removed download.tar\n', error: null };
      return { stdout: '', error: `unexpected ${cmd}` };
    };
    const scan = await callTool('maintenance_scan', { kinds: ['cache'], min_size_mb: 0 }, w.deps);
    const brew = scan.candidates.find(item => item.rule_id === 'homebrew-cache');
    assert.ok(brew);
    const proposal = await callTool('cleanup_propose', {
      scan_id: scan.scan_id, candidate_ids: [brew.candidate_id], reason: 'reviewed Homebrew cache',
    }, w.deps);
    const executed = await callTool('cleanup_execute', {
      batch_id: proposal.batch_id, token: proposal.token, confirm: 'USER CONFIRMED',
    }, w.deps);
    assert.equal(executed.actions_completed, 1);
    assert.deepEqual(calls.filter(([cmd]) => cmd === 'brew'), [
      ['brew', ['cleanup', '--dry-run']],
      ['brew', ['cleanup', '--dry-run']],
      ['brew', ['cleanup']],
    ]);
    w.cleanup();
  });

  it('expired proposals refuse execution and are GC-ed by the next propose', async () => {
    const w = pipelineWorld();
    const prop = await callTool('cleanup_propose', { paths: [w.stale1], reason: 'ttl test run' }, w.deps);
    w.tick(61 * 60 * 1000);
    const exec = await callTool('cleanup_execute', { batch_id: prop.batch_id, token: prop.token, confirm: 'USER CONFIRMED' }, w.deps);
    assert.equal(exec.ok, false);
    assert.match(exec.error, /expired/);
    assert.ok(fs.existsSync(w.stale1));

    const prop2 = await callTool('cleanup_propose', { paths: [w.stale2], reason: 'second batch' }, w.deps);
    assert.equal(prop2.ok, true);
    assert.ok(!fs.existsSync(path.join(w.work, 'file-map', 'proposals', `${prop.batch_id}.json`)), 'expired proposal GC-ed');
    w.cleanup();
  });

  it('rejects directories and legacy proposals', async () => {
    const w = pipelineWorld();
    const dir = path.join(w.work, 'Downloads', 'old-dir');
    fs.mkdirSync(dir);
    const old = (Date.now() - 100 * 24 * 3600 * 1000) / 1000;
    fs.utimesSync(dir, old, old);
    const directoryProposal = await callTool('cleanup_propose', { paths: [dir], reason: 'directory test' }, w.deps);
    assert.equal(directoryProposal.ok, false);
    assert.ok(directoryProposal.rejected.some(item => item.rule === 'directory-not-supported'));

    const legacyId = 'b-20260718-abab';
    const proposals = path.join(w.work, 'file-map', 'proposals');
    fs.mkdirSync(proposals, { recursive: true });
    fs.writeFileSync(path.join(proposals, `${legacyId}.json`), JSON.stringify({
      version: 1, batch_id: legacyId, token: 'abababab', status: 'proposed',
      expires_at: new Date(Date.now() + 3600000).toISOString(), items: [], totals: { count: 0, bytes: 0 },
    }));
    const legacy = await callTool('cleanup_execute', {
      batch_id: legacyId, token: 'abababab', confirm: 'USER CONFIRMED',
    }, w.deps);
    assert.equal(legacy.ok, false);
    assert.match(legacy.error, /legacy proposal/);
    w.cleanup();
  });

  it('atomically admits only one concurrent execution', async () => {
    const w = pipelineWorld();
    const prop = await callTool('cleanup_propose', { paths: [w.stale1], reason: 'concurrency test' }, w.deps);
    const args = { batch_id: prop.batch_id, token: prop.token, confirm: 'USER CONFIRMED' };
    const results = await Promise.all([
      callTool('cleanup_execute', args, w.deps),
      callTool('cleanup_execute', args, w.deps),
    ]);
    assert.equal(results.filter(result => result.ok).length, 1);
    assert.equal(results.filter(result => !result.ok).length, 1);
    assert.ok(!fs.existsSync(w.stale1));
    w.cleanup();
  });

  it('blocks a fresh malformed lease but reclaims it after the timeout', () => {
    const w = pipelineWorld();
    const batchId = 'b-20260718-abab';
    const inflight = path.join(w.work, 'file-map', 'inflight');
    const leaseFile = path.join(inflight, `${batchId}.lease`);
    fs.mkdirSync(inflight, { recursive: true });
    fs.writeFileSync(leaseFile, '{torn');
    const fresh = _private.acquireExecutionLease(w.deps, batchId);
    assert.deepEqual(fresh, { ok: false, error: 'execution-in-progress' });
    fs.utimesSync(leaseFile, (w.deps.now() - 6 * 60 * 1000) / 1000, (w.deps.now() - 6 * 60 * 1000) / 1000);
    const reclaimed = _private.acquireExecutionLease(w.deps, batchId);
    assert.equal(reclaimed.ok, true);
    assert.equal(fs.statSync(leaseFile).mode & 0o777, 0o600);
    _private.releaseExecutionLease(w.deps, batchId);
    w.cleanup();
  });

  it('recovers a crash after rename but before manifest completion', async () => {
    const w = pipelineWorld();
    const prop = await callTool('cleanup_propose', { paths: [w.stale1], reason: 'crash recovery' }, w.deps);
    const proposalFile = path.join(w.work, 'file-map', 'proposals', `${prop.batch_id}.json`);
    const inflightDir = path.join(w.work, 'file-map', 'inflight');
    const inflightFile = path.join(inflightDir, `${prop.batch_id}.json`);
    fs.mkdirSync(inflightDir, { recursive: true });
    const manifest = JSON.parse(fs.readFileSync(proposalFile, 'utf8'));
    const dest = quarantinePathFor(path.join(w.work, 'file-map', 'quarantine'), prop.batch_id, w.stale1);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    manifest.status = 'inflight';
    manifest.items[0].result = 'moving';
    manifest.items[0].quarantine_path = dest;
    fs.renameSync(w.stale1, dest);
    fs.renameSync(proposalFile, inflightFile);
    fs.writeFileSync(inflightFile, JSON.stringify(manifest));

    const recovered = await callTool('cleanup_execute', {
      batch_id: prop.batch_id, token: prop.token, confirm: 'USER CONFIRMED',
    }, w.deps);
    assert.equal(recovered.ok, true);
    assert.equal(recovered.moved, 1);
    assert.ok(fs.existsSync(dest));
    assert.ok(!fs.existsSync(w.stale1));
    w.cleanup();
  });

  it('fails closed on EXDEV and leaves the source untouched', async () => {
    const w = pipelineWorld();
    const realFs = w.deps.fsx;
    w.deps.fsx = new Proxy(realFs, {
      get(target, prop) {
        if (prop === 'renameSync') {
          return (from, to) => {
            if (from === w.stale1 && String(to).includes('/quarantine/')) {
              throw Object.assign(new Error('simulated EXDEV'), { code: 'EXDEV' });
            }
            return target.renameSync(from, to);
          };
        }
        return target[prop];
      },
    });
    const prop = await callTool('cleanup_propose', { paths: [w.stale1], reason: 'cross volume test' }, w.deps);
    const out = await callTool('cleanup_execute', {
      batch_id: prop.batch_id, token: prop.token, confirm: 'USER CONFIRMED',
    }, w.deps);
    assert.equal(out.ok, true);
    assert.equal(out.moved, 0);
    assert.equal(out.skipped[0].reason, 'cross-device-quarantine-disabled');
    assert.ok(fs.existsSync(w.stale1));
    w.cleanup();
  });

  it('keeps legacy executed quarantine manifests restorable', async () => {
    const w = pipelineWorld();
    const batchId = 'b-20260718-abab';
    const quarantineDir = path.join(w.work, 'file-map', 'quarantine', batchId);
    const executedDir = path.join(w.work, 'file-map', 'executed');
    const quarantined = path.join(quarantineDir, 'legacy-old1.dmg');
    fs.mkdirSync(quarantineDir, { recursive: true });
    fs.mkdirSync(executedDir, { recursive: true });
    fs.renameSync(w.stale1, quarantined);
    fs.writeFileSync(path.join(executedDir, `${batchId}.json`), JSON.stringify({
      version: 1,
      batch_id: batchId,
      status: 'executed',
      method: 'quarantine',
      executed_at: new Date(w.deps.now()).toISOString(),
      items: [{ path: w.stale1, quarantine_path: quarantined, result: 'moved', size: 1 }],
    }));
    const restored = await callTool('cleanup_restore', { batch_id: batchId }, w.deps);
    assert.equal(restored.ok, true);
    assert.equal(restored.restored, 1);
    assert.ok(fs.existsSync(w.stale1));
    w.cleanup();
  });

  it('hardens existing state metadata without changing payload files', () => {
    const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'metame-fmap-mode-')));
    const fileMapDir = path.join(work, 'file-map');
    const proposalDir = path.join(fileMapDir, 'proposals');
    fs.mkdirSync(proposalDir, { recursive: true, mode: 0o755 });
    const metadata = path.join(proposalDir, 'b-20260718-abab.json');
    fs.writeFileSync(metadata, '{}', { mode: 0o644 });
    _private.hardenStatePermissions({ fsx: fs, fileMapDir, configPath: path.join(work, 'file-map.yaml') });
    assert.equal(fs.statSync(fileMapDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(proposalDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(metadata).mode & 0o777, 0o600);
    fs.rmSync(work, { recursive: true, force: true });
  });

  it('purge moves due batches to Trash via Finder and needs explicit targeting', async () => {
    const w = pipelineWorld();
    const prop = await callTool('cleanup_propose', { paths: [w.stale1], reason: 'purge test run' }, w.deps);
    await callTool('cleanup_execute', { batch_id: prop.batch_id, token: prop.token, confirm: 'USER CONFIRMED' }, w.deps);

    const noArgs = await callTool('cleanup_purge', {}, w.deps);
    assert.equal(noArgs.ok, false);

    const notDue = await callTool('cleanup_purge', { all_due: true }, w.deps);
    assert.deepEqual(notDue.purged, [], 'young batch is not due');

    w.tick(31 * 24 * 3600 * 1000);
    const due = await callTool('cleanup_purge', { all_due: true }, w.deps);
    assert.deepEqual(due.purged, [prop.batch_id]);
    assert.equal(w.osascriptCalls.length, 1, 'quarantine dir sent to Finder Trash');
    assert.match(w.osascriptCalls[0][1], /Finder.*delete POSIX file/);
    const status = await callTool('cleanup_status', { batch_id: prop.batch_id }, w.deps);
    assert.equal(status.manifest.status, 'purged');
    w.cleanup();
  });

  it('config failure disables the destructive pipeline entirely', async () => {
    const deps = tempDeps({ loadConfig: () => ({ ok: false, error: 'bad yaml', config: normalizeConfig(null, HOME) }) });
    const prop = await callTool('cleanup_propose', { paths: ['/x/y'], reason: 'should not run' }, deps);
    assert.equal(prop.ok, false);
    assert.match(prop.error, /disabled/);
    const exec = await callTool('cleanup_execute', { batch_id: 'b-20260718-abab', token: 'abababab', confirm: 'USER CONFIRMED' }, deps);
    assert.equal(exec.ok, false);
  });
});

describe('scan_stale', () => {
  it('drops recently modified files, labels confidence from mdls output', async () => {
    const files = {
      '/home/u/old-confirmed.mov': { size: 300, mtimeMs: OLD },
      '/home/u/old-unknown.bin': { size: 200, mtimeMs: OLD },
      '/home/u/fresh.mov': { size: 900, mtimeMs: NOW - 1000 },
    };
    const deps = tempDeps({
      loadConfig: stubConfig,
      fsx: fsxWith(files),
      runLines: async () => ({ lines: Object.keys(files), truncated: false, error: null }),
      runCapture: async () => ({ stdout: '2024-01-05 08:00:00 +0000\0(null)\0', error: null }),
    });
    const out = await callTool('scan_stale', { root: '~' }, deps);
    assert.equal(out.ok, true);
    assert.deepEqual(out.results.map(r => r.path), ['/home/u/old-confirmed.mov', '/home/u/old-unknown.bin'], 'fresh file excluded, size desc');
    assert.equal(out.results[0].confidence, 'confirmed_stale');
    assert.match(out.results[0].last_used, /2024-01-05/);
    assert.equal(out.results[1].confidence, 'never_recorded');
    assert.equal(out.results[1].last_used, null);
  });

  it('surfaces mdfind failure as in-band error', async () => {
    const deps = tempDeps({
      loadConfig: stubConfig,
      runLines: async () => ({ lines: [], truncated: false, error: 'spawn mdfind ENOENT' }),
    });
    const out = await callTool('scan_stale', {}, deps);
    assert.equal(out.ok, false);
    assert.match(out.error, /ENOENT/);
  });
});

describe('storage_assess', () => {
  it('reports disk baseline, categorized sizes, guards and a review-only target plan', async () => {
    const present = new Set([
      '/home/u/.Trash',
      '/home/u/Library/Caches/com.apple.Safari',
      '/home/u/.npm',
    ]);
    const kb = new Map([
      ['/home/u/.Trash', 1024],
      ['/home/u/Library/Caches/com.apple.Safari', 2048],
      ['/home/u/.npm', 4096],
    ]);
    const duPaths = [];
    const deps = tempDeps({
      loadConfig: stubConfig,
      fsx: { lstatSync: p => { if (!present.has(p)) throw new Error('ENOENT'); return {}; } },
      runCapture: async (cmd, args) => {
        if (cmd === 'du') {
          duPaths.push(args[args.length - 1]);
          return { stdout: `${kb.get(args[args.length - 1])}\t${args[args.length - 1]}\n`, error: null };
        }
        if (cmd === 'df') {
          return {
            stdout: 'Filesystem 1024-blocks Used Available Capacity iused ifree %iused Mounted on\n/dev/disk3s1 10000 6000 4000 60% 1 2 33% /System/Volumes/Data\n',
            error: null,
          };
        }
        if (cmd === 'tmutil') return { stdout: 'com.apple.TimeMachine.2026-07-18-010101.local\n', error: null };
        if (cmd === 'ps') return { stdout: '/Applications/Safari.app/Contents/MacOS/Safari\n', error: null };
        if (cmd === 'npm') return { stdout: '10.0.0\n', error: null };
        return { stdout: '', error: `spawn ${cmd} ENOENT` };
      },
    });
    const out = await callTool('storage_assess', {
      min_report_mb: 0,
      target_reclaim_gb: 0.001,
    }, deps);
    assert.equal(out.ok, true);
    assert.equal(out.volume.available_bytes, 4000 * 1024);
    assert.equal(out.local_snapshots.count, 1);
    assert.ok(out.running_apps.includes('Safari'));
    assert.equal(out.external_tools.npm.available, true);
    assert.equal(out.external_tools.docker.available, false);
    assert.ok(out.categories.some(c => c.id === 'browser_caches' && c.total_bytes === 2048 * 1024));
    assert.ok(out.scope.outside_root_catalog_paths > 0);
    assert.ok(!duPaths.includes('/Applications'), 'paths outside configured roots are never sized');
    assert.ok(out.scan_hints.some(h => h.category === 'old_installers'));
    assert.equal(out.target_plan.status, 'manual_or_out_of_pipeline_actions_required');
    assert.equal(out.target_plan.steps[0].category, 'trash', 'low-risk category planned first');
    assert.ok(out.target_plan.steps.every(step => step.requires_review));
    assert.equal(out.target_plan.steps[0].out_of_pipeline, true);
  });

  it('never sizes symlinks or paths whose real path escapes configured roots', async () => {
    const duPaths = [];
    const deps = tempDeps({
      loadConfig: stubConfig,
      fsx: {
        lstatSync: p => {
          if (p === '/home/u/.Trash') return { isSymbolicLink: () => true };
          if (p === '/home/u/Downloads') return { isSymbolicLink: () => false };
          throw new Error('ENOENT');
        },
        realpathSync: p => p === '/home/u/Downloads' ? '/outside/Downloads' : p,
      },
      runCapture: async (cmd, args) => {
        if (cmd === 'du') duPaths.push(args[args.length - 1]);
        if (cmd === 'df') return { stdout: '', error: 'unavailable' };
        if (cmd === 'ps') return { stdout: '', error: 'unavailable' };
        if (cmd === 'tmutil') return { stdout: '', error: 'unavailable' };
        return { stdout: '', error: `spawn ${cmd} ENOENT` };
      },
    });
    const out = await callTool('storage_assess', { min_report_mb: 0 }, deps);
    assert.equal(out.ok, true);
    assert.deepEqual(duPaths, []);
    assert.deepEqual(out.categories, []);
    assert.equal(out.process_check_available, false);
    assert.ok(out.warnings.some(w => /Running-app guard is unavailable/.test(w)));
    assert.ok(out.warnings.some(w => /snapshot status is unavailable/.test(w)));
  });

});

describe('removed cleaner compatibility alias', () => {
  it('returns an inert migration error for old clients', async () => {
    const out = await callTool('mole_cleanup_preview', {}, tempDeps());
    assert.deepEqual(out, {
      ok: false,
      error: 'tool_removed',
      replacement: 'maintenance_scan',
      note: 'This deprecated alias performs no command or filesystem action.',
    });
  });
});
