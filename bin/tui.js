// The full-screen view of cleaner-mac. It opens on a Home page of options; the other tabs each draw
// one resource as a treemap, where a cell's area is its share. Enter or a second click opens a cell
// into its parts; Tab acts on the selected cell (disk: review, then move to the holding folder;
// memory and CPU: quit). Backspace, right click or the back button go up.
//
// Scanning is kept cheap:
// - a folder's sizes are cached (~/.cache/cleaner-mac/disk.json) and shown at once on the next visit;
// - nothing is measured again until the cache is six hours old or you press r;
// - a refresh of cached sizes runs `du` at background priority (taskpolicy -b), so it yields CPU and
//   disk to everything else; only a folder seen for the first time is measured at normal priority;
// - at most four `du` run at a time, one per entry, so cells appear as their own sizes come in;
// - the list of removable items (the slow part is Homebrew's dry run) is cached the same way.
//
// No dependencies. Everything that touches files goes through the functions cmac.js passes in.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const TABS = ['Home', 'Disk', 'Memory', 'CPU', 'GPU'];
const [T_HOME, T_DISK, T_MEM, T_CPU, T_GPU] = [0, 1, 2, 3, 4];
const TTL = 6 * 3600e3;
const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
const C = {
  bg: [12, 11, 28], panel: [24, 18, 52], lift: [44, 38, 92], line: [58, 52, 104], white: [248, 244, 255], silver: [198, 196, 226],
  slate: [112, 108, 150], yellow: [255, 212, 64], pink: [255, 92, 176], violet: [164, 118, 255],
  green: [86, 246, 150], red: [255, 72, 112], ink: [12, 11, 28],
};
const TONES = [[58, 52, 104], [40, 54, 110], [92, 44, 118], [30, 78, 122], [70, 48, 132], [36, 92, 110], [104, 52, 96], [48, 44, 92]];
const TAG = { safe: [18, 128, 96], ask: [150, 104, 16], held: [70, 70, 84] };
// Top-level folders that are opened, never removed whole.
const PROTECTED = new Set(['Library', 'Documents', 'Desktop', 'Pictures', 'Movies', 'Music', 'Applications', 'Public',
  '.ssh', '.claude', '.codex', '.config', '.gnupg', '.Trash', '.cleaner-mac', 'Github']);
// Processes the session itself stands on.
const VITAL = new Set(['WindowServer', 'kernel_task', 'launchd', 'loginwindow', 'Finder', 'Dock', 'SystemUIServer']);

