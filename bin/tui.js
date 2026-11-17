// The full-screen view of cleaner-mac: one tab per resource, each drawn as a treemap.
// A cell's area is its share of the resource. Enter or a second click opens a cell into its parts;
// Tab acts on the selected cell (disk: review, then move to the holding folder; memory and CPU: quit).
// No dependencies. Everything that touches files goes through the functions cmac.js passes in.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const TABS = ['Disk', 'Memory', 'CPU', 'GPU'];
const C = {
  bg: [12, 11, 28], panel: [24, 18, 52], line: [58, 52, 104], white: [248, 244, 255], silver: [198, 196, 226],
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
  const { HOME, HOLD, fmt } = ctx;
  const stdin = process.stdin;
  const write = (s) => fs.writeSync(1, s);
  let W = process.stdout.columns || 100;
  let H = process.stdout.rows || 30;

  // ---------- state ----------
  const st = {
    tab: 0,
    stack: TABS.map(() => []),   // per tab: the chain of opened nodes, root first
    sel: TABS.map(() => 0),
    msg: ['slate', 'tab acts on the selected cell   enter opens it   backspace goes up   1-4 switch tabs   u undo   q quit'],
    modal: null,
    rects: [],                   // what is on screen: { node, x0, y0, x1, y1 }
    tabsAt: [],                  // click targets of the tab labels
    spin: 0,
    rules: new Map(),            // path -> scan item, to colour cells cmac knows about
    removable: [],
    gpu: null,
  };
  let du = new Set();
  const node = () => st.stack[st.tab][st.stack[st.tab].length - 1];
  const selected = () => (st.rects[st.sel[st.tab]] || {}).node;
  const say = (tone, text) => { st.msg = [tone, text]; };

  // ---------- disk ----------
  function tagOf(p) {
    if (p === path.dirname(HOLD) || p.startsWith(path.dirname(HOLD) + '/')) return 'held';
    const item = st.rules.get(p);
    return item ? item.tier : null;
  }
  // One `du` per entry, eight at a time, so each cell appears as soon as its own size is known
  // and a huge folder does not hold back the small ones.
  function openDir(n) {
    for (const c of du) c.kill();
    du = new Set();
    let entries;
    try { entries = fs.readdirSync(n.path, { withFileTypes: true }); } catch (e) { say('red', `cannot read ${n.path}: ${e.code || e.message}`); return false; }
    n.kids = [];
    n.left = entries.length;
    n.loading = entries.length > 0;
    const queue = entries.slice();
    const mineDu = du;
    const next = () => {
      const e = queue.shift();
      if (!e || du !== mineDu) return;
      const p = path.join(n.path, e.name);
      const child = spawn('/usr/bin/du', ['-sk', '--', p], { stdio: ['ignore', 'pipe', 'ignore'] });
      mineDu.add(child);
      let o = '';
      child.stdout.on('data', (d) => { o += d; });
      child.on('close', () => {
        mineDu.delete(child);
        if (du !== mineDu) return;
        const kb = Number(o.split('\t')[0]) || 0;
        n.kids.push({ name: e.name, path: p, v: kb, dir: e.isDirectory() && !e.isSymbolicLink(), tag: tagOf(p) });
        if (n === st.stack[0][0]) n.v += kb;
        n.left--;
        if (!n.left) n.loading = false;
        schedule();
        next();
      });
    };
    for (let i = 0; i < 8; i++) next();
    return true;
  }
  function diskRoot() {
    const root = { name: '~', path: HOME, v: 0, dir: true };
    st.stack[0] = [root];
    openDir(root);
  }

  // ---------- memory and CPU ----------
  let procs = [];
  let mine = new Set();
  async function loadProcs() {
    const o = (await ctx.run('/bin/ps', ['-axo', 'pid=,ppid=,rss=,pcpu=,comm='])).out;
    procs = o.split('\n').map((l) => l.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/)).filter(Boolean)
      .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), rss: Number(m[3]), cpu: Number(m[4]), comm: m[5] }));
    const byPid = new Map(procs.map((p) => [p.pid, p]));
    mine = new Set();
    for (let p = byPid.get(process.pid); p; p = byPid.get(p.ppid)) mine.add(p.pid);
    for (const t of [1, 2]) {
      const metric = t === 1 ? 'rss' : 'cpu';
      const groups = new Map();
      for (const p of procs) {
        const app = p.comm.match(/\/([^/]+)\.app\//);
        const name = app ? app[1] : path.basename(p.comm);
        if (!groups.has(name)) groups.set(name, { name, app: !!app, v: 0, kids: [], group: true });
        const g = groups.get(name);
        g.v += p[metric];
        g.kids.push({ name: `${path.basename(p.comm)} ${p.pid}`, pid: p.pid, v: p[metric], rss: p.rss, cpu: p.cpu });
      }
      const root = { name: t === 1 ? 'memory in use by processes' : 'CPU in use by processes', v: 0, kids: [...groups.values()] };
      root.v = root.kids.reduce((a, g) => a + g.v, 0);
      const open = st.stack[t][1] && root.kids.find((g) => g.name === st.stack[t][1].name);
      st.stack[t] = open ? [root, open] : [root];
    }
  }
  async function loadGpu() {
    const o = (await ctx.run('/usr/sbin/ioreg', ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator'])).out;
    const n = (k) => Number((o.match(new RegExp(`"${k}"=(\\d+)`)) || [])[1]) || 0;
    const used = n('Device Utilization %');
    st.gpu = { used, mem: n('In use system memory'), alloc: n('Alloc system memory') };
    st.stack[3] = [{ name: 'GPU time', v: 100, kids: [{ name: 'in use', v: Math.max(used, 0.5), tag: 'safe' }, { name: 'idle', v: Math.max(100 - used, 0.5) }] }];
  }
  const unit = (v) => (st.tab === 1 || st.tab === 0 ? fmt(Math.round(v)) : st.tab === 2 ? `${v.toFixed(1)}%` : `${Math.round(v)}%`);

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
    const big = H >= 26 && W >= 96;
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
          const col = t < 0.5 ? mix(C.yellow, C.pink, t * 2) : mix(C.pink, C.violet, t * 2 - 1);
          put(1 + i, r / 2, top && bot ? '█' : top ? '▀' : '▄', col);
        }
      }
      x = n + 4;
    } else x = put(1, 0, 'CLEANER-MAC', C.yellow, null, true) + 3;
    const y = big ? 1 : 0;
    st.tabsAt = [];
    TABS.forEach((name, i) => {
      const on = i === st.tab;
      const x0 = x;
      x = put(x, y, ` ${i + 1} ${name} `, on ? C.ink : C.silver, on ? C.pink : C.panel, on);
      st.tabsAt.push([x0, x, y]);
      x += 1;
    });
    const disk = fs.statfsSync(HOME);
    const free = `${fmt(Math.round((disk.bavail * disk.bsize) / 1024))} free`;
    put(W - width(free) - 1, y, free, C.slate);
    return big ? 3 : 1;
  }

  function draw() {
    W = process.stdout.columns || W;
    H = process.stdout.rows || H;
    blank();
    const top = header();
    const cur = node();
    // breadcrumb
    const crumb = st.stack[st.tab].map((n) => n.name).join(' / ');
    let x = put(1, top, crumb, C.white, null, true);
    if (cur) {
      x = put(x + 2, top, unit(cur.v || (cur.kids || []).reduce((a, k) => a + k.v, 0)), C.slate);
      if (cur.loading) put(x + 2, top, `${'⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'[st.spin % 10]} measuring, ${cur.left} left`, C.pink);
    }
    if (st.tab === 0 && st.removable.length) {
      const text = `c  review and clean the ${fmt(st.removable.reduce((a, i) => a + (i.kb || 0), 0))} cmac marks removable`;
      put(W - width(text) - 1, top, text, C.green);
    }
    if (st.tab === 3 && st.gpu) put(W - 46, top, `memory ${fmt(Math.round(st.gpu.mem / 1024))} in use of ${fmt(Math.round(st.gpu.alloc / 1024))} allocated`, C.slate);

    // the map
    const x0 = 1;
    const y0 = top + 1;
    const mw = W - 2;
    const mh = H - y0 - 2;
    st.rects = [];
    const kids = ((cur && cur.kids) || []).filter((k) => k.v > 0).sort((a, b) => b.v - a.v);
    if (kids.length && mw > 4 && mh > 1) {
      // cells too small to draw are folded into one "smaller items" cell that opens like a folder
      const total = kids.reduce((a, k) => a + k.v, 0);
      const min = (total * 10) / (mw * mh * 2);
      let shown = kids.filter((k) => k.v >= min);
      const small = kids.filter((k) => k.v < min);
      if (small.length > 1) shown = [...shown, { name: `${small.length} smaller items`, v: small.reduce((a, k) => a + k.v, 0), kids: small, fold: true }];
      else shown = kids;
      shown.sort((a, b) => b.v - a.v);
      const rects = squarify(shown.map((k) => k.v), 0, 0, mw, mh * 2);
      shown.forEach((k, i) => {
        const r = rects[i];
        if (!r) return;
        const cx0 = x0 + Math.round(r.x);
        const cx1 = x0 + Math.round(r.x + r.w);
        const cy0 = y0 + Math.round(r.y / 2);
        const cy1 = y0 + Math.round((r.y + r.h) / 2);
        if (cx1 - cx0 < 1 || cy1 - cy0 < 1) return;
        st.rects.push({ node: k, x0: cx0, y0: cy0, x1: cx1, y1: cy1, i });
      });
      if (st.sel[st.tab] >= st.rects.length) st.sel[st.tab] = Math.max(0, st.rects.length - 1);
      st.rects.forEach((r, idx) => {
        const on = idx === st.sel[st.tab];
        let bg = r.node.tag ? TAG[r.node.tag] : TONES[r.i % TONES.length];
        if (on) bg = mix(bg, C.white, 0.38);
        fill(r.x0, r.y0, r.x1 - (r.x1 - r.x0 > 2 ? 1 : 0), r.y1, bg);
        const fg = on ? C.ink : C.white;
        if (r.x1 - r.x0 >= 5) {
          const mark = r.node.dir || r.node.kids ? '▸ ' : '';
          put(r.x0 + 1, r.y0, mark + r.node.name, fg, null, true, r.x1 - 2);
          if (r.y1 - r.y0 >= 2) put(r.x0 + 1, r.y0 + 1, unit(r.node.v), on ? C.ink : C.silver, null, false, r.x1 - 2);
        }
      });
    } else if (cur && !cur.loading) put(3, y0 + 1, st.tab === 0 ? 'this folder is empty' : 'nothing to show', C.slate);

    // what is selected, and the keys
    const s = selected();
    if (s) {
      let t = put(1, H - 2, s.name, C.white, null, true, W - 30);
      t = put(t + 2, H - 2, unit(s.v), C.yellow, null, true);
      const note = s.fold ? 'enter opens the small items'
        : st.tab === 0 ? (s.tag === 'safe' ? 'cmac marks this removable: rebuilt on demand' : s.tag === 'ask' ? 'large personal data: look inside before removing' : s.tag === 'held' ? 'held for undo; `cmac purge` frees it' : s.dir ? 'folder' : 'file')
          : st.tab === 3 ? 'macOS does not report GPU use per process without admin rights'
            : s.group ? `${s.kids.length} process(es)` : `pid ${s.pid}   ${fmt(s.rss)}   ${s.cpu.toFixed(1)}% cpu`;
      put(t + 2, H - 2, note, C.slate);
    }
    x = keycap(1, H - 1, 'tab');
    x = put(x + 1, H - 1, st.tab === 0 ? 'review and remove' : st.tab === 3 ? 'nothing to act on' : 'quit it', C.white, null, true);
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
    fill(x0, y0, x0 + w, y0 + h, C.panel);
    fill(x0, y0, x0 + w, y0 + 1, m.danger ? C.red : C.pink);
    put(x0 + 2, y0, m.title, C.ink, null, true, x0 + w - 2);
    body.forEach((l, i) => put(x0 + 2, y0 + 2 + i, l, C.white, null, false, x0 + w - 2));
    let x = x0 + 2;
    const y = y0 + h - 2;
    if (m.busy) put(x, y, `${'⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'[st.spin % 10]} ${m.busy}`, C.pink);
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
    if (st.tab === 0 && s.dir && !s.fold) {
      if (!openDir(s)) return;
    } else if (!s.kids) { say('slate', `${s.name} has nothing inside to open`); return; }
    st.stack[st.tab].push(s);
    st.sel[st.tab] = 0;
  }
  function up() {
    if (st.stack[st.tab].length > 1) {
      if (st.tab === 0 && node().loading) { for (const c of du) c.kill(); du = new Set(); node().loading = false; }
      st.stack[st.tab].pop();
      st.sel[st.tab] = 0;
    }
  }
  function forget(n) {
    const chain = st.stack[0];
    for (const a of chain) {
      a.v = Math.max(0, (a.v || 0) - n.v);
      if (a.kids) a.kids = a.kids.filter((k) => k !== n);
    }
  }

  async function reviewThen(titleText, todo, after) {
    st.modal = { title: titleText, lines: ['Nothing has been removed yet.'], busy: `asking ${safeReviewer()} for a review` };
    draw();
    let text;
    try { text = await ctx.review(todo); } catch (e) { text = `The review did not run: ${e.message}`; }
    if (!st.modal) return;
    const fixed = todo.filter((i) => !i.paths).length;
    st.modal = {
      title: titleText,
      lines: [...text.split('\n'), '', fixed ? `${todo.length - fixed} item(s) move to ${HOLD} and come back with u (undo). ${fixed} run a command that cannot be undone.`
        : `It moves to ${HOLD} and comes back with u (undo). Disk space is freed only by \`cmac purge\`.`],
      action: fixed ? 'remove' : 'move to the holding folder',
      run: () => {
        const r = ctx.apply(todo);
        st.modal = null;
        if (r.failed.length) say('red', `failed: ${r.failed[0].label}: ${r.failed[0].error}`);
        else say('green', `removed ${r.done.length} item(s); u puts ${r.moved.length ? 'them' : 'nothing'} back`);
        after(r);
      },
    };
    draw();
  }
  function safeReviewer() { try { return ctx.reviewer(); } catch { return 'a model'; } }

  function act() {
    const s = selected();
    if (!s) return;
    if (st.tab === 0) {
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
    if (st.tab === 3) return say('slate', 'nothing to act on here');
    const pids = s.group ? s.kids.map((k) => k.pid) : [s.pid];
    const label = s.group ? s.name : s.name;
    if (pids.some((p) => mine.has(p))) return say('yellow', `${label} is the terminal this is running in`);
    if (VITAL.has(s.group ? s.name : s.name.replace(/ \d+$/, ''))) return say('yellow', `${label} is part of macOS itself; quitting it logs you out or restarts it`);
    st.modal = {
      title: `Quit ${label}`,
      danger: true,
      lines: [s.group ? `${s.kids.length} process(es) using ${unit(s.v)}.` : `One process using ${unit(s.v)}.`,
        s.app ? 'The app is asked to quit, as if you chose Quit from its menu. It may ask to save open documents.'
          : 'The process is sent the terminate signal. Unsaved work in it is lost, and a service may be restarted by the system right away.',
        'This cannot be undone.'],
      action: 'quit it',
      run: () => {
        st.modal = null;
        if (s.app) ctx.runSync('/usr/bin/osascript', ['-e', `tell application ${JSON.stringify(s.name)} to quit`]);
        else {
          let failed = 0;
          for (const p of pids) { try { process.kill(p, 'SIGTERM'); } catch { failed++; } }
          if (failed) return say('red', `${failed} of ${pids.length} could not be signalled (not yours, or already gone)`);
        }
        say('green', `asked ${label} to quit`);
        setTimeout(() => loadProcs().then(schedule), 1200);
      },
    };
  }

  function cleanRemovable() {
    if (!st.removable.length) return say('slate', 'cmac found nothing it marks removable');
    reviewThen(`Clean ${st.removable.length} item(s) cmac marks removable`, st.removable, () => { rescan(); diskRoot(); });
  }
  function rescan() {
    ctx.scan({ live: false }).then((items) => {
      st.rules = new Map();
      for (const i of items) for (const p of (i.paths && i.paths.length <= 50 ? i.paths : [])) st.rules.set(p, i);
      for (const i of items) if (i.id.startsWith('review:')) st.rules.set(path.join(HOME, i.id.slice(7)), i);
      st.removable = items.filter((i) => i.tier === 'safe' && (i.paths || i.command));
      for (const n of st.stack[0]) for (const k of n.kids || []) k.tag = tagOf(k.path);
      schedule();
    });
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
    if (i === 1 || i === 2) loadProcs().then(schedule);
    if (i === 3) loadGpu().then(schedule);
  }

  function click(x, y) {
    for (const [i, [x0, x1, ty]] of st.tabsAt.entries()) if (y === ty && x >= x0 && x < x1) return switchTab(i);
    const i = st.rects.findIndex((r) => x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1);
    if (i < 0) return;
    if (i === st.sel[st.tab]) open();
    else { st.sel[st.tab] = i; say('slate', 'click again or press enter to open it   tab acts on it'); }
  }

  // ---------- run ----------
  return new Promise((resolve) => {
    const timers = [];
    const quit = () => {
      timers.forEach(clearInterval);
      for (const c of du) c.kill();
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeAllListeners('data');
      write('\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[?1049l');
      resolve();
    };
    write('\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h');
    stdin.setRawMode(true);
    stdin.resume();
    process.once('exit', () => write('\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[?1049l'));
    process.stdout.on('resize', schedule);

    stdin.on('data', (d) => {
      const k = d.toString();
      const mouse = k.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
      if (k === '\x03') return quit();
      if (st.modal) {
        if (st.modal.busy) { if (k === 'q' || k === '\x1b') st.modal = null; }
        else if (k === '\t' && st.modal.run) st.modal.run();
        else if (k === 'q' || k === '\x1b' || k === '\r') st.modal = null;
        return draw();
      }
      if (mouse) { if (mouse[4] === 'M' && mouse[1] === '0') click(Number(mouse[2]) - 1, Number(mouse[3]) - 1); }
      else if (k === 'q') return quit();
      else if (k === '\t') act();
      else if (k === '\r') open();
      else if (k === '\x7f' || k === '\x1b') up();
      else if (k === '\x1b[A') move(0, -1);
      else if (k === '\x1b[B') move(0, 1);
      else if (k === '\x1b[C') move(1, 0);
      else if (k === '\x1b[D') move(-1, 0);
      else if (k >= '1' && k <= '4') switchTab(Number(k) - 1);
      else if (k === 'c' && st.tab === 0) cleanRemovable();
      else if (k === 'u') { const lines = ctx.undoLatest(); say(...lines[lines.length - 1]); rescan(); diskRoot(); }
      else if (k === 'r') { if (st.tab === 0) { rescan(); diskRoot(); } else switchTab(st.tab); }
      draw();
    });

    diskRoot();
    rescan();
    loadProcs().then(() => loadGpu()).then(schedule);
    timers.push(setInterval(() => {
      st.spin++;
      if ((node() && node().loading) || (st.modal && st.modal.busy)) schedule();
    }, 100));
    timers.push(setInterval(() => {
      if (st.modal) return;
      if (st.tab === 1 || st.tab === 2) loadProcs().then(schedule);
      if (st.tab === 3) loadGpu().then(schedule);
    }, 3000));
    draw();
  });
}
