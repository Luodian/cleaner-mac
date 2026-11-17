#!/usr/bin/env node
// cleaner-mac (command: cmac): scan a Mac for removable caches and logs, show them, remove what is confirmed.
// No dependencies. Every rule lives in RULES below; a rule only ever deletes the paths it lists.
// The title is written before anything else runs, so the first line is on screen as soon as node starts.
import { execFile, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------- look: a 5-pixel font drawn with half blocks ----------

const TTY = process.stdout.isTTY;
const COLOR = TTY && !process.env.NO_COLOR;
const JSON_OUT = process.argv.includes('--json');
// Status lines read stdout: no title for them.
const QUIET = JSON_OUT || process.argv.includes('--line') || process.argv.includes('--herdr') || process.argv[2] === 'integration';
const PAL = {
  yellow: [255, 212, 64], pink: [255, 92, 176], violet: [164, 118, 255], green: [86, 246, 150],
  red: [255, 72, 112], silver: [198, 196, 226], slate: [112, 108, 150], white: [248, 244, 255],
};
const fg = (c) => `\x1b[38;2;${c[0]};${c[1]};${c[2]}m`;
const paint = (tone, s, bold) => (COLOR ? `${bold ? '\x1b[1m' : ''}${fg(PAL[tone])}${s}\x1b[0m` : s);
const out = (s) => fs.writeSync(1, s);

const FONT = {
  C: ['.##', '#..', '#..', '#..', '.##'], L: ['#..', '#..', '#..', '#..', '###'],
  E: ['###', '#..', '##.', '#..', '###'], A: ['.##.', '#..#', '####', '#..#', '#..#'],
  N: ['#..#', '##.#', '#.##', '#..#', '#..#'], R: ['###.', '#..#', '###.', '#.#.', '#..#'],
  M: ['#...#', '##.##', '#.#.#', '#...#', '#...#'], '-': ['...', '...', '###', '...', '...'],
};
function title(text) {
  const rows = ['', '', '', '', '', ''];
  for (const ch of text) FONT[ch].forEach((line, r) => { rows[r] += line + '.'; });
  rows[5] = '.'.repeat(rows[0].length);
  const w = rows[0].length - 1;
  const stops = [PAL.yellow, PAL.pink, PAL.violet];
  const at = (i) => {
    const f = (i / (w - 1)) * (stops.length - 1);
    const k = Math.min(Math.floor(f), stops.length - 2);
    return stops[k].map((v, j) => Math.round(v + (stops[k + 1][j] - v) * (f - k)));
  };
  let s = '\n';
  for (let r = 0; r < 6; r += 2) {
    s += ' ';
    for (let i = 0; i < w; i++) {
      const top = rows[r][i] === '#';
      const bot = rows[r + 1][i] === '#';
      const ch = top && bot ? '█' : top ? '▀' : bot ? '▄' : ' ';
      s += ch === ' ' || !COLOR ? ch : fg(at(i)) + ch;
    }
    s += (COLOR ? '\x1b[0m' : '') + '\n';
  }
  return s;
}
if (!QUIET) out(title('CLEANER-MAC'));

// ---------- helpers ----------

const HOME = os.homedir();
const DAY = 86400e3;
const CACHE_MIN_KB = 300 * 1024;
const home = (...p) => path.join(HOME, ...p);

const run = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => resolve({ ok: !err, out: stdout || '' }));
});
const runSync = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' });
const has = (cmd) => (process.env.PATH || '').split(':').some((d) => d && fs.existsSync(path.join(d, cmd)));

// Size of each path in KB, as { path: kb }. du prints what it can read even when it exits non-zero.
async function duEach(paths) {
  const sizes = {};
  const present = paths.filter((p) => fs.existsSync(p));
  if (!present.length) return sizes;
  for (const line of (await run('/usr/bin/du', ['-sk', ...present])).out.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab > 0) sizes[line.slice(tab + 1)] = Number(line.slice(0, tab));
  }
  return sizes;
}
const du = async (p) => (await duEach([p]))[p] || 0;
const children = (dir) => {
  try { return fs.readdirSync(dir).map((n) => path.join(dir, n)); } catch { return []; }
};
function freeKB() {
  const line = (runSync('/bin/df', ['-k', HOME]).stdout || '').trim().split('\n').pop() || '';
  return Number(line.split(/\s+/)[3]) || 0;
}
function fmt(kb) {
  if (kb == null) return '?';
  if (kb >= 1048576) return (kb / 1048576).toFixed(1) + ' GB';
  if (kb >= 1024) return Math.round(kb / 1024) + ' MB';
  return kb + ' KB';
}

// Nothing is deleted outright. A removed path is moved into a dated folder under HOLD, where
// `cmac undo` can put it back; `cmac purge` is the only thing that frees the space for good.
const HOLD = home('.cleaner-mac', 'removed');
function hold(p, batch) {
  const real = path.resolve(p);
  const allowed = [HOME + '/', `/private/tmp/claude-${os.userInfo().uid}/`];
  if (!allowed.some((a) => real.startsWith(a)) || real.split('/').length < 5 || real.startsWith(HOLD)) {
    throw new Error(`refusing to remove ${real}`);
  }
  if (!fs.existsSync(real)) return null;
  const to = path.join(batch, real);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(real, to);
  return { from: real, to };
}
const batches = () => children(HOLD).filter((d) => fs.existsSync(path.join(d, 'manifest.json'))).sort();

async function runningApps() {
  const list = (await run('/usr/bin/lsappinfo', ['list'])).out;
  const names = new Set();
  for (const m of list.matchAll(/bundleID="([^"]+)"/g)) names.add(m[1].toLowerCase());
  for (const m of list.matchAll(/^\s*\d+\) "([^"]+)"/gm)) names.add(m[1].toLowerCase());
  return names;
}