// `cmac --demo`: invented data, so the view can be tried or shown without reading this Mac.
// Nothing is measured, reviewed by a model, removed or quit in demo mode.
const GB = 1048576;
const DEMO_DISK = ['~', 0, [
  ['Library', 86, [['Application Support', 41, [['Xcode', 14], ['Slack', 9], ['Figma', 7], ['Notes', 6], ['Mail', 5]]],
    ['Containers', 18, [['Docker', 11], ['Photos', 7]]], ['Caches', 12, [['com.example.browser', 5.2, 'safe'], ['com.example.editor', 3.1, 'safe'], ['pip', 2.2, 'safe'], ['Homebrew', 1.5, 'safe']]],
    ['Developer', 9, [['CoreSimulator', 6], ['DerivedData', 3]]], ['Mail', 4], ['Logs', 0.6, 'safe']]],
  ['Movies', 64, [['Trip to Kyoto', 31], ['Screen recordings', 22], ['Tutorials', 11]]],
  ['Projects', 48, [['game-engine', 19], ['thesis', 12], ['website', 9], ['experiments', 8]]],
  ['Downloads', 31, 'ask', [['ubuntu-24.04.iso', 6], ['dataset.zip', 14], ['installers', 8], ['papers', 3]]],
  ['.cache', 27, [['uv', 14, 'safe'], ['huggingface', 11, 'ask'], ['pre-commit', 2]]],
  ['Pictures', 22, [['Photos Library', 19], ['Wallpapers', 3]]],
  ['Documents', 14, [['Archive', 8], ['Taxes', 2], ['Notes', 4]]],
  ['Music', 9], ['.docker', 6], ['.npm', 3.2, 'safe'], ['Desktop', 2.1], ['.rustup', 1.8], ['.vscode', 1.1],
]];
const DEMO_PS = [
  ['/Applications/Safari.app/Contents/MacOS/Safari', 5200, 18.2, 9], ['/Applications/Xcode.app/Contents/MacOS/Xcode', 3900, 31.5, 4],
  ['/Applications/Docker.app/Contents/MacOS/Docker', 3100, 6.4, 5], ['/Applications/Slack.app/Contents/MacOS/Slack', 1900, 2.1, 6],
  ['/Applications/Figma.app/Contents/MacOS/Figma', 1700, 4.8, 5], ['/Applications/Spotify.app/Contents/MacOS/Spotify', 900, 1.9, 4],
  ['/Applications/Mail.app/Contents/MacOS/Mail', 700, 0.6, 2], ['/Applications/Notes.app/Contents/MacOS/Notes', 420, 0.2, 1],
  ['/Applications/Terminal.app/Contents/MacOS/Terminal', 380, 3.3, 2], ['/System/Library/WindowServer', 640, 11.7, 1],
  ['/usr/local/bin/node', 1300, 22.4, 3], ['/usr/bin/python3', 860, 9.1, 2], ['/usr/libexec/mds_stores', 520, 4.2, 1],
  ['/usr/bin/cargo', 300, 14.6, 1], ['/usr/sbin/bluetoothd', 60, 0.8, 1], ['/usr/libexec/trustd', 45, 0.3, 1],
].flatMap(([comm, mb, cpu, n], g) => Array.from({ length: n }, (_, i) => `${1000 + g * 20 + i} 1 ${Math.round((mb * 1024) / n)} ${(cpu / n).toFixed(1)} ${comm}`)).join('\n');
const DEMO_REVIEW = [
  'Fine to remove. Everything on this list is rebuilt on demand.',
  'uv: the next install of a Python project downloads its packages again, once.',
  'com.example.browser: pages load slower the first time after the cache is gone.',
  'Everything on this list can be undone.',
].join('\n');
const DEMO_SYS = { cpu_pct: 23, cores: 10, load: 2.4, mem: { pct: 61, used_kb: 19.5 * GB, total_kb: 32 * GB }, disk_free_kb: 212.4 * GB, disk_total_kb: 494 * GB, net_down_bps: 1258291, net_up_bps: 84000 };

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const cw = (ch) => {
  const o = ch.codePointAt(0);
  if (o < 32) return 0;
  return (o >= 0x1100 && o <= 0x115f) || (o >= 0x2e80 && o <= 0xa4cf) || (o >= 0xac00 && o <= 0xd7a3) || (o >= 0xf900 && o <= 0xfaff)
    || (o >= 0xfe30 && o <= 0xfe4f) || (o >= 0xff00 && o <= 0xff60) || (o >= 0xffe0 && o <= 0xffe6) || (o >= 0x1f300 && o <= 0x1faff) ? 2 : 1;
};
const width = (s) => [...s].reduce((a, ch) => a + cw(ch), 0);
function wrap(text, n) {
  const lines = [];
  for (const para of text.split('\n')) {
    let line = '';
    let used = 0;
    for (const word of para.split(/(\s+)/)) {
      for (const piece of width(word) > n ? [...word] : [word]) {
        const w = width(piece);
        if (used + w > n && line.trim()) { lines.push(line.trimEnd()); line = ''; used = 0; if (!piece.trim()) continue; }
        line += piece;
        used += w;
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}
function ago(at) {
  const m = Math.round((Date.now() - at) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
}
const rate = (bps) => (bps >= 1048576 ? (bps / 1048576).toFixed(1) + ' MB/s' : bps >= 1024 ? Math.round(bps / 1024) + ' KB/s' : bps + ' B/s');

// Squarified treemap. `values` are sorted, largest first; returns one rectangle per value in the
// unit space of the given box, where a character cell is 1 wide and 2 tall.
function squarify(values, x, y, w, h) {
  const total = values.reduce((a, v) => a + v, 0);
  const rects = [];
  if (total <= 0 || w <= 0 || h <= 0) return values.map(() => null);
  const scale = (w * h) / total;
  let i = 0;
  while (i < values.length) {
    const short = Math.min(w, h);
    let sum = 0;
    let lo = Infinity;
    let hi = 0;
    let best = Infinity;
    let j = i;
    while (j < values.length) {
      const a = values[j] * scale;
      const s = sum + a;
      const worst = Math.max((short * short * Math.max(hi, a)) / (s * s), (s * s) / (short * short * Math.min(lo, a)));
      if (worst > best) break;
      best = worst; sum = s; lo = Math.min(lo, a); hi = Math.max(hi, a); j++;
    }
    const thick = sum / short;
    let off = 0;
    for (let k = i; k < j; k++) {
      const len = (values[k] * scale) / thick;
      rects.push(w >= h ? { x, y: y + off, w: thick, h: len } : { x: x + off, y, w: len, h: thick });
      off += len;
    }
    if (w >= h) { x += thick; w -= thick; } else { y += thick; h -= thick; }
    i = j;
  }
  return rects;
}

export function tui(ctx) {
  const { HOME, HOLD, fmt, demo } = ctx;
  const holdShown = HOLD.replace(HOME, '~');
  const stdin = process.stdin;
  const write = (s) => fs.writeSync(1, s);
  let W = process.stdout.columns || 100;
  let H = process.stdout.rows || 30;
  const HINT = 'enter open   backspace back   arrows move   1-5 tabs   u undo   r refresh   q quit';

  // ---------- state ----------
  const st = {
    tab: T_HOME,
    stack: TABS.map(() => []),   // per tab: the chain of opened nodes, root first
    sel: TABS.map(() => 0),
    msg: ['slate', HINT],
    modal: null,
    rects: [],                   // selectable things on screen: { node, x0, y0, x1, y1 }
    hits: [],                    // other click targets: { x0, x1, y, run }
    spin: 0,
    rules: new Map(),            // path -> scan item, to colour cells cmac knows about
    removable: null,             // null until the first scan result is in
    gpu: null,
    sys: null,
  };
  const node = () => st.stack[st.tab][st.stack[st.tab].length - 1];
  const selected = () => (st.rects[st.sel[st.tab]] || {}).node;
  const say = (tone, text) => { st.msg = [tone, text]; };
  const sum = (list) => list.reduce((a, k) => a + k.v, 0);

  // ---------- the cache ----------
  const cacheDir = path.join(process.env.XDG_CACHE_HOME || path.join(HOME, '.cache'), 'cleaner-mac');
  const readJSON = (name, fallback) => { try { return JSON.parse(fs.readFileSync(path.join(cacheDir, name), 'utf8')); } catch { return fallback; } };
  const cache = demo ? {} : readJSON('disk.json', {});
  let saving = null;
  function saveSoon() {
    if (demo || saving) return;
    saving = setTimeout(() => {
      saving = null;
      const keys = Object.keys(cache);
      if (keys.length > 400) keys.sort((a, b) => cache[a].at - cache[b].at).slice(0, keys.length - 400).forEach((k) => delete cache[k]);
      try { fs.mkdirSync(cacheDir, { recursive: true }); fs.writeFileSync(path.join(cacheDir, 'disk.json'), JSON.stringify(cache)); } catch { /* a cache that cannot be written is only slower */ }
    }, 1000);
  }
  const remember = (n) => { cache[n.path] = { at: n.cachedAt || Date.now(), kids: n.kids.map(({ name, v, dir }) => ({ name, v, dir })) }; saveSoon(); };

  // ---------- measuring: one `du` per entry, four at a time ----------
  const jobs = [];
  const running = new Set();
  function pump() {
    while (running.size < 4 && jobs.length) {
      const j = jobs.shift();
      const [cmd, args] = j.low ? ['/usr/sbin/taskpolicy', ['-b', '/usr/bin/du', '-sk', '--', j.p]] : ['/usr/bin/du', ['-sk', '--', j.p]];
      const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
      running.add(child);
      let o = '';
      let ended = false;
      const end = () => { if (ended) return; ended = true; running.delete(child); j.done(Number(o.split('\t')[0]) || 0); pump(); };
      child.stdout.on('data', (d) => { o += d; });
      child.on('close', end);
      child.on('error', end);
    }
  }

  // ---------- disk ----------
  function tagOf(p) {
    if (p === path.dirname(HOLD) || p.startsWith(path.dirname(HOLD) + '/')) return 'held';
    const item = st.rules.get(p);
    return item ? item.tier : null;
  }
  // Fill n.kids. Cached sizes are shown at once; what is missing or stale is measured behind them.
  function openDir(n, force) {
    if (demo) return !!n.kids;
    if (n.loading) return true;
    let entries;
    try { entries = fs.readdirSync(n.path, { withFileTypes: true }); } catch (e) { say('red', `cannot read ${n.path}: ${e.code || e.message}`); return false; }
    const isDir = new Map(entries.map((e) => [e.name, e.isDirectory() && !e.isSymbolicLink()]));
    const cached = cache[n.path];
    const stale = force || !cached || Date.now() - cached.at > TTL;
    const known = new Map((cached ? cached.kids : []).map((k) => [k.name, k]));
    const make = (name, v) => { const p = path.join(n.path, name); return { name, path: p, v, dir: isDir.get(name), tag: tagOf(p) }; };
    n.kids = entries.filter((e) => known.has(e.name)).map((e) => make(e.name, known.get(e.name).v));
    n.cachedAt = cached && cached.at ? cached.at : null;
    const todo = entries.filter((e) => stale || !known.has(e.name));
    n.left = todo.length;
    n.loading = n.left > 0;
    if (n.root) n.v = sum(n.kids);
    jobs.unshift(...todo.map((e) => ({
      p: path.join(n.path, e.name),
      low: !!cached && !force,
      done: (kb) => {
        const k = n.kids.find((c) => c.name === e.name);
        if (k) k.v = kb; else n.kids.push(make(e.name, kb));
        if (n.root) n.v = sum(n.kids);
        if (!--n.left) { n.loading = false; n.cachedAt = Date.now(); remember(n); }
        schedule();
      },
    })));
    pump();
    return true;
  }
  function diskRoot(force) {
    if (demo) {
      const build = ([name, gb, ...rest], dir) => {
        const p = dir ? path.join(dir, name) : HOME;
        const kids = rest.find(Array.isArray);
        const n = { name, path: p, v: Math.round(gb * GB), dir: !!kids, tag: rest.find((r) => typeof r === 'string') || null };
        if (kids) { n.kids = kids.map((k) => build(k, p)); if (!n.v) n.v = sum(n.kids); }
        return n;
      };
      st.stack[T_DISK] = [build(DEMO_DISK, null)];
      return;
    }
    const root = { name: '~', path: HOME, v: 0, dir: true, root: true };
    st.stack[T_DISK] = [root];
    st.sel[T_DISK] = 0;
    openDir(root, force);
  }
  // After something changed on disk: keep showing what is cached, measure it again behind.
  function staleChain() { for (const n of st.stack[T_DISK]) if (cache[n.path]) cache[n.path].at = 0; }

  // ---------- memory, CPU, GPU, system ----------
  let mine = new Set();
  async function loadProcs() {
    const o = demo ? DEMO_PS : (await ctx.run('/bin/ps', ['-axo', 'pid=,ppid=,rss=,pcpu=,comm='])).out;
    const procs = o.split('\n').map((l) => l.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/)).filter(Boolean)
      .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), rss: Number(m[3]), cpu: Number(m[4]), comm: m[5] }));
    const byPid = new Map(procs.map((p) => [p.pid, p]));
    mine = new Set();
    for (let p = byPid.get(process.pid); p; p = byPid.get(p.ppid)) mine.add(p.pid);
    for (const t of [T_MEM, T_CPU]) {
      const metric = t === T_MEM ? 'rss' : 'cpu';
      const groups = new Map();
      for (const p of procs) {
        const app = p.comm.match(/\/([^/]+)\.app\//);
        const name = app ? app[1] : path.basename(p.comm);
        if (!groups.has(name)) groups.set(name, { name, app: !!app, v: 0, kids: [], group: true });
        const g = groups.get(name);
        g.v += p[metric];
        g.kids.push({ name: `${path.basename(p.comm)} ${p.pid}`, pid: p.pid, v: p[metric], rss: p.rss, cpu: p.cpu });
      }
      const root = { name: t === T_MEM ? 'memory in use by processes' : 'CPU in use by processes', v: 0, kids: [...groups.values()] };
      root.v = sum(root.kids);
      const open = st.stack[t][1] && root.kids.find((g) => g.name === st.stack[t][1].name);
      st.stack[t] = open ? [root, open] : [root];
    }
  }
  async function loadGpu() {
    const o = demo ? '"Device Utilization %"=23 "In use system memory"=2147483648 "Alloc system memory"=6442450944'
      : (await ctx.run('/usr/sbin/ioreg', ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator'])).out;
    const n = (k) => Number((o.match(new RegExp(`"${k}"=(\\d+)`)) || [])[1]) || 0;
    const used = n('Device Utilization %');
    st.gpu = { used, mem: n('In use system memory'), alloc: n('Alloc system memory') };
    st.stack[T_GPU] = [{ name: 'GPU time', v: 100, kids: [{ name: 'in use', v: Math.max(used, 0.5), tag: 'safe' }, { name: 'idle', v: Math.max(100 - used, 0.5) }] }];
  }
  const loadSys = () => { st.sys = demo ? DEMO_SYS : ctx.stats(false); };
  const unit = (v) => (st.tab === T_DISK || st.tab === T_MEM ? fmt(Math.round(v)) : st.tab === T_CPU ? `${v.toFixed(1)}%` : `${Math.round(v)}%`);

  // ---------- the removable list, cached like the sizes ----------
  function useScan(items) {
    st.rules = new Map();
    for (const i of items) for (const p of (i.paths && i.paths.length <= 50 ? i.paths : [])) st.rules.set(p, i);
    for (const i of items) if (i.id.startsWith('review:')) st.rules.set(path.join(HOME, i.id.slice(7)), i);
    st.removable = items.filter((i) => i.tier === 'safe' && (i.paths || i.command));
    for (const n of st.stack[T_DISK]) for (const k of n.kids || []) k.tag = tagOf(k.path);
    schedule();
  }
  function rescan(force) {
    if (demo) {
      const find = (n, out = []) => { if (n.tag === 'safe') out.push({ id: n.name, label: n.name, kb: n.v, paths: [n.path], tier: 'safe' }); (n.kids || []).forEach((k) => find(k, out)); return out; };
      st.removable = find(st.stack[T_DISK][0]);
      return;
    }
    const kept = readJSON('scan.json', null);
    if (!force && kept && Date.now() - kept.at < TTL) return useScan(kept.items);
    if (kept && st.removable === null) useScan(kept.items);
    ctx.scan({ live: false }).then((items) => {
      try { fs.mkdirSync(cacheDir, { recursive: true }); fs.writeFileSync(path.join(cacheDir, 'scan.json'), JSON.stringify({ at: Date.now(), items })); } catch { /* only slower next time */ }
      useScan(items);
    });
  }

  // ---------- drawing ----------
  let cells;
  const blank = () => { cells = Array.from({ length: H }, () => Array.from({ length: W }, () => [' ', C.silver, C.bg, false])); };
  function put(x, y, text, fg = C.silver, bg = null, bold = false, max = W) {
    if (y < 0 || y >= H) return x;
    for (const ch of text) {
      const w = cw(ch);
      if (!w) continue;
      if (x + w > Math.min(W, max)) break;
      if (x >= 0) {
        cells[y][x] = [ch, fg, bg || cells[y][x][2], bold];
        if (w === 2) cells[y][x + 1] = ['', fg, bg || cells[y][x + 1][2], bold];
      }
      x += w;
    }
    return x;
  }
  const fill = (x0, y0, x1, y1, bg) => { for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) cells[y][x] = [' ', C.silver, bg, false]; };
  const keycap = (x, y, k) => put(x, y, ` ${k} `, C.ink, C.yellow, true);
  function flush() {
    let s = '\x1b[?2026h\x1b[H';
    let last = '';
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const [ch, fg, bg, bold] = cells[y][x];
        if (ch === '') continue;
        const sgr = `${bold ? 1 : 22};38;2;${fg[0]};${fg[1]};${fg[2]};48;2;${bg[0]};${bg[1]};${bg[2]}`;
        if (sgr !== last) { s += `\x1b[${sgr}m`; last = sgr; }
        s += ch;
      }
      if (y < H - 1) s += '\r\n';
    }
    write(s + '\x1b[0m\x1b[?2026l');
  }

  function header() {
    const big = H >= 26 && W >= 100;
    let x = 1;
    if (big) {
      const rows = ['', '', '', '', '', ''];
      for (const ch of 'CLEANER-MAC') ctx.title[ch].forEach((l, r) => { rows[r] += l + '.'; });
      rows[5] = '.'.repeat(rows[0].length);
      const n = rows[0].length - 1;
      for (let r = 0; r < 6; r += 2) {
        for (let i = 0; i < n; i++) {
          const top = rows[r][i] === '#';
          const bot = rows[r + 1][i] === '#';
          if (!top && !bot) continue;
          const t = i / (n - 1);
          put(1 + i, r / 2, top && bot ? '█' : top ? '▀' : '▄', t < 0.5 ? mix(C.yellow, C.pink, t * 2) : mix(C.pink, C.violet, t * 2 - 1));
        }
      }
      x = n + 4;
    } else x = put(1, 0, 'CLEANER-MAC', C.yellow, null, true) + 3;
    const y = big ? 1 : 0;
    TABS.forEach((name, i) => {
      const on = i === st.tab;
      const x0 = x;
      x = put(x, y, ` ${i + 1} ${name} `, on ? C.ink : C.silver, on ? C.pink : C.panel, on);
      st.hits.push({ x0, x1: x, y, run: () => switchTab(i) });
      x += 1;
    });
    const disk = fs.statfsSync(HOME);
    const free = demo ? '212.4 GB free   demo data' : `${fmt(Math.round((disk.bavail * disk.bsize) / 1024))} free`;
    put(W - width(free) - 1, y, free, C.slate);
    return big ? 4 : 2;
  }

  // Home: what the tool can do, and how the Mac is doing.
  function menu() {
    const held = demo ? 0 : ctx.batches().length;
    const total = st.removable ? st.removable.reduce((a, i) => a + (i.kb || 0), 0) : 0;
    return [
      { title: 'Clean up', run: cleanRemovable,
        desc: st.removable === null ? 'looking for things that are rebuilt on demand...'
          : st.removable.length ? `${fmt(total)} in ${st.removable.length} item(s) can go. A model reviews the list before you agree.` : 'nothing to remove right now' },
      { title: 'Disk map', desc: 'See what fills the disk. Open a folder to split it; remove what you pick.', run: () => switchTab(T_DISK) },
      { title: 'Memory', desc: 'Apps by memory in use. Quit the heavy ones.', run: () => switchTab(T_MEM) },
      { title: 'CPU', desc: 'Apps by CPU in use right now.', run: () => switchTab(T_CPU) },
      { title: 'GPU', desc: 'How busy the GPU is, and its memory.', run: () => switchTab(T_GPU) },
      { title: 'Undo the last removal', desc: held ? `${held} removal(s) are held in ${holdShown}. \`cmac purge\` frees that space.` : 'nothing is held for undo', run: undo },
      { title: 'Quit', desc: '', run: () => quitNow() },
    ];
  }
  function drawHome(top) {
    const items = menu();
    const left = Math.max(40, Math.min(W - 46, Math.round(W * 0.58)));
    const step = H - top - 3 >= items.length * 3 ? 3 : 2;
    st.rects = [];
    items.forEach((it, i) => {
      const y = top + i * step;
      if (y + 1 >= H - 2) return;
      const on = i === st.sel[T_HOME];
      if (on) fill(1, y, left, y + 2, C.lift);
      put(3, y, it.title, on ? C.white : C.silver, null, true, left - 8);
      put(3, y + 1, it.desc, on ? C.silver : C.slate, null, false, left - 1);
      if (on) keycap(left - 6, y, 'tab');
      st.rects.push({ node: it, x0: 1, y0: y, x1: left, y1: y + 2, i });
    });
    const s = st.sys;
    if (!s || W - left < 38) return;
    const x = left + 3;
    const bw = Math.max(10, Math.min(28, W - x - 16));
    put(x, top, 'This Mac', C.white, null, true);
    const bar = (y, name, pct, text) => {
      const on = Math.max(0, Math.min(bw, Math.round((pct / 100) * bw)));
      put(x, y, name, C.silver);
      put(x + 8, y, '█'.repeat(on), pct >= 85 ? C.red : pct >= 60 ? C.yellow : C.green);
      put(x + 8 + on, y, '░'.repeat(bw - on), C.line);
      put(x + 9 + bw, y, `${pct}%`, C.white, null, true);
      put(x + 8, y + 1, text, C.slate, null, false, W - 1);
    };
    bar(top + 2, 'cpu', s.cpu_pct, `load ${s.load} on ${s.cores} cores`);
    bar(top + 5, 'memory', s.mem.pct, `${fmt(Math.round(s.mem.used_kb))} of ${fmt(Math.round(s.mem.total_kb))}`);
    bar(top + 8, 'disk', Math.round(100 * (1 - s.disk_free_kb / s.disk_total_kb)), `${fmt(Math.round(s.disk_free_kb))} free of ${fmt(Math.round(s.disk_total_kb))}`);
    put(x, top + 11, 'network', C.silver);
    put(x + 8, top + 11, `down ${rate(s.net_down_bps)}   up ${rate(s.net_up_bps)}`, C.white);
  }

  // A resource tab: back button, where you are, then the map.
  function drawMap(top) {
    const cur = node();
    let x = put(1, top, ' back ', C.ink, C.silver, true);
    st.hits.push({ x0: 1, x1: x, y: top, run: up });
    x = put(x + 2, top, st.stack[st.tab].map((n) => n.name).join(' / '), C.white, null, true, W - 40);
    if (cur) x = put(x + 2, top, unit(cur.v || sum(cur.kids || [])), C.yellow, null, true);
    let right = '';
    if (st.tab === T_DISK && cur) right = cur.loading ? `${SPIN[st.spin % 10]} measuring, ${cur.left} left` : cur.cachedAt ? `measured ${ago(cur.cachedAt)}   r measures again` : '';
    if (st.tab === T_GPU && st.gpu) right = `memory ${fmt(Math.round(st.gpu.mem / 1024))} in use of ${fmt(Math.round(st.gpu.alloc / 1024))} allocated`;
    if (right && W - width(right) - 1 > x + 2) put(W - width(right) - 1, top, right, cur && cur.loading ? C.pink : C.slate);

    const x0 = 1;
    const y0 = top + 2;
    const mw = W - 2;
    const mh = H - y0 - 3;
    st.rects = [];
    const kids = ((cur && cur.kids) || []).filter((k) => k.v > 0).sort((a, b) => b.v - a.v);
    if (!kids.length || mw < 6 || mh < 2) {
      if (cur && !cur.loading) put(3, y0 + 1, st.tab === T_DISK ? 'this folder is empty' : 'nothing to show', C.slate);
      return;
    }
    // Cells too small to label are folded into one cell that opens like a folder.
    const total = sum(kids);
    const min = (total * 14) / (mw * mh * 2);
    const small = kids.filter((k) => k.v < min);
    const shown = small.length > 1 ? [...kids.filter((k) => k.v >= min), { name: `${small.length} smaller items`, v: sum(small), kids: small, fold: true }] : kids.slice();
    shown.sort((a, b) => b.v - a.v);
    const boxes = squarify(shown.map((k) => k.v), 0, 0, mw, mh * 2);
    shown.forEach((k, i) => {
      const r = boxes[i];
      if (!r) return;
      const cx0 = x0 + Math.round(r.x);
      const cx1 = x0 + Math.round(r.x + r.w);
      const cy0 = y0 + Math.round(r.y / 2);
      const cy1 = y0 + Math.round((r.y + r.h) / 2);
      if (cx1 - cx0 >= 1 && cy1 - cy0 >= 1) st.rects.push({ node: k, x0: cx0, y0: cy0, x1: cx1, y1: cy1, i });
    });
    if (st.sel[st.tab] >= st.rects.length) st.sel[st.tab] = Math.max(0, st.rects.length - 1);
    st.rects.forEach((r, idx) => {
      const on = idx === st.sel[st.tab];
      const w = r.x1 - r.x0;
      const h = r.y1 - r.y0;
      let bg = r.node.tag ? TAG[r.node.tag] : TONES[r.i % TONES.length];
      if (on) bg = mix(bg, C.white, 0.42);
      // one column of gap on the right and half a row below, so every cell reads as its own tile
      const xe = r.x1 - (w > 2 ? 1 : 0);
      fill(r.x0, r.y0, xe, r.y1, bg);
      if (h >= 2) for (let cx = r.x0; cx < xe; cx++) cells[r.y1 - 1][cx] = ['▄', C.bg, bg, false];
      if (w < 5) return;
      const fg = on ? C.ink : C.white;
      const dim = on ? C.ink : mix(bg, C.white, 0.72);
      const opens = r.node.dir || r.node.kids;
      put(r.x0 + 1, r.y0, (opens ? '▸ ' : '') + r.node.name, fg, null, true, xe - 1);
      const share = `${Math.round((100 * r.node.v) / total)}%`;
      if (h >= 3) {
        put(r.x0 + 1, r.y0 + 1, unit(r.node.v), dim, null, false, xe - 1);
        if (w >= 12 && h >= 4) put(r.x0 + 1, r.y0 + 2, share, dim, null, false, xe - 1);
      } else if (h === 2 && w >= width(r.node.name) + width(unit(r.node.v)) + 7) put(xe - 1 - width(unit(r.node.v)), r.y0, unit(r.node.v), dim);
    });
  }

  function draw() {
    W = process.stdout.columns || W;
    H = process.stdout.rows || H;
    blank();
    st.hits = [];
    const top = header();
    if (st.tab === T_HOME) drawHome(top); else drawMap(top);

    // what is selected, and the keys
    const s = selected();
    if (s && st.tab !== T_HOME) {
      let t = put(1, H - 2, s.name, C.white, null, true, W - 30);
      t = put(t + 2, H - 2, unit(s.v), C.yellow, null, true);
      const note = s.fold ? 'enter opens the small items'
        : st.tab === T_DISK ? (s.tag === 'safe' ? 'cmac marks this removable: rebuilt on demand' : s.tag === 'ask' ? 'large personal data: look inside before removing' : s.tag === 'held' ? 'held for undo; `cmac purge` frees it' : s.dir ? 'folder' : 'file')
          : st.tab === T_GPU ? 'macOS does not report GPU use per process without admin rights'
            : s.group ? `${s.kids.length} process(es)` : `pid ${s.pid}   ${fmt(s.rss)}   ${s.cpu.toFixed(1)}% cpu`;
      put(t + 2, H - 2, note, C.slate);
    }
    let x = keycap(1, H - 1, 'tab');
    const main = st.tab === T_HOME ? (s ? s.title.toLowerCase() : 'choose') : st.tab === T_DISK ? 'review and remove' : st.tab === T_GPU ? 'nothing to act on' : 'quit it';
    x = put(x + 1, H - 1, main, C.white, null, true);
    put(x + 3, H - 1, st.msg[1], C[st.msg[0]] || C.slate, null, false, W - 1);

    if (st.modal) drawModal();
    flush();
  }

  function drawModal() {
    const m = st.modal;
    const w = Math.min(W - 6, 96);
    const body = m.lines.flatMap((l) => wrap(l, w - 4)).slice(0, H - 8);
    const h = body.length + 5;
    const x0 = Math.floor((W - w) / 2);
    const y0 = Math.max(1, Math.floor((H - h) / 2));
    fill(x0 - 1, y0, x0 + w + 1, y0 + h, C.panel);
    fill(x0 - 1, y0, x0 + w + 1, y0 + 1, m.danger ? C.red : C.pink);
    put(x0 + 1, y0, m.title, C.ink, null, true, x0 + w - 1);
    body.forEach((l, i) => put(x0 + 1, y0 + 2 + i, l, C.white, null, false, x0 + w - 1));
    let x = x0 + 1;
    const y = y0 + h - 2;
    if (m.busy) put(x, y, `${SPIN[st.spin % 10]} ${m.busy}`, C.pink);
    else {
      if (m.run) { x = keycap(x, y, 'tab'); x = put(x + 1, y, m.action, C.white, null, true) + 3; }
      x = put(x, y, 'q', C.yellow, null, true);
      put(x + 1, y, m.run ? 'cancel' : 'close', C.slate);
    }
  }

  let pending = null;
  function schedule() { if (!pending) pending = setTimeout(() => { pending = null; draw(); }, 60); }

  // ---------- actions ----------
  function open() {
    const s = selected();
    if (!s) return;
    if (st.tab === T_HOME) return s.run();
    if (st.tab === T_DISK && s.dir && !s.fold) {
      if (!openDir(s)) return;
    } else if (!s.kids) return say('slate', `${s.name} has nothing inside to open`);
    st.stack[st.tab].push(s);
    st.sel[st.tab] = 0;
    say('slate', HINT);
  }
  function up() {
    if (st.tab === T_HOME) return;
    if (st.stack[st.tab].length > 1) { st.stack[st.tab].pop(); st.sel[st.tab] = 0; }
    else switchTab(T_HOME);
  }
  function forget(n) {
    for (const a of st.stack[T_DISK]) {
      if (a.kids && a.kids.includes(n)) a.kids = a.kids.filter((k) => k !== n);
      a.v = Math.max(0, (a.v || 0) - n.v);
      if (!demo && a.kids && !a.loading) remember(a);
    }
  }
  function undo() {
    if (demo) return say('green', 'demo: nothing to undo');
    const lines = ctx.undoLatest();
    say(...lines[lines.length - 1]);
    staleChain();
    rescan(true);
    diskRoot();
  }

  const safeReviewer = () => { try { return ctx.reviewer(); } catch { return 'a model'; } };
  async function reviewThen(titleText, todo, after) {
    st.modal = { title: titleText, lines: ['Nothing has been removed yet.'], busy: `asking ${demo ? 'the model' : safeReviewer()} for a review` };
    draw();
    let text;
    if (demo) text = await new Promise((done) => setTimeout(() => done(DEMO_REVIEW), 600));
    else try { text = await ctx.review(todo); } catch (e) { text = `The review did not run: ${e.message}`; }
    if (!st.modal) return;
    const fixed = todo.filter((i) => !i.paths).length;
    st.modal = {
      title: titleText,
      lines: [...text.split('\n'), '', fixed ? `${todo.length - fixed} item(s) move to ${holdShown} and come back with u (undo). ${fixed} run a command that cannot be undone.`
        : `Moved to ${holdShown}, back with u (undo). Disk space is freed only by \`cmac purge\`.`],
      action: fixed ? 'remove' : 'move to the holding folder',
      run: () => {
        st.modal = null;
        if (demo) return say('green', 'demo: nothing was removed');
        const r = ctx.apply(todo);
        if (r.failed.length) say('red', `failed: ${r.failed[0].label}: ${r.failed[0].error}`);
        else say('green', `removed ${r.done.length} item(s); u puts ${r.moved.length ? 'them' : 'nothing'} back`);
        after(r);
      },
    };
    draw();
  }

  function act() {
    const s = selected();
    if (!s) return;
    if (st.tab === T_HOME) return s.run();
    if (st.tab === T_GPU) return say('slate', 'nothing to act on here');
    if (st.tab === T_DISK) {
      if (s.fold) return say('slate', 'open the small items and pick one');
      const rel = path.relative(HOME, s.path);
      if (s.tag === 'held') return say('yellow', 'this is the holding folder: `cmac purge` empties it, u restores the latest removal');
      if (!rel || rel.startsWith('..')) return say('red', 'only things inside your home folder can be removed');
      if (!rel.includes('/') && PROTECTED.has(rel)) return say('yellow', `${s.name} is protected as a whole: open it and pick something inside`);
      const item = st.rules.get(s.path);
      const todo = [{ id: rel, label: s.name, kb: s.v, paths: [s.path],
        detail: item ? item.detail : `${s.dir ? 'folder' : 'file'} at ~/${rel}, picked by the user in the disk map`,
        note: item ? item.note : 'not on cmac\'s list of things that are rebuilt on demand' }];
      return reviewThen(`Remove ${s.name}  ${fmt(s.v)}`, todo, (r) => { if (r.done.length) forget(s); });
    }
    const pids = s.group ? s.kids.map((k) => k.pid) : [s.pid];
    if (pids.some((p) => mine.has(p))) return say('yellow', `${s.name} is the terminal this is running in`);
    if (VITAL.has(s.name.replace(/ \d+$/, ''))) return say('yellow', `${s.name} is part of macOS itself; quitting it logs you out or restarts it`);
    st.modal = {
      title: `Quit ${s.name}`,
      danger: true,
      lines: [s.group ? `${s.kids.length} process(es) using ${unit(s.v)}.` : `One process using ${unit(s.v)}.`,
        s.app ? 'The app is asked to quit, as if you chose Quit from its menu. It may ask to save open documents.'
          : 'The process is sent the terminate signal. Unsaved work in it is lost, and a service may be restarted by the system right away.',
        'This cannot be undone.'],
      action: 'quit it',
      run: () => {
        st.modal = null;
        if (demo) return say('green', 'demo: nothing was quit');
        if (s.app) ctx.runSync('/usr/bin/osascript', ['-e', `tell application ${JSON.stringify(s.name)} to quit`]);
        else {
          let failed = 0;
          for (const p of pids) { try { process.kill(p, 'SIGTERM'); } catch { failed++; } }
          if (failed) return say('red', `${failed} of ${pids.length} could not be signalled (not yours, or already gone)`);
        }
        say('green', `asked ${s.name} to quit`);
        setTimeout(() => loadProcs().then(schedule), 1200);
      },
    };
  }

  function cleanRemovable() {
    if (st.removable === null) return say('slate', 'still looking for removable items; try again in a moment');
    if (!st.removable.length) return say('slate', 'cmac found nothing it marks removable');
    reviewThen(`Clean ${st.removable.length} item(s) cmac marks removable`, st.removable, () => { staleChain(); rescan(true); diskRoot(); });
  }

  function move(dx, dy) {
    const cur = st.rects[st.sel[st.tab]];
    if (!cur) return;
    const cx = (cur.x0 + cur.x1) / 2;
    const cy = (cur.y0 + cur.y1) / 2;
    let best = -1;
    let bestD = Infinity;
    st.rects.forEach((r, i) => {
      const x = (r.x0 + r.x1) / 2 - cx;
      const y = ((r.y0 + r.y1) / 2 - cy) * 2;
      const along = dx ? x * dx : y * dy;
      const across = Math.abs(dx ? y : x);
      if (along <= 0.5) return;
      const d = along + across * 2;
      if (d < bestD) { bestD = d; best = i; }
    });
    if (best >= 0) st.sel[st.tab] = best;
  }

  function switchTab(i) {
    st.tab = i;
    say('slate', HINT);
    if (i === T_HOME) loadSys();
    if (i === T_MEM || i === T_CPU) loadProcs().then(schedule);
    if (i === T_GPU) loadGpu().then(schedule);
  }

  function click(x, y) {
    const hit = st.hits.find((h) => y === h.y && x >= h.x0 && x < h.x1);
    if (hit) return hit.run();
    const i = st.rects.findIndex((r) => x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1);
    if (i < 0) return;
    if (i === st.sel[st.tab] || st.tab === T_HOME) { st.sel[st.tab] = i; open(); }
    else { st.sel[st.tab] = i; say('slate', 'click again or press enter to open it   tab acts on it   right click goes back'); }
  }

  // ---------- run ----------
  let quitNow = () => {};
  return new Promise((resolve) => {
    const timers = [];
    const restore = '\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[?1049l';
    quitNow = () => {
      timers.forEach(clearInterval);
      jobs.length = 0;
      for (const c of running) c.kill();
      // Keep what was measured so far: it is shown at once next time and measured again behind.
      for (const n of st.stack[T_DISK]) if (!demo && n.loading && n.kids && n.kids.length) cache[n.path] = { at: 0, kids: n.kids.map(({ name, v, dir }) => ({ name, v, dir })) };
      if (saving) clearTimeout(saving);
      saving = null;
      if (!demo) try { fs.mkdirSync(cacheDir, { recursive: true }); fs.writeFileSync(path.join(cacheDir, 'disk.json'), JSON.stringify(cache)); } catch { /* a cache that cannot be written is only slower */ }
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeAllListeners('data');
      write(restore);
      resolve();
    };
    write('\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h');
    stdin.setRawMode(true);
    stdin.resume();
    process.once('exit', () => write(restore));
    process.stdout.on('resize', schedule);

    stdin.on('data', (d) => {
      const k = d.toString();
      const mouse = k.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
      if (k === '\x03') return quitNow();
      if (st.modal) {
        if (st.modal.busy) { if (k === 'q' || k === '\x1b') st.modal = null; }
        else if (k === '\t' && st.modal.run) st.modal.run();
        else if (k === 'q' || k === '\x1b' || k === '\r') st.modal = null;
        return draw();
      }
      if (mouse) {
        if (mouse[4] === 'M' && mouse[1] === '0') click(Number(mouse[2]) - 1, Number(mouse[3]) - 1);
        else if (mouse[4] === 'M' && mouse[1] === '2') up();
      } else if (k === 'q') return quitNow();
      else if (k === '\t') act();
      else if (k === '\r') open();
      else if (k === '\x7f' || k === '\b' || k === '\x1b' || k === '\x1b[3~' || k === '-') up();
      else if (k === '\x1b[A') move(0, -1);
      else if (k === '\x1b[B') move(0, 1);
      else if (k === '\x1b[C') move(1, 0);
      else if (k === '\x1b[D') move(-1, 0);
      else if (k >= '1' && k <= '5') switchTab(Number(k) - 1);
      else if (k === 'c') cleanRemovable();
      else if (k === 'u') undo();
      else if (k === 'r') { if (st.tab === T_DISK) openDir(node(), true); else if (st.tab === T_HOME) rescan(true); else switchTab(st.tab); }
      draw();
    });

    diskRoot();
    rescan();
    loadSys();
    loadProcs().then(() => loadGpu()).then(schedule);
    timers.push(setInterval(() => {
      st.spin++;
      const cur = node();
      if ((st.tab === T_DISK && cur && cur.loading) || (st.modal && st.modal.busy)) schedule();
    }, 100));
    timers.push(setInterval(() => {
      if (st.modal) return;
      if (st.tab === T_HOME) { loadSys(); schedule(); }
      if (st.tab === T_MEM || st.tab === T_CPU) loadProcs().then(schedule);
      if (st.tab === T_GPU) loadGpu().then(schedule);
    }, 3000));
    draw();
  });
}
