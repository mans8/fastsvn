'use strict';

window.onerror = function (m, src, line, col) {
  console.error('[FastSVN]', m, '@', line + ':' + col);
  return false;
};

const $ = (id) => document.getElementById(id);

const state = {
  wcs: [],
  current: null,
  local: [],
  remote: [],
  tab: 'local',
  onlyRisk: false,
  selected: null,
  checked: new Set(),
  diffLines: [],
  busy: false,
  log: [],
  conflictFile: null,
  conflictAccept: 'working',
  renameTarget: null,
  engineReady: false,
};

// ---------- 基础设施 ----------

async function api(path, options) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({ error: '返回内容不是 JSON' }));
  if (!res.ok || data.error) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}

function post(path, body) {
  return api(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

let toastTimer = null;
function toast(message, kind = 'ok') {
  const el = $('toast');
  el.textContent = decodePercent(message);
  el.className = 'toast on ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast ' + kind; }, 3200);
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// svn 报错里的仓库地址是百分号编码的，展示前要还原成中文
function decodePercent(text) {
  return String(text == null ? '' : text).replace(/https?:\/\/[^\s'"，。；、)）\]]+/g, (m) => {
    try { return decodeURIComponent(m); } catch { return m; }
  });
}

function humanTime(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function setStatus(text, isError = false) {
  const el = $('statusText');
  el.className = 'ok' + (isError ? ' err' : '');
  el.innerHTML = `<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 8.5l3.2 3L13 4.5" stroke-linecap="round" stroke-linejoin="round"/></svg>${esc(text)}`;
}

// ---------- 主题 ----------

const THEME_META = [
  { id: 'light', name: '明亮', side: '#FBFCFE', win: '#FFFFFF', accent: '#2C6FD1' },
  { id: 'hc-light', name: '强对比 · 亮', side: '#FFFFFF', win: '#FFFFFF', accent: '#1C55B0' },
  { id: 'dark', name: '深色', side: '#2A2C2F', win: '#323538', accent: '#7DB1F1' },
  { id: 'hc-dark', name: '强对比 · 暗', side: '#141619', win: '#1C1F22', accent: '#82B4FF' },
];

function applyTheme(id) {
  const theme = THEME_META.some((m) => m.id === id) ? id : 'light';
  document.documentElement.setAttribute('data-theme', theme);
  document.querySelectorAll('#themeCards .theme-card').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.theme === theme));
  });
  localStorage.setItem('fastsvn.theme', theme);
}

function renderThemeCards() {
  const box = $('themeCards');
  if (!box) return;
  const current = document.documentElement.getAttribute('data-theme') || 'light';
  box.innerHTML = THEME_META.map((m) => `
    <button class="theme-card" data-theme="${m.id}" aria-pressed="${m.id === current}">
      <span class="theme-swatch" style="background:${m.win}">
        <i style="background:${m.side}"></i>
        <b style="background:${m.accent}"></b>
      </span>
      <span class="tc-name">${esc(m.name)}</span>
    </button>`).join('');
  box.querySelectorAll('.theme-card').forEach((b) => {
    b.addEventListener('click', () => applyTheme(b.dataset.theme));
  });
}

const THEMES = THEME_META.map((m) => m.id);

// ---------- 工作副本 ----------

async function loadWorkingCopies() {
  const data = await api('/api/working-copies');
  state.wcs = data.paths;
  renderSidebar();
  const want = new URLSearchParams(location.search).get('wc');
  if (state.wcs.length && want && state.wcs.includes(want)) {
    await selectWC(want);
  } else if (state.wcs.length && !state.current) {
    await selectWC(state.wcs[0]);
  } else if (!state.wcs.length) {
    $('onboard').hidden = false;
    $('content').hidden = true;
    $('onboard').hidden = false;
    $('content').hidden = true;
    $('btnSync').disabled = true;
    $('btnCommit').disabled = true;
    $('btnLog').disabled = true;
    $('crumb').innerHTML = '<span class="name">FastSVN</span>';
  }
}