function oldFiles(dir, days) {
  const cutoff = Date.now() - days * DAY;
  const found = [];
  let kb = 0;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        const st = fs.statSync(p, { throwIfNoEntry: false });
        if (st && st.mtimeMs < cutoff) { found.push(p); kb += Math.ceil(st.blocks / 2); }
      }
    }
  };
  walk(dir);
  return { found, kb };
}

// ---------- rules ----------
// tier "safe": rebuilt on demand, removed by `clean`. tier "ask": shown only, never removed here.

const RULES = [
  { name: 'uv', async find() {
    const items = [];
    const dir = home('.cache/uv/git-v0/checkouts');
    const kb = await du(dir);
    if (kb >= 1024) items.push({
      id: 'uv-checkouts', tier: 'safe', kb, label: 'uv git checkouts',
      detail: 'one full copy per commit of each git dependency; uv rebuilds them from its local clone',
      note: 'the next install of a git dependency takes longer once',
      paths: children(dir),
    });
    if (has('uv')) items.push({
      id: 'uv-prune', tier: 'safe', kb: null, label: 'uv cache: unused entries',
      detail: 'runs `uv cache prune`; packages in use stay',
      note: 'cannot be undone; removed packages are downloaded again when needed',
      command: ['uv', ['cache', 'prune']],
    });
    return items;
  } },
  { name: 'npm and pnpm', async find() {
    const items = [];
    const dir = home('.npm/_cacache');
    const kb = await du(dir);
    if (kb >= 50 * 1024) items.push({
      id: 'npm-cache', tier: 'safe', kb, label: 'npm download cache',
      detail: 'downloaded again on the next install',
      note: 'installs need the network until the cache fills again',
      paths: [dir],
    });
    if (has('pnpm')) items.push({
      id: 'pnpm-prune', tier: 'safe', kb: null, label: 'pnpm store: unreferenced packages',
      detail: 'runs `pnpm store prune`',
      note: 'cannot be undone; a project that was not installed recently downloads its packages again',
      command: ['pnpm', ['store', 'prune']],
    });
    return items;
  } },
  { name: 'Homebrew', async find() {
    if (!has('brew')) return [];
    const dry = (await run('brew', ['cleanup', '-n', '-s'])).out;
    const m = dry.match(/free approximately ([\d.]+)\s*(KB|MB|GB)/i);
    if (!m) return [];
    const kb = Math.round(Number(m[1]) * { KB: 1, MB: 1024, GB: 1048576 }[m[2].toUpperCase()]);
    return [{
      id: 'brew-cleanup', tier: 'safe', kb, label: 'Homebrew: old versions and downloads',
      detail: 'runs `brew cleanup -s`; installed versions stay',
      note: 'cannot be undone; you can no longer switch back to an older version of a formula',
      command: ['brew', ['cleanup', '-s']],
    }];
  } },
  { name: 'app caches', async find() {
    const [running, sizes] = await Promise.all([runningApps(), duEach(children(home('Library/Caches')))]);
    return Object.entries(sizes).filter(([p, kb]) => kb >= CACHE_MIN_KB && path.basename(p) !== 'lima').map(([p, kb]) => {
      const name = path.basename(p);
      const busy = running.has(name.toLowerCase());
      return {
        id: 'cache:' + name, kb, label: `App cache: ${name}`,
        tier: busy ? 'ask' : 'safe',
        detail: busy ? 'the app is running; quit it first, then scan again' : 'the app is not running; it rebuilds this cache',
        note: busy ? 'removing the cache of a running app can corrupt it' : 'the app starts slower once; a pending update downloads again',
        paths: busy ? undefined : [p],
      };
    });
  } },
  { name: 'old logs', async find() {
    const { found, kb } = oldFiles(home('Library/Logs'), 30);
    return kb < 1024 ? [] : [{
      id: 'old-logs', tier: 'safe', kb, label: `Logs older than 30 days (${found.length} files)`,
      detail: '~/Library/Logs, including old crash reports',
      note: 'keep them if you are still chasing a crash from more than a month ago',
      paths: found,
    }];
  } },
  { name: 'Claude temp folders', async find() {
    const root = `/private/tmp/claude-${os.userInfo().uid}`;
    const cutoff = Date.now() - 7 * DAY;
    const old = children(root).filter((p) => {
      const st = fs.statSync(p, { throwIfNoEntry: false });
      return st && st.mtimeMs < cutoff;
    });
    const kb = Object.values(await duEach(old)).reduce((a, b) => a + b, 0);
    return kb < 1024 ? [] : [{
      id: 'claude-tmp', tier: 'safe', kb, label: `Claude session temp folders older than 7 days (${old.length})`,
      detail: root,
      note: 'scratch files of finished Claude sessions; a session resumed after a week loses its temp files',
      paths: old,
    }];
  } },
  { name: 'large personal data', async find() {
    const targets = [
      ['.cache/huggingface', 'Hugging Face models and datasets', 'downloaded again when a script needs them'],
      ['Downloads', 'Downloads folder', 'your files; review by hand'],
      ['.Trash', 'Trash', 'empty it from Finder'],
      ['Library/Caches/lima', 'Lima virtual machine images', 'downloaded again when a VM is created'],
      ['.cache/codex-runtimes', 'Codex runtimes', 'downloaded again by Codex'],
    ];
    const sizes = await duEach(targets.map(([p]) => home(p)));
    return targets.filter(([p]) => (sizes[home(p)] || 0) >= 500 * 1024).map(([p, label, detail]) => ({
      id: 'review:' + p, tier: 'ask', kb: sizes[home(p)], label, detail: `~/${p}: ${detail}`,
      note: 'cmac never touches this; decide by hand',
    }));
  } },
];

// ---------- scan, with one live line per rule ----------

const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
async function scan({ live }) {
  const state = RULES.map((r) => ({ name: r.name, done: false, kb: 0, n: 0 }));
  let frame = 0;
  const line = (s) => (s.done
    ? `  ${paint('green', '✓')} ${paint('silver', s.name.padEnd(22))}${paint('slate', !s.n ? 'nothing to remove' : s.kb ? fmt(s.kb) : 'size unknown until removed')}`
    : `  ${paint('pink', SPIN[frame % SPIN.length])} ${paint('silver', s.name)}`);
  const draw = (first) => out((first ? '' : `\x1b[${state.length}A`) + state.map((s) => `\r\x1b[2K${line(s)}\n`).join(''));
  const showCursor = () => out('\x1b[?25h');
  let timer;
  if (live) {
    out('\x1b[?25l');
    process.once('exit', showCursor);
    process.once('SIGINT', () => process.exit(130));
    draw(true);
    timer = setInterval(() => { frame++; draw(); }, 80);
  }
  const results = await Promise.all(RULES.map(async (rule, i) => {
    let items = [];
    try { items = await rule.find(); } catch (e) { state[i].name += ` (failed: ${e.message})`; }
    Object.assign(state[i], { done: true, n: items.length, kb: items.reduce((a, it) => a + (it.kb || 0), 0) });
    return items;
  }));
  if (live) {
    clearInterval(timer);
    out(`\x1b[${state.length}A\x1b[J`);
    showCursor();
  }
  const order = { safe: 0, ask: 1 };
  return results.flat().sort((a, b) => order[a.tier] - order[b.tier] || (b.kb ?? -1) - (a.kb ?? -1));
}

function printTable(items) {
  const sum = (tier) => items.filter((i) => i.tier === tier).reduce((a, i) => a + (i.kb || 0), 0);
  for (const [tier, tone, head] of [['safe', 'green', 'Can be removed now'], ['ask', 'yellow', 'Large, needs your decision']]) {
    const rows = items.filter((i) => i.tier === tier);
    if (!rows.length) continue;
    out(`  ${paint(tone, `${head}  ${fmt(sum(tier))}`, true)}${paint('slate', tier === 'safe' ? '  rebuilt on demand' : '  never removed by cmac')}\n`);
    for (const i of rows) {
      const tag = tier !== 'safe' ? '' : i.paths ? paint('green', '  can be undone') : paint('red', '  cannot be undone');
      out(`  ${paint('white', fmt(i.kb).padStart(8), true)}  ${paint('silver', i.label)}  ${paint('slate', i.id)}${tag}\n`);
      out(`            ${paint('slate', i.detail)}\n`);
      if (i.note) out(`            ${paint('yellow', '! ' + i.note)}\n`);
    }
    out('\n');
  }
  const held = batches();
  if (held.length) out(`  ${paint('slate', `${held.length} earlier removal(s) are still held in ${HOLD}: \`cmac undo\` restores the latest, \`cmac purge\` frees the space`)}\n\n`);
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function writeReport(items, free) {
  const max = Math.max(1, ...items.map((i) => i.kb || 0));
  const section = (tier, head) => {
    const rows = items.filter((i) => i.tier === tier);
    if (!rows.length) return '';
    const total = rows.reduce((a, i) => a + (i.kb || 0), 0);
    return `<h2>${head} <span>${fmt(total)}</span></h2>` + rows.map((i) => `
      <div class="row ${tier}"><div class="size">${fmt(i.kb)}</div><div class="what"><b>${esc(i.label)}</b>
      <div class="bar"><i style="width:${(100 * (i.kb || 0)) / max}%"></i></div>
      <p>${esc(i.detail)}</p><code>${esc(i.id)}</code></div></div>`).join('');
  };
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>cleaner-mac report</title><style>
:root{--bg:#0c0b1c;--fg:#f8f4ff;--dim:#8c80c4;--line:#3a3468;--safe:#56f696;--ask:#ffd440;--a:#ffd440;--b:#ff5cb0;--c:#a476ff}
@media (prefers-color-scheme:light){:root{--bg:#fbfaf7;--fg:#1c1b19;--dim:#6b6860;--line:#e4e1d8;--safe:#2f7d4f;--ask:#b26a00;--a:#c98a00;--b:#d6337f;--c:#6f3fe0}}
body{margin:0;padding:32px 16px;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,system-ui,sans-serif}
main{margin:0 auto;padding:0 16px}h1{font:700 30px/1.1 ui-monospace,Menlo,monospace;letter-spacing:.12em;margin:0 0 6px;background:linear-gradient(90deg,var(--a),var(--b),var(--c));-webkit-background-clip:text;background-clip:text;color:transparent;display:inline-block}
h2{font-size:17px;margin:32px 0 8px;display:flex;justify-content:space-between;border-bottom:1px solid var(--line);padding-bottom:6px}
h2 span,.lead{color:var(--dim);font-weight:400}.row{display:flex;gap:16px;padding:12px 0;border-bottom:1px solid var(--line)}
.size{flex:0 0 84px;text-align:right;font-variant-numeric:tabular-nums;font-weight:600}.what{flex:1;min-width:0}
.bar{height:6px;background:var(--line);border-radius:3px;margin:6px 0}.bar i{display:block;height:100%;border-radius:3px}
.safe .bar i{background:var(--safe)}.ask .bar i{background:var(--ask)}p{margin:0;color:var(--dim)}code{font-size:12px;color:var(--dim)}
</style><main><h1>CLEANER-MAC</h1><p class="lead">${new Date().toLocaleString()} · free disk space ${fmt(free)}</p>
${section('safe', 'Can be removed now')}${section('ask', 'Large, needs your decision')}
<p class="lead" style="margin-top:32px">Remove the first group with <code>cmac clean</code>. The second group is only listed.</p></main>`;
  const file = path.join(os.tmpdir(), 'cleaner-mac-report.html');
  fs.writeFileSync(file, html);
  return file;
}