function renderSidebar() {
  const list = $('projList');
  list.innerHTML = state.wcs.map((p) => {
    const name = p.split('/').filter(Boolean).pop() || p;
    const isCur = p === state.current;
    const cnt = isCur ? state.local.length : 0;
    const info = isCur && state.info ? state.info : null;
    const meta = info
      ? `${info.branch || 'trunk'} · r${info.revision.toLocaleString('en-US')}`
      : p;
    return `<button class="proj" data-path="${esc(p)}" aria-selected="${isCur}">
      <span class="ico"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M1.8 4.6c0-.6.5-1.1 1.1-1.1h3.3l1.4 1.5h5.5c.6 0 1.1.5 1.1 1.1v6.2c0 .6-.5 1.1-1.1 1.1H2.9c-.6 0-1.1-.5-1.1-1.1V4.6z" stroke-linejoin="round"/></svg></span>
      <span><span class="nm">${esc(name)}</span><span class="meta">${esc(meta)}</span></span>
      ${cnt ? `<span class="cnt">${cnt}</span>` : ''}
    </button>`;
  }).join('');
  list.querySelectorAll('.proj').forEach((el) => {
    el.addEventListener('click', () => selectWC(el.dataset.path));
  });
}

async function selectWC(path) {
  state.current = path;
  state.selected = null;
  state.diffLines = [];
  $('onboard').hidden = true;
  $('content').hidden = false;
  renderSidebar();
  renderRows();
  renderDiff();
  await paintStale();
  await refresh(true);
}

async function addWC(path) {
  const data = await post('/api/working-copies', { path });
  state.wcs = data.paths;
  $('onboard').hidden = true;
  $('btnLog').disabled = false;
  renderSidebar();
  await selectWC(path);
}

$('btnAdd').addEventListener('click', promptAddProject);

function promptAddProject() {
  openInputModal({
    title: '添加项目',
    desc: '填一个 SVN 工作副本的绝对路径，目录里要有 .svn：',
    value: '',
    placeholder: '/Users/you/projects/my-repo',
    onOk: async (value) => {
      if (!value) throw new Error('路径不能为空');
      await addWC(value);
      toast('已添加项目', 'ok');
    },
  });
}

// ---------- 刷新状态 ----------

// 把一份状态数据应用到界面（首次渲染缓存与全量刷新共用）
function applyStatusData(data) {
  state.local = data.local || [];
  state.remote = data.remote || [];
  state.checked = new Set(state.local.filter((f) => f.kind !== 'ignored').map((f) => f.path));
  if (data.info) renderCrumb(data.info);
  renderRows();
  updateCommitCount();
}

// 打开工作副本时先用上次存下的状态渲染，避免白屏等待
async function paintStale() {
  try {
    const data = await api(`/api/status?path=${encodeURIComponent(state.current)}&stale=1`);
    if (!data || !Array.isArray(data.local)) return;
    applyStatusData(data);
    setStatus('正在校验…');
    const first = visibleFiles().find((f) => f.kind === 'modified' && !f.binary) || visibleFiles()[0];
    if (first && !state.selected) await selectFile(first.path);
  } catch { /* 没有缓存就直接走全量 */ }
}

async function refresh(force = true) {
  if (!state.current) return;
  state.busy = true;
  try {
    const qs = new URLSearchParams({ path: state.current, remote: '1' });
    if (force) qs.set('force', '1');
    const data = await api(`/api/status?${qs.toString()}`);
    applyStatusData(data);
    const changed = visibleFiles().find((f) => f.kind === 'modified' && !f.binary)
      || visibleFiles().find((f) => f.kind !== 'unversioned' && !f.binary)
      || visibleFiles()[0];
    if (!state.selected || ![...state.local, ...state.remote].some((f) => f.path === state.selected)) {
      if (changed) await selectFile(changed.path);
    }
    const timing = data.cached ? '缓存命中' : `${data.tookMs} ms`;
    setStatus(`已是最新 · ${timing}`);
  } catch (e) {
    setStatus(e.message, true);
    toast(e.message, 'err');
  } finally {
    state.busy = false;
  }
}

function renderCrumb(info) {
  if (!info) return;
  state.info = info;
  $('btnLog').disabled = false;
  const name = state.current.split('/').filter(Boolean).pop();
  $('crumb').innerHTML = `
    <span class="name">${esc(name)}</span>
    <span class="sep">›</span>
    <span class="sub">${esc(info.branch || 'trunk')}</span>
    <span class="rev">r${info.revision.toLocaleString('en-US')}</span>`;
  renderSidebar();
}

// ---------- 列表 ----------

function visibleFiles() {
  const base = state.tab === 'local' ? state.local
    : state.tab === 'remote' ? state.remote
    : [...state.local, ...state.remote];
  return state.onlyRisk ? base.filter((f) => f.risk) : base;
}

function renderRows() {
  $('tabLocal').textContent = String(state.local.length);
  $('tabRemote').textContent = String(state.remote.length);

  const files = visibleFiles();
  const rows = $('rows');
  if (!files.length) {
    rows.innerHTML = `<div class="empty-hint">${state.busy ? '正在读取…' : '这个筛选下没有文件'}</div>`;
    return;
  }

  rows.innerHTML = files.map((f) => {
    const stat = f.binary
      ? `<span class="flag">${esc(f.risk ? f.risk.text : '二进制')}</span>`
      : (f.added === 0 && f.deleted === 0
        ? `<span class="stat"><span>${f.kind === 'unversioned' ? '待加入' : '—'}</span></span>`
        : `<span class="stat"><span class="a">+${f.added}</span><span class="d">−${f.deleted}</span></span>`);
    const disabled = f.remote || f.kind === 'ignored';
    return `<div class="row" data-path="${esc(f.path)}" title="右键查看更多操作" aria-selected="${state.selected === f.path}" role="row" tabindex="0">
      <input class="cb" type="checkbox" ${disabled ? 'disabled' : ''} ${state.checked.has(f.path) ? 'checked' : ''} aria-label="选择 ${esc(f.name)}">
      <span class="st ${f.kind}">${f.letter}</span>
      <span class="fname"><span class="n">${esc(f.name)}</span><span class="p">${esc(f.dir)}</span></span>
      ${stat}
      <span class="when">${humanTime(f.mtime)}</span>
    </div>`;
  }).join('');

  rows.querySelectorAll('.row').forEach((el) => {
    el.addEventListener('click', (e) => {
      const path = el.dataset.path;
      const cb = el.querySelector('.cb');
      if (e.target === cb) {
        if (cb.checked) state.checked.add(path); else state.checked.delete(path);
        updateCommitCount();
        return;
      }
      selectFile(path);
      const f = [...state.local, ...state.remote].find((x) => x.path === path);
      if (f && f.kind === 'conflicted') openConflict(path);
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectFile(el.dataset.path);
      }
    });
    el.addEventListener('contextmenu', (e) => {
      const f = [...state.local, ...state.remote].find((x) => x.path === el.dataset.path);
      if (!f) return;
      e.preventDefault();
      selectFile(f.path);
      showCtx(e.clientX, e.clientY, f);
    });
  });
}

function updateCommitCount() {
  const n = state.local.filter((f) => state.checked.has(f.path)).length;
  $('cntCommit').textContent = String(n);
  $('btnCommit').disabled = n === 0 || state.busy;
  $('btnSync').disabled = state.busy || !state.current;
}

document.querySelectorAll('#seg button').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('#seg button').forEach((x) => x.setAttribute('aria-selected', 'false'));
    b.setAttribute('aria-selected', 'true');
    state.tab = b.dataset.tab;
    renderRows();
    const first = visibleFiles()[0];
    if (first) selectFile(first.path);
  });
});

$('onlyRisk').addEventListener('change', (e) => {
  state.onlyRisk = e.target.checked;
  renderRows();
  const first = visibleFiles()[0];
  if (first) selectFile(first.path);
});

// ---------- diff ----------