function notify(text) {
  runSync('/usr/bin/osascript', ['-e', `display notification ${JSON.stringify(text)} with title "cleaner-mac"`]);
}

// One keypress, no Enter. Tab is the main button everywhere: it takes the highlighted action.
function key() {
  return new Promise((resolve) => {
    const input = process.stdin;
    input.setRawMode(true);
    input.resume();
    input.once('data', (d) => {
      input.setRawMode(false);
      input.pause();
      const k = d.toString();
      if (k === '\x03') { out('\n'); process.exit(130); }
      resolve(k === '\t' ? 'tab' : k === '\r' || k === '\n' ? 'enter' : k === '\x1b' ? 'esc' : k.toLowerCase());
    });
  });
}
const keycap = (k) => (COLOR ? `\x1b[1m\x1b[48;2;255;212;64m\x1b[38;2;12;11;28m ${k} \x1b[0m` : `[${k}]`);
const choice = (k, text) => `${paint('yellow', k, true)} ${paint('slate', text)}`;

// Keep a one-off `claude -p` call away from the user's own setup: no connected tools (MCP servers),
// no personal instructions or settings, no skills, nothing saved.
const ALONE = ['--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '', '--disable-slash-commands', '--no-session-persistence'];

// The lightest model each CLI offers reads the list and says what to watch for. It gets no tools.
const LIGHT = {
  claude: (prompt) => ['claude', ['-p', '--model', process.env.CMAC_MODEL || 'haiku', ...ALONE, '--tools', '',
    '--system-prompt', prompt, 'Review the list on stdin.']],
  codex: (prompt, file) => ['codex', ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '-c', 'model_reasoning_effort="low"',
    ...(process.env.CMAC_MODEL ? ['-m', process.env.CMAC_MODEL] : []), '-o', file, prompt]],
};
function reviewer(agent) {
  const name = agent || Object.keys(LIGHT).find(has);
  if (!name) throw new Error('cleaning needs a model to review the list first, and neither `claude` nor `codex` is on PATH. Install one, or pass --no-analysis to remove without the review.');
  if (!LIGHT[name] || !has(name)) throw new Error(`\`${name}\` is not available; use --agent claude or --agent codex`);
  return name;
}
function review(todo, agent) {
  const name = reviewer(agent);
  const lang = ((runSync('/usr/bin/defaults', ['read', '-g', 'AppleLanguages']).stdout || '').match(/"([^"]+)"/) || [])[1] || 'en';
  const prompt = [
    'You are the reviewer inside a disk cleanup tool called cmac. The tool, not you, will remove the items after its user agrees; you cannot run anything and nobody is asking you to.',
    'The JSON on stdin is the list cmac is about to remove from this Mac. Write the short review the user reads before pressing the key that agrees.',
    'Items with "undo": true are moved to a holding folder and can be restored with `cmac undo`; items with "undo": false run a command that cannot be undone.',
    `Write in the language "${lang}". Plain text only: no Markdown, no headings, no questions, no offers of further help. At most 10 short lines, in this order:`,
    '1. one line with the verdict: fine to remove everything, or which ids to leave out and why;',
    '2. one line per item that deserves care, starting with its id: what gets slower or stops working, and for how long. Leave harmless items out;',
    '3. one last line listing the ids that cannot be undone, or saying that everything can be undone.',
    'Judge only from the JSON. Do not invent facts about files you cannot see.',
  ].join('\n');
  const input = JSON.stringify(todo.map((i) => ({ id: i.id, label: i.label, size: fmt(i.kb), undo: !!i.paths, detail: i.detail, note: i.note })));
  const file = path.join(os.tmpdir(), `cmac-analysis-${process.pid}.txt`);
  const [cmd, args] = LIGHT[name](prompt, file);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let o = '';
    let e = '';
    child.stdout.on('data', (d) => { o += d; });
    child.stderr.on('data', (d) => { e += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      let text = o.trim();
      if (name === 'codex') { try { text = fs.readFileSync(file, 'utf8').trim(); fs.rmSync(file, { force: true }); } catch { text = ''; } }
      if (code !== 0 || !text) reject(new Error(`${name} did not return a review (exit ${code}): ${e.trim().split('\n').pop() || 'no output'}`));
      else resolve(text);
    });
    child.stdin.end(input);
  });
}
async function analyse(todo, agent) {
  const say = JSON_OUT ? (t) => fs.writeSync(2, t) : out;
  say(`  ${paint('pink', `${reviewer(agent)} is reviewing ${todo.length} item(s)...`)}\n`);
  let text;
  try { text = await review(todo, agent); } catch (e) { throw new Error(`${e.message}. Fix that, or pass --no-analysis.`); }
  say('\n' + text.split('\n').map((l) => `  ${paint('silver', l)}`).join('\n') + '\n\n');
}

// Move paths to a new holding batch, or run the command of an item that has no paths.
function apply(todo, say = () => {}) {
  const batch = path.join(HOLD, new Date().toISOString().replace(/[:.]/g, '-'));
  const moved = [];
  const done = [];
  const failed = [];
  for (const i of todo) {
    try {
      if (i.paths) {
        for (const p of i.paths) { const m = hold(p, batch); if (m) moved.push({ id: i.id, ...m }); }
        say(`  ${paint('green', '✓')} ${i.label}  ${paint('slate', `moved out, ${fmt(i.kb)}`)}\n`);
      } else {
        const r = runSync(i.command[0], i.command[1]);
        if (r.status !== 0) throw new Error((r.stderr || '').trim().split('\n').pop() || `exit ${r.status}`);
        say(`  ${paint('green', '✓')} ${i.label}  ${paint('slate', 'done')}\n`);
      }
      done.push({ id: i.id, label: i.label, undo: !!i.paths, kb: i.kb });
    } catch (e) { failed.push({ label: i.label, error: e.message }); say(`  ${paint('red', 'failed')} ${i.label}: ${e.message}\n`); }
  }
  if (moved.length) fs.writeFileSync(path.join(batch, 'manifest.json'), JSON.stringify({ at: new Date().toISOString(), moved }, null, 1));
  return { done, moved, failed, batch: moved.length ? batch : null };
}