async function selectFile(path) {
  state.selected = path;
  renderRows();
  const file = [...state.local, ...state.remote].find((f) => f.path === path);
  if (!file) return;

  $('diffPath').innerHTML = `<b>${esc(file.name)}</b>  ·  ${esc(file.dir)}`;
  $('diffStat').innerHTML = (file.added || file.deleted)
    ? `<span class="a">+${file.added}</span><span class="d">−${file.deleted}</span>`
    : '';

  if (file.kind === 'deleted') {
    $('code').innerHTML = '<div class="ln note"><span class="t">这个文件已在本地删除，上传后会从服务器移除。</span></div>';
    $('chmap').innerHTML = '';
    return;
  }

  $('code').innerHTML = '<div class="ln note"><span class="t">正在读取差异…</span></div>';
  try {
    const data = await api(`/api/diff?path=${encodeURIComponent(state.current)}&file=${encodeURIComponent(path)}&kind=${file.kind}`);
    if (state.selected !== path) return;
    state.diffLines = data.lines || [];
    if (data.binary) {
      $('code').innerHTML = '<div class="ln note"><span class="t">二进制文件不做逐行对比</span></div>';
      $('chmap').innerHTML = '';
      return;
    }
    renderDiff();
  } catch (e) {
    $('code').innerHTML = `<div class="ln note"><span class="t">${esc(e.message)}</span></div>`;
  }
}

function highlight(text) {
  const t = esc(text);
  return t.split(/("[^"]*")/g).map((p, i) => {
    if (i % 2 === 1) return `<span class="str">${p}</span>`;
    if (/^\s*\/\//.test(p)) return `<span class="cm">${p}</span>`;
    return p.replace(/\b(public|private|class|if|return|throw|new|void|function|const|var|let|import|package)\b/g,
      '<span class="kw">$1</span>');
  }).join('');
}

function renderDiff() {
  const lines = state.diffLines;
  if (!lines.length) {
    $('code').innerHTML = '<div class="ln note"><span class="t">选择一个文件查看它改了什么</span></div>';
    $('chmap').innerHTML = '';
    return;
  }
  const marks = [];
  const html = lines.map((l) => {
    if (l.kind === 'hunk') {
      return `<div class="ln hunk"><span class="o"></span><span class="nn"></span><span class="s"></span><span class="t">${esc(l.text)}</span></div>`;
    }
    const cls = l.kind === 'add' ? 'add' : l.kind === 'del' ? 'del' : '';
    const sym = l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : '';
    if (l.kind !== 'ctx') marks.push(l.kind === 'add' ? 'a' : 'd');
    return `<div class="ln ${cls}"><span class="o">${l.oldNo ?? ''}</span><span class="nn">${l.newNo ?? ''}</span><span class="s">${sym}</span><span class="t">${highlight(l.text)}</span></div>`;
  }).join('');
  $('code').innerHTML = html;

  const total = Math.max(lines.length, 1);
  $('chmap').innerHTML = marks.map((k, i) =>
    `<i class="${k}" style="top:${(3 + (i / total) * 92).toFixed(1)}%"></i>`).join('');
}

// ---------- 提交 ----------

$('btnCommit').addEventListener('click', () => {
  renderCommitSheet();
  $('msg').value = '';
  $('msg').classList.remove('invalid');
  $('scrim').classList.add('on');
  $('sheetCommit').classList.add('on');
  setTimeout(() => $('msg').focus(), 120);
});

function checkedFiles() {
  return state.local.filter((f) => state.checked.has(f.path));
}

function renderCommitSheet() {
  const files = checkedFiles();
  const add = files.reduce((s, f) => s + f.added, 0);
  const del = files.reduce((s, f) => s + f.deleted, 0);
  const risks = files.filter((f) => f.risk);

  $('sFiles').textContent = String(files.length);
  $('sAdd').textContent = '+' + add;
  $('sDel').textContent = '−' + del;
  $('sRisk').textContent = String(risks.length);
  $('sRisk').style.color = risks.length ? 'var(--con)' : 'var(--ink3)';
  $('footCount').textContent = `已选 ${files.length} 个文件`;

  $('balance').innerHTML = `<span class="a" style="flex:${Math.max(add, 1)}"></span><span class="d" style="flex:${Math.max(del, 1)}"></span>`;

  const box = $('warnBox');
  if (risks.length) {
    box.hidden = false;
    $('warnTitle').textContent = `${risks.length} 项需要你确认`;
    $('warnText').innerHTML = risks.map((f) => `<code>${esc(f.name)}</code> ${esc(f.risk.text)}`).join('；') + '。';
  } else {
    box.hidden = true;
  }

  $('miniList').innerHTML = files.map((f) => {
    const right = f.binary ? '二进制'
      : (f.added === 0 && f.deleted === 0 ? '待加入' : `+${f.added} −${f.deleted}`);
    return `<div class="minirow"><span class="st ${f.kind}">${f.letter}</span><span class="n">${esc(f.name)}</span><span class="p">${right}</span></div>`;
  }).join('');

  $('tpl').innerHTML = ['修复下单并发问题', '补充接口文档', '更新品牌资源']
    .map((t) => `<button data-tpl="${esc(t)}">${esc(t)}</button>`).join('');
  $('tpl').querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => { $('msg').value = b.dataset.tpl; $('msg').classList.remove('invalid'); });
  });
}

$('doCommit').addEventListener('click', async () => {
  const msg = $('msg').value.trim();
  if (!msg) {
    $('msg').classList.add('invalid');
    $('msg').placeholder = '请填一句说明，方便同事看懂这次改了什么';
    $('msg').focus();
    return;
  }
  const files = checkedFiles().map((f) => f.path);
  if (!files.length) return toast('没有选择任何文件', 'err');

  $('doCommit').disabled = true;
  try {
    const data = await post('/api/commit', { path: state.current, files, message: msg });
    closeAll();
    setStatus(`已上传 · 版本 r${data.revision}`);
    toast(`已上传 ${files.length} 个文件 · 版本 r${data.revision}`, 'ok');
    await refresh();
  } catch (e) {
    toast(e.message, 'err');
    setStatus(e.message, true);
  } finally {
    $('doCommit').disabled = false;
  }
});

// ---------- 文件写操作：加入 / 忽略 / 重命名 / 删除 / 撤销 ----------

async function doAdd(file) {
  try {
    const d = await post('/api/add', { path: state.current, file: file.path });
    toast(`已加入版本管理：${file.name}`, 'ok');
    setStatus('已加入版本管理');
    await refresh(true);
    return d;
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function doIgnore(file) {
  try {
    const d = await post('/api/ignore', { path: state.current, file: file.path });
    toast(d.already ? '这个文件已经在忽略列表里了' : `已忽略：${file.name}`, 'ok');
    await refresh(true);
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function doDelete(file) {
  const ok = window.confirm(
    `删除「${file.name}」？\n\n` +
    `删除后会在下次上传时从服务器移除。原文件会先备份到本地快照目录，可以恢复。`
  );
  if (!ok) return;
  try {
    const d = await post('/api/delete', { path: state.current, file: file.path });
    toast(d.snapshot ? '已标记删除，原文件已备份可恢复' : '已删除', 'ok');
    setStatus('已标记删除');
    await refresh(true);
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function doRevert(file) {
  const ok = window.confirm(
    `撤销「${file.name}」的本地修改？\n\n` +
    `这些改动会消失，但原文件会先备份到本地快照目录，之后可以恢复。`
  );
  if (!ok) return;
  try {
    const d = await post('/api/revert', { path: state.current, files: [file.path] });
    toast(d.snapshot ? '已撤销修改，原内容已备份可恢复' : '已撤销修改', 'ok');
    setStatus('已撤销修改');
    await refresh(true);
  } catch (e) {
    toast(e.message, 'err');
  }
}

function askRename(file) {
  openInputModal({
    title: '重命名',
    desc: `把「${file.name}」改成新的名字（会保留版本历史）：`,
    value: file.name,
    onOk: async (newName) => {
      if (newName === file.name) return;
      const d = await post('/api/rename', { path: state.current, file: file.path, newName });
      toast(d.unversioned ? `已重命名为 ${newName}` : `已重命名为 ${newName}（历史保留）`, 'ok');
      setStatus('已重命名');
      await refresh(true);
    },
  });
}

// 通用输入弹窗：rename 与 add project 共用，避免依赖 window.prompt（WKWebView 里不可用）
let inputOkHandler = null;

function openInputModal({ title, desc, value = '', placeholder = '', onOk }) {
  inputOkHandler = onOk;
  $('inputTitle').textContent = title;
  $('inputDesc').textContent = desc;
  const f = $('inputField');
  f.value = value;
  f.placeholder = placeholder;
  f.classList.remove('invalid');
  $('inputErr').textContent = '';
  $('scrim').classList.add('on');
  $('modalInput').classList.add('on');
  setTimeout(() => {
    f.focus();
    if (value) {
      const dot = value.lastIndexOf('.');
      const cut = value.includes('/') ? value.length : (dot > 0 ? dot : value.length);
      f.setSelectionRange(0, cut);
    }
  }, 80);
}

function inputInvalid(msg) {
  $('inputErr').textContent = msg;
  $('inputField').classList.add('invalid');
  $('inputField').focus();
}

async function submitInput() {
  const value = $('inputField').value.trim();
  if (!value) return inputInvalid('这里不能为空');
  try {
    await inputOkHandler?.(value);
    closeAll();
  } catch (e) {
    inputInvalid(decodePercent(e.message));
  }
}

$('inputOk').addEventListener('click', submitInput);
$('inputField').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); submitInput(); }
});
$('inputField').addEventListener('input', () => {
  $('inputField').classList.remove('invalid');
  $('inputErr').textContent = '';
});

// ---------- 右键菜单 ----------

function hideCtx() { $('ctxMenu').hidden = true; }

function showCtx(x, y, file) {
  const items = [];
  if (file.kind === 'unversioned') {
    items.push({ label: '加入版本管理', act: () => doAdd(file) });
    items.push({ label: '忽略这个文件', act: () => doIgnore(file) });
  } else if (file.kind === 'conflicted') {
    items.push({ label: '解决冲突…', act: () => openConflict(file.path) });
  } else if (file.kind === 'deleted') {
    items.push({ label: '撤销删除', act: () => doRevert(file) });
  } else {
    items.push({ label: '撤销我的修改', act: () => doRevert(file) });
  }
  items.push({ label: '重命名…', act: () => askRename(file) });
  items.push({ sep: true });
  items.push({ label: '查看提交历史', act: () => openLog() });
  items.push({ label: '删除这个文件…', act: () => doDelete(file), danger: true });

  const menu = $('ctxMenu');
  menu.innerHTML = `<div class="hint">${esc(file.name)}</div>` + items.map((it, i) => (
    it.sep ? '<div class="sep"></div>'
      : `<button data-i="${i}" class="${it.danger ? 'danger' : ''}">${esc(it.label)}</button>`
  )).join('');

  menu.querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const it = items[Number(b.dataset.i)];
      hideCtx();
      if (it && it.act) it.act();
    });
  });

  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
}