async function clean(items, opts) {
  let todo = items.filter((i) => i.tier === 'safe' && (i.paths || i.command));
  if (opts.only) {
    const unknown = opts.only.filter((id) => !todo.some((i) => i.id === id));
    if (unknown.length) throw new Error(`not removable or not found: ${unknown.join(', ')}`);
    todo = todo.filter((i) => opts.only.includes(i.id));
  }
  if (!todo.length) { out('  Nothing to remove.\n'); return; }
  if (!opts.yes && !process.stdin.isTTY) throw new Error('not a terminal: pass --yes (optionally with --only <ids>) to remove without questions');

  // 1. a model reviews the list; 2. the owner agrees; 3. only then anything moves.
  if (!opts.noAnalysis) await analyse(todo, opts.agent);
  const say = opts.json ? () => {} : out;
  if (!opts.yes) {
    const total = fmt(todo.reduce((a, i) => a + (i.kb || 0), 0));
    const fixed = todo.filter((i) => !i.paths).length;
    out(`  ${paint('slate', `${todo.length - fixed} item(s) can be undone with \`cmac undo\`${fixed ? `, ${fixed} cannot` : ''}`)}\n`);
    out(`  ${keycap('tab')} ${paint('white', `remove all ${todo.length} (${total})`, true)}   ${choice('c', 'choose one by one')}   ${choice('q', 'cancel')} `);
    const k = await key();
    out('\r\x1b[2K');
    if (k === 'c') {
      const picked = [];
      for (const i of todo) {
        out(`  ${paint('white', fmt(i.kb).padStart(8), true)}  ${paint('silver', i.label)}  ${i.paths ? '' : paint('red', 'cannot be undone  ')} ${keycap('tab')} ${paint('white', 'remove', true)}   ${choice('s', 'keep')}   ${choice('q', 'stop')} `);
        const c = await key();
        out('\r\x1b[2K');
        if (c === 'q' || c === 'esc') break;
        if (c === 'tab') picked.push(i);
        else out(`  ${paint('slate', `·  ${i.label}  kept`)}\n`);
      }
      todo = picked;
    } else if (k !== 'tab') { out(`  ${paint('slate', 'Cancelled. Nothing was removed.')}\n`); return; }
    if (!todo.length) { out(`  ${paint('slate', 'Nothing was removed.')}\n`); return; }
  }

  const before = freeKB();
  const { done, moved, batch } = apply(todo, say);
  const after = freeKB();
  const heldKB = done.filter((d) => d.undo).reduce((a, d) => a + (d.kb || 0), 0);
  const summary = `${done.length} item(s) removed. ${fmt(heldKB)} is held for undo; freed now: ${fmt(Math.max(0, after - before))}.`;
  if (opts.json) out(JSON.stringify({ before_kb: before, after_kb: after, held_kb: heldKB, hold: batch, removed: done }) + '\n');
  else {
    out(`\n  ${paint('green', summary, true)}\n`);
    if (moved.length) out(`  ${paint('slate', '`cmac undo` puts everything back. `cmac purge` frees the held space for good.')}\n`);
  }
  if (done.length) notify(summary);
}

// Put the latest removal back where it was. Returns what happened, as lines of [tone, text].
function undoLatest() {
  const latest = batches().pop();
  if (!latest) return [['slate', 'Nothing to undo.']];
  const { moved } = JSON.parse(fs.readFileSync(path.join(latest, 'manifest.json'), 'utf8'));
  let back = 0;
  const kept = [];
  for (const m of moved) {
    if (!fs.existsSync(m.to)) continue;
    if (fs.existsSync(m.from)) { kept.push(m); continue; }
    fs.mkdirSync(path.dirname(m.from), { recursive: true });
    fs.renameSync(m.to, m.from);
    back++;
  }
  const lines = [];
  if (kept.length) {
    fs.writeFileSync(path.join(latest, 'manifest.json'), JSON.stringify({ moved: kept }, null, 1));
    lines.push(['yellow', `${kept.length} path(s) were not restored because something new is in their place; they stay in ${latest}`]);
  } else fs.rmSync(latest, { recursive: true, force: true });
  lines.push(['green', `Restored ${back} path(s) from the removal of ${path.basename(latest)}.`]);
  return lines;
}
const undo = () => undoLatest().forEach(([tone, text]) => out(`  ${paint(tone, text, tone === 'green')}\n`));

// Delete what is held. This is the only permanent step in the tool.
async function purge(yes) {
  const held = batches();
  if (!held.length) { out('  Nothing is held.\n'); return; }
  const kb = await du(HOLD);
  if (!yes) {
    if (!process.stdin.isTTY) throw new Error('not a terminal: pass --yes to purge without the question');
    out(`  ${paint('red', `This permanently deletes ${fmt(kb)} from ${held.length} removal(s); \`cmac undo\` will no longer work for them.`)}\n`);
    out(`  ${keycap('tab')} ${paint('white', 'delete for good', true)}   ${choice('q', 'cancel')} `);
    const k = await key();
    out('\r\x1b[2K');
    if (k !== 'tab') { out(`  ${paint('slate', 'Cancelled.')}\n`); return; }
  }
  const before = freeKB();
  fs.rmSync(HOLD, { recursive: true, force: true });
  out(`  ${paint('green', `Purged. Freed ${fmt(Math.max(0, freeKB() - before))}.`, true)}\n`);
}

// ---------- stats: what a menu-bar monitor shows, for a prompt or a status line ----------

const CACHE_DIR = path.join(process.env.XDG_CACHE_HOME || home('.cache'), 'cleaner-mac');
function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) { for (const k in c.times) total += c.times[k]; idle += c.times.idle; }
  return { idle, total };
}
// Bytes in and out over the physical interfaces (en*), from their link-level rows.
function netBytes() {
  let rx = 0;
  let tx = 0;
  for (const l of (runSync('/usr/sbin/netstat', ['-ibn']).stdout || '').split('\n')) {
    const f = l.trim().split(/\s+/);
    if (!/^en\d/.test(f[0]) || !/^<Link/.test(f[2]) || f.length < 11) continue;
    rx += Number(f[6]) || 0;
    tx += Number(f[9]) || 0;
  }
  return { rx, tx };
}
// Used memory the way Activity Monitor counts it: app memory + wired + compressed.
function memory() {
  const o = runSync('/usr/bin/vm_stat').stdout || '';
  const page = Number((o.match(/page size of (\d+)/) || [])[1]) || 16384;
  const n = (k) => Number((o.match(new RegExp(k + ':\\s+(\\d+)')) || [])[1]) || 0;
  const used = (n('Anonymous pages') - n('Pages purgeable') + n('Pages wired down') + n('Pages occupied by compressor')) * page;
  return { used_kb: Math.round(used / 1024), total_kb: Math.round(os.totalmem() / 1024), pct: Math.round((100 * used) / os.totalmem()) };
}
// CPU and network are rates, so they need two samples. The previous call's sample is kept in the
// cache folder; without a usable one (first call, or older than a minute) this waits 250 ms for a second.
function stats(full) {
  const take = () => ({ t: Date.now(), cpu: cpuTimes(), net: netBytes() });
  const file = path.join(CACHE_DIR, 'sample.json');
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first call */ }
  const age = prev ? Date.now() - prev.t : Infinity;
  if (age < 400 || age > 60000) {
    prev = take();
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  const now = take();
  fs.writeFileSync(file, JSON.stringify(now));
  const dt = (now.t - prev.t) / 1000;
  const dTotal = now.cpu.total - prev.cpu.total;
  const disk = fs.statfsSync(HOME);
  const s = {
    cpu_pct: dTotal > 0 ? Math.round(100 * (1 - (now.cpu.idle - prev.cpu.idle) / dTotal)) : 0,
    cores: os.cpus().length,
    load: Number(os.loadavg()[0].toFixed(2)),
    mem: memory(),
    disk_free_kb: Math.round((disk.bavail * disk.bsize) / 1024),
    disk_total_kb: Math.round((disk.blocks * disk.bsize) / 1024),
    net_down_bps: Math.max(0, Math.round((now.net.rx - prev.net.rx) / dt)),
    net_up_bps: Math.max(0, Math.round((now.net.tx - prev.net.tx) / dt)),
  };
  if (full) {
    const swap = (runSync('/usr/sbin/sysctl', ['-n', 'vm.swapusage']).stdout || '').match(/used = ([\d.]+)M/);
    s.swap_used_kb = swap ? Math.round(Number(swap[1]) * 1024) : 0;
    const batt = (runSync('/usr/bin/pmset', ['-g', 'batt']).stdout || '').match(/(\d+)%; ([^;]+);/);
    if (batt) s.battery = { pct: Number(batt[1]), state: batt[2].trim() };
    s.top = (runSync('/bin/ps', ['-Aceo', 'pcpu,rss,comm', '-r']).stdout || '').split('\n').slice(1, 6).map((l) => {
      const m = l.trim().match(/^([\d.]+)\s+(\d+)\s+(.+)$/);
      return m && { cpu_pct: Number(m[1]), rss_kb: Number(m[2]), name: m[3] };
    }).filter(Boolean);
  }
  return s;
}
const rate = (bps) => (bps >= 1048576 ? (bps / 1048576).toFixed(1) + 'M' : bps >= 1024 ? Math.round(bps / 1024) + 'K' : bps + 'B') + '/s';
const short = (kb) => fmt(kb).replace(' ', '').replace('B', '');
const statsLine = (s) => `cpu ${s.cpu_pct}% · mem ${s.mem.pct}% · disk ${short(s.disk_free_kb)} free · ↓${rate(s.net_down_bps)} ↑${rate(s.net_up_bps)}`;
function statsPanel(s) {
  const bar = (pct) => {
    const w = 24;
    const on = Math.max(0, Math.min(w, Math.round((pct / 100) * w)));
    return paint(pct >= 85 ? 'red' : pct >= 60 ? 'yellow' : 'green', '█'.repeat(on)) + paint('slate', '░'.repeat(w - on));
  };
  const row = (name, pct, text) => `  ${paint('silver', name.padEnd(8))}${bar(pct)}  ${paint('white', `${pct}%`.padStart(4), true)}  ${paint('slate', text)}`;
  const diskPct = Math.round(100 * (1 - s.disk_free_kb / s.disk_total_kb));
  const lines = [
    row('cpu', s.cpu_pct, `load ${s.load} on ${s.cores} cores`),
    row('memory', s.mem.pct, `${fmt(s.mem.used_kb)} of ${fmt(s.mem.total_kb)}, swap ${fmt(s.swap_used_kb)}`),
    row('disk', diskPct, `${fmt(s.disk_free_kb)} free of ${fmt(s.disk_total_kb)}`),
    `  ${paint('silver', 'network'.padEnd(8))}${paint('white', `↓ ${rate(s.net_down_bps)}`.padEnd(14), true)}${paint('white', `↑ ${rate(s.net_up_bps)}`, true)}`,
  ];
  if (s.battery) lines.push(row('battery', s.battery.pct, s.battery.state));
  lines.push('', `  ${paint('slate', 'busiest processes')}`);
  for (const p of s.top) lines.push(`  ${paint('white', `${p.cpu_pct.toFixed(1)}%`.padStart(7), true)}  ${paint('silver', p.name.slice(0, 28).padEnd(28))}  ${paint('slate', fmt(p.rss_kb))}`);
  return lines;
}
// herdr shows a workspace token in its sidebar: add { token = "cmac" } to a row in config.toml.
function reportHerdr(line) {
  if (!has('herdr')) throw new Error('`herdr` is not on PATH');
  const list = JSON.parse(runSync('herdr', ['workspace', 'list']).stdout || '{}');
  const spaces = list.result?.workspaces || [];
  if (!spaces.length) throw new Error('herdr reported no workspaces; is its server running?');
  for (const w of spaces) {
    const r = runSync('herdr', ['workspace', 'report-metadata', '--source', 'cmac', '--token', `cmac=${line}`, '--ttl-ms', '30000', w.workspace_id]);
    if (r.status !== 0) throw new Error(`herdr refused the report: ${(r.stderr || r.stdout || '').trim()}`);
  }
}
async function statsCommand(argv) {
  const flag = (f) => argv.includes(f);
  const at = argv.indexOf('--watch');
  const every = at >= 0 ? Math.max(1, Number(argv[at + 1]) || 2) : 0;
  const plain = JSON_OUT || flag('--line') || flag('--herdr');
  const once = () => {
    const s = stats(!plain || JSON_OUT);
    const line = statsLine(s);
    fs.writeFileSync(path.join(CACHE_DIR, 'line'), line + '\n');
    if (flag('--herdr')) reportHerdr(line);
    else if (JSON_OUT) out(JSON.stringify(s) + '\n');
    else if (flag('--line')) out(line + '\n');
    return s;
  };
  if (plain) {
    once();
    if (every) setInterval(once, every * 1000);
    return;
  }
  let lines = statsPanel(once());
  out(lines.join('\n') + '\n');
  if (!every || !TTY) return;
  out('\x1b[?25l');
  process.once('exit', () => out('\x1b[?25h'));
  process.once('SIGINT', () => process.exit(0));
  setInterval(() => {
    const before = lines.length;
    lines = statsPanel(once());
    out(`\x1b[${before}A` + lines.map((l) => `\x1b[2K${l}\n`).join('') + '\x1b[J');
  }, every * 1000);
}

// Where the snippets for a shell prompt or an editor status line live.
function integration(name) {
  const dir = path.resolve(path.dirname(fs.realpathSync(process.argv[1])), '..', 'integrations');
  const files = { zsh: 'cmac.zsh', nvim: 'cmac.lua', tmux: 'tmux.conf', herdr: 'herdr.md' };
  if (!files[name]) throw new Error(`choose one of: ${Object.keys(files).join(', ')}`);
  out(fs.readFileSync(path.join(dir, files[name]), 'utf8'));
}

// The agent only reads the scan and advises; removal stays in `cmac clean`.
const AGENTS = {
  claude: (prompt) => ['claude', ['-p', ...ALONE, '--tools', 'Read,Glob,Grep,Bash(du *),Bash(ls *)', prompt]],
  codex: (prompt) => ['codex', ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', prompt]],
};
function ask(items, free, agent) {
  const name = agent || Object.keys(AGENTS).find(has);
  if (!name) throw new Error('neither `claude` nor `codex` is on PATH; install one or run `cmac scan`');
  if (!AGENTS[name]) throw new Error(`unknown agent "${name}"; use claude or codex`);
  if (!has(name)) throw new Error(`\`${name}\` is not on PATH`);
  const prompt = [
    'You are advising the owner of this Mac on disk cleanup. The JSON on stdin is the output of `cmac scan`.',
    'tier "safe" items are rebuilt on demand and can be removed with `cmac clean --yes --only <ids>`.',
    'tier "ask" items are personal or expensive to rebuild; cmac never removes them.',
    'You may read files to judge an item (for example list the largest entries of a folder). Do not delete or change anything.',
    'Answer in the language of the user\'s system locale, briefly:',
    '1. Which safe ids to remove now, as one ready-to-run `cmac clean --yes --only ...` command, and what each costs to rebuild.',
    '2. For each "ask" item, what is inside (largest entries) and a keep/remove recommendation with the reason.',
    '3. Anything in the list that looks unusual for its size.',
  ].join('\n');
  const [cmd, args] = AGENTS[name](prompt);
  out(`  ${paint('pink', `Asking ${name}...`)}\n\n`);
  const input = JSON.stringify({ free_kb: free, items: items.map(({ paths, command, ...i }) => ({ ...i, undo: i.tier === 'safe' ? !!paths : undefined })) });
  const r = spawnSync(cmd, args, { input, stdio: ['pipe', 'inherit', 'inherit'] });
  if (r.status !== 0) throw new Error(`${name} exited with ${r.status ?? r.signal}`);
}

// Claude Code reads ~/.claude/skills, Codex reads ~/.agents/skills.
function installSkill() {
  const src = path.resolve(path.dirname(fs.realpathSync(process.argv[1])), '..', 'skill');
  for (const dir of [home('.claude/skills'), home('.agents/skills')]) {
    const dest = path.join(dir, 'mac-cleanup');
    fs.mkdirSync(dir, { recursive: true });
    const st = fs.lstatSync(dest, { throwIfNoEntry: false });
    let target = null;
    try { target = fs.realpathSync(dest); } catch { /* missing, or a link to nothing */ }
    if (target === src) { out(`  already linked: ${dest}\n`); continue; }
    if (st && !st.isSymbolicLink()) throw new Error(`${dest} exists and is not a link; move it away first`);
    if (st) fs.unlinkSync(dest);
    fs.symlinkSync(src, dest);
    out(`  linked ${dest} -> ${src}\n`);
  }
}

const HELP = `  cmac                     the full-screen view: a map of disk, memory, CPU and GPU use
      --demo               the same view on invented data; nothing is read or removed
  cmac scan                list what can be removed, with sizes
      --open               also open a report page in the browser
      --json               print the list as JSON (no title, for scripts and agents)
  cmac clean               a model reviews the removable group, then tab removes it
      --only <id,id>       only these ids (ids are shown by scan)
      --agent <name>       reviewer: claude or codex, each on its lightest setting
      --yes                do not ask (for scripts; the review still runs and is printed)
      --no-analysis        skip the model review
      --json               print what was removed as JSON
  cmac undo                put the latest removal back where it was
  cmac purge               delete what is held for undo; the only permanent step
  cmac ask                 scan, then have Claude or Codex explain the list and recommend
      --agent <name>       claude or codex (default: the first one found on PATH)
  cmac install-skill       link the mac-cleanup skill for Claude Code and Codex
  cmac stats               CPU, memory, disk, network, battery and the busiest processes
      --watch [seconds]    keep refreshing in place (default every 2 s)
      --line               one plain line, for a prompt or a status line
      --json               the numbers as JSON
      --herdr              send the line to herdr's sidebar (token "cmac")
  cmac integration <name>  print the setup snippet for zsh, nvim, tmux or herdr

  Removed files are moved to ~/.cleaner-mac/removed, not deleted, until you purge.
  Large personal data is listed, never removed.
`;

async function main() {
  const argv = process.argv.slice(2);
  const given = argv[0] && !argv[0].startsWith('-') ? argv.shift() : null;
  const cmd = given || 'scan';
  const flag = (f) => argv.includes(f);
  if (flag('--help') || flag('-h') || cmd === 'help') return out(HELP);
  if (process.platform !== 'darwin') throw new Error('cleaner-mac runs on macOS only');
  if (cmd === 'install-skill') return installSkill();
  if (cmd === 'stats') return statsCommand(argv);
  if (cmd === 'undo') return undo();
  if (cmd === 'ui' || (!given && (!argv.length || flag('--demo')) && TTY && process.stdin.isTTY)) {
    const { tui } = await import('./tui.js');
    return tui({ HOME, HOLD, home, fmt, run, runSync, has, children, scan, review, reviewer, apply, undoLatest, batches, stats, title: FONT, demo: flag('--demo') });
  }
  if (cmd === 'purge') return purge(flag('--yes'));
  if (cmd === 'integration') return integration(argv[0]);
  if (!['scan', 'clean', 'ask'].includes(cmd)) throw new Error(`unknown command "${cmd}"\n\n${HELP}`);
  const onlyAt = argv.indexOf('--only');
  const only = onlyAt >= 0 ? (argv[onlyAt + 1] || '').split(',').filter(Boolean) : null;
  if (onlyAt >= 0 && !only.length) throw new Error('--only needs a comma-separated list of ids');

  const free = freeKB();
  if (!JSON_OUT) out(`  ${paint('slate', 'free disk space')} ${paint('white', fmt(free), true)}\n\n`);
  const items = await scan({ live: TTY && !JSON_OUT });
  const plain = items.map(({ paths, command, ...i }) => ({ ...i, undo: i.tier === 'safe' ? !!paths : undefined }));

  if (cmd === 'ask') {
    const at = argv.indexOf('--agent');
    return ask(items, free, at >= 0 ? argv[at + 1] : null);
  }
  if (cmd === 'clean') {
    if (!JSON_OUT) printTable(items);
    const at = argv.indexOf('--agent');
    return clean(items, { yes: flag('--yes'), only, json: JSON_OUT, noAnalysis: flag('--no-analysis'), agent: at >= 0 ? argv[at + 1] : null });
  }
  if (JSON_OUT) out(JSON.stringify({ free_kb: free, items: plain }, null, 2) + '\n');
  else printTable(items);
  const report = () => { const f = writeReport(items, free); runSync('/usr/bin/open', [f]); out(`  Report: ${f}\n`); };
  if (flag('--open')) report();
  if (given || JSON_OUT || !TTY || !process.stdin.isTTY) return;

  // Bare `cmac` in a terminal: one line of choices after the list. Tab takes the main one.
  const agent = Object.keys(AGENTS).find(has);
  const safe = items.filter((i) => i.tier === 'safe' && (i.paths || i.command));
  const main = safe.length ? `review and clean ${fmt(safe.reduce((a, i) => a + (i.kb || 0), 0))}` : 'stats';
  out(`  ${keycap('tab')} ${paint('white', main, true)}   ${agent ? choice('a', `ask ${agent}`) + '   ' : ''}${safe.length ? choice('s', 'stats') + '   ' : ''}${choice('o', 'report')}   ${choice('q', 'quit')} `);
  const k = await key();
  out('\r\x1b[2K');
  if (k === 'tab' && safe.length) return clean(items, { yes: false, only: null, json: false, noAnalysis: false, agent: null });
  if (k === 's' || k === 'tab') return statsCommand(['--watch']);
  if (k === 'a' && agent) return ask(items, free, agent);
  if (k === 'o') report();
}

main().catch((e) => { fs.writeSync(2, `  ${paint('red', 'cmac:')} ${e.message}\n`); process.exit(1); });