document.addEventListener('click', (e) => {
  if (!$('ctxMenu').contains(e.target)) hideCtx();
});
window.addEventListener('blur', hideCtx);

// ---------- 撤销修改（按钮） ----------

$('btnRevert').addEventListener('click', () => {
  const f = state.local.find((x) => x.path === state.selected);
  if (!f) return toast('先选一个文件', 'err');
  doRevert(f);
});

// ---------- 同步 ----------

$('btnSync').addEventListener('click', async () => {
  $('btnSync').disabled = true;
  setStatus('正在同步最新…');
  try {
    const data = await post('/api/update', { path: state.current });
    if (data.conflicts > 0) {
      setStatus(`有 ${data.conflicts} 个文件需要处理冲突`, true);
      openConflict();
    } else {
      setStatus(`已同步 · r${data.revision}`);
      toast(`已同步到 r${data.revision}`, 'ok');
    }
    await refresh();
  } catch (e) {
    toast(e.message, 'err');
    setStatus(e.message, true);
  } finally {
    $('btnSync').disabled = false;
  }
});

// ---------- 冲突 ----------

async function openConflict(filePath) {
  const target = filePath
    ? state.local.find((f) => f.path === filePath)
    : state.local.find((f) => f.kind === 'conflicted');
  if (!target) {
    toast('当前没有冲突文件', 'err');
    return;
  }
  state.conflictFile = target.path;
  state.conflictAccept = 'working';
  $('confChips').querySelectorAll('.chip').forEach((c) => {
    c.setAttribute('aria-pressed', String(c.dataset.accept === 'working'));
  });

  const others = state.local.filter((f) => f.kind === 'conflicted' && f.path !== target.path).length;
  $('confLeft').textContent = others > 0 ? `还有 ${others} 个文件也有冲突` : '';
  $('confDesc').textContent = `${target.path} · 正在读取冲突内容…`;
  $('mineCode').textContent = '…';
  $('theirsCode').textContent = '…';
  $('scrim').classList.add('on');
  $('modalConflict').classList.add('on');

  try {
    const data = await api(`/api/conflict?path=${encodeURIComponent(state.current)}&file=${encodeURIComponent(target.path)}`);
    if (data.count > 0) {
      $('confDesc').textContent = `${target.path} · 有 ${data.count} 处改动落在同一位置。选一个处理方式，或者逐行挑。`;
      $('mineCode').textContent = (data.blocks[0].mine || '（空）').replace(/\s+$/, '');
      $('theirsCode').textContent = (data.blocks[0].theirs || '（空）').replace(/\s+$/, '');
    } else {
      $('confDesc').textContent = `${target.path} · 文件里已经没有冲突标记了，可以直接标记为已解决。`;
      $('mineCode').textContent = '（无冲突标记）';
      $('theirsCode').textContent = '（无冲突标记）';
    }
  } catch (e) {
    $('confDesc').textContent = `${target.path} · ${e.message}`;
    $('mineCode').textContent = '—';
    $('theirsCode').textContent = '—';
  }
}

$('confChips').querySelectorAll('.chip').forEach((c) => {
  c.addEventListener('click', () => {
    $('confChips').querySelectorAll('.chip').forEach((x) => x.setAttribute('aria-pressed', 'false'));
    c.setAttribute('aria-pressed', 'true');
    state.conflictAccept = c.dataset.accept;
  });
});

$('resolveConflict').addEventListener('click', async () => {
  if (!state.conflictFile) return;
  const accept = state.conflictAccept || 'working';
  const btn = $('resolveConflict');
  btn.disabled = true;
  try {
    await post('/api/resolve', { path: state.current, file: state.conflictFile, accept });
    closeAll();
    const label = accept === 'mine-full' ? '已采用你的版本'
      : accept === 'theirs-full' ? '已采用同事的版本'
      : '已标记为已解决';
    toast(label, 'ok');
    setStatus(label);
    await refresh();
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    btn.disabled = false;
  }
});

// ---------- 提交历史 ----------

function relTime(iso) {
  const t = Date.parse(iso);
  if (!t) return '';
  const diff = (Date.now() - t) / 1000;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`;
  return new Date(t).toLocaleDateString('zh-CN');
}

async function openLog() {
  $('scrim').classList.add('on');
  $('sheetLog').classList.add('on');
  $('logBody').innerHTML = '<div class="empty-hint">正在读取提交历史…</div>';
  $('logCount').textContent = '—';
  try {
    const data = await api(`/api/log?path=${encodeURIComponent(state.current)}&verbose=1&limit=50`);
    state.log = data.entries || [];
    renderLog();
  } catch (e) {
    $('logBody').innerHTML = `<div class="empty-hint">${esc(e.message)}</div>`;
  }
}

function renderLog() {
  $('logCount').textContent = `共 ${state.log.length} 次提交`;
  if (!state.log.length) {
    $('logBody').innerHTML = '<div class="empty-hint">还没有任何提交</div>';
    return;
  }
  $('logBody').innerHTML = state.log.map((e) => `
    <div class="logrow" data-rev="${e.revision}" aria-expanded="false">
      <div class="loghead">
        <span class="revchip">r${e.revision}</span>
        <span class="author">${esc(e.author)}</span>
        <span class="when">${relTime(e.date)}</span>
        <span class="msg">${esc((e.message || '(无说明)').split('\n')[0])}</span>
        <span class="caret">▶</span>
      </div>
      <div class="logfiles">
        ${(e.files && e.files.length)
          ? e.files.map((f) => `<div class="logfile"><span class="act ${f.action}">${f.action}</span><span>${esc(f.path)}</span></div>`).join('')
          : '<div class="logfile"><span class="act">—</span><span>（无文件变更记录）</span></div>'}
      </div>
    </div>`).join('');
  $('logBody').querySelectorAll('.logrow').forEach((el) => {
    el.addEventListener('click', () => {
      const open = el.getAttribute('aria-expanded') === 'true';
      el.setAttribute('aria-expanded', String(!open));
    });
  });
}

$('btnLog').addEventListener('click', openLog);

$('btnSettings').addEventListener('click', () => {
  renderThemeCards();
  const eng = $('setEngine');
  if (eng) eng.textContent = state.engineReady ? '已就绪' : '未找到';
  $('scrim').classList.add('on');
  $('modalSettings').classList.add('on');
});

$('btnAddFromEmpty').addEventListener('click', promptAddProject);

// 双击工具栏空白处切换窗口最大化（桌面应用里由原生侧执行）
const toolbarEl = document.querySelector('.toolbar');
if (toolbarEl) {
  toolbarEl.addEventListener('dblclick', (e) => {
    if (e.target.closest('button, input, a, select, .crumb')) return;
    const bridge = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.windowAction;
    if (bridge) bridge.postMessage('zoom');
  });
}
$('btnRefresh').addEventListener('click', () => refresh(true));

// ---------- 弹层控制 ----------

function closeAll() {
  $('scrim').classList.remove('on');
  $('sheetCommit').classList.remove('on');
  $('modalConflict').classList.remove('on');
  $('sheetLog').classList.remove('on');
  $('modalInput').classList.remove('on');
  $('modalSettings').classList.remove('on');
  hideCtx();
}
$('scrim').addEventListener('click', closeAll);
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeAll));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeAll();
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if (state.current) $('btnCommit').click();
  }
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'r') {
    e.preventDefault();
    if (state.current) $('btnSync').click();
  }
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'r') {
    e.preventDefault();
    if (state.current) refresh(true);
  }
});

// ---------- 启动 ----------

(async function boot() {
  const urlTheme = new URLSearchParams(location.search).get('theme');
  applyTheme(urlTheme || localStorage.getItem('fastsvn.theme') || 'light');
  try {
    const h = await api('/api/health');
    if (h.bundled) document.body.classList.add('in-app');
    state.engineReady = !!h.svn;
    $('engineInfo').textContent = h.svn ? 'svn 引擎已就绪' : '未找到 svn';
    renderThemeCards();
    if (!h.svn) toast('没有找到 svn 命令行工具，功能不可用', 'err');
  } catch (e) {
    $('engineInfo').textContent = '无法连接本地服务';
  }
  await loadWorkingCopies();
  updateCommitCount();

  // 便于演示与截图：?panel=commit|conflict|log 直接展开面板
  const params = new URLSearchParams(location.search);
  const panel = params.get('panel');
  if (panel === 'commit' && state.current) $('btnCommit').click();
  if (panel === 'conflict') openConflict();
  if (panel === 'log' && state.current) openLog();

  // ?menu=<文件相对路径> 直接展开该行的右键菜单（也方便截图与人工核对）
  const menuPath = params.get('menu');
  if (menuPath) {
    const f = [...state.local, ...state.remote].find((x) => x.path === menuPath);
    if (f) { selectFile(f.path); showCtx(64, 300, f); }
  }
  // ?dialog=add 直接打开添加项目弹窗
  if (params.get('dialog') === 'add') promptAddProject();
  // ?dialog=settings 直接打开设置面板
  if (params.get('dialog') === 'settings') $('btnSettings').click();
  // ?empty=1 强制展示空状态（便于验证引导页）
  if (params.get('empty') === '1') {
    $('onboard').hidden = false;
    $('content').hidden = true;
  }
  // ?dialog=rename&file=<路径> 直接打开重命名输入框
  if (params.get('dialog') === 'rename') {
    const f = [...state.local, ...state.remote].find((x) => x.path === params.get('file'));
    if (f) askRename(f);
  }
})();
