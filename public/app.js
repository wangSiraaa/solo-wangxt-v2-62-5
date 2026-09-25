'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  projects: [],
  projectId: null,
  projectState: null,
  tableView: [],
  chairs: [],
  issues: [],
  modalResolve: null
};

// ---------- HTTP ----------

async function api(method, pathname, body, { idem = false } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (idem) headers['idempotency-key'] = `ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const res = await fetch(pathname, { method, headers, body: body ? JSON.stringify({ ...body, actor: 'web-ui' }) : undefined });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const err = new Error(data && data.message ? data.message : `HTTP ${res.status}`);
    err.code = data && data.error;
    err.details = data && data.details;
    throw err;
  }
  return data;
}

function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast ${isError ? 'error' : ''}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 3500);
}

const STATUS_LABEL = {
  available: '可用',
  reserved: '已预留',
  deployed: '已布置',
  returned: '已归还',
  faulty: '故障',
  decommissioned: '停用'
};

function chip(status) {
  return `<span class="status-chip status-${status}">${STATUS_LABEL[status] || status}</span>`;
}

// ---------- 项目 ----------

async function loadProjects() {
  state.projects = await api('GET', '/api/projects');
  const sel = $('#projectSelect');
  if (!state.projects.length) {
    const name = prompt('尚无项目。请输入新项目名称：', '现场活动');
    if (name) {
      const p = await api('POST', '/api/projects', { name }, { idem: true });
      state.projects = [p];
    }
  }
  sel.innerHTML = state.projects.map((p) => `<option value="${p.id}">${p.name}（${p.id}）</option>`).join('');
  state.projectId = state.projects[0] && state.projects[0].id;
  sel.value = state.projectId;
  await refreshAll();
}

async function refreshAll() {
  if (!state.projectId) return;
  const [ps, tv, issues] = await Promise.all([
    api('GET', `/api/projects/${state.projectId}`),
    api('GET', `/api/projects/${state.projectId}/table-view`),
    api('GET', `/api/projects/${state.projectId}/issues?status=open`)
  ]);
  state.projectState = ps;
  state.tableView = tv;
  state.issues = issues;
  state.chairs = ps.chairs;
  renderInventory();
  renderTables();
  renderChairs();
  renderIssues();
  if ($('#tab-history').classList.contains('active')) loadHistory();
}

function renderInventory() {
  const inv = state.projectState.inventory;
  $('#invBadge').textContent =
    `总 ${inv.total} · 可用 ${inv.available} · 预留 ${inv.reserved} · 布置 ${inv.deployed} · 归还 ${inv.returned} · 故障 ${inv.faulty} · 停用 ${inv.decommissioned}` +
    (inv.pendingVerification ? ` · 待核验 ${inv.pendingVerification}` : '');
  const n = state.issues.length;
  const badge = $('#issueCount');
  badge.textContent = n;
  badge.classList.toggle('hidden', n === 0);
}

// ---------- 桌位可视化 ----------

function renderTables() {
  const wrap = $('#tableView');
  $('#tablesEmpty').classList.toggle('hidden', state.tableView.length > 0);
  wrap.innerHTML = state.tableView.map((t) => {
    const seats = t.seats.map((s) => seatHtml(s)).join('');
    return `
      <div class="table-card ${t.attentionCount ? 'attention' : ''}">
        <div class="table-head">
          <h3>🍽 ${t.name}</h3>
          ${t.attentionCount ? '<span class="attention-flag">⚠ 有待处理</span>' : ''}
        </div>
        <div class="table-meta">
          容量 ${t.capacity} · 已坐 ${t.used}/${t.capacity} · 儿童席 ${t.childSeats} · 已布置 ${t.deployedChairs}
          · 占用率 ${Math.round(t.occupancyRate * 100)}%
        </div>
        ${seats || '<div class="empty" style="padding:12px">空桌</div>'}
      </div>`;
  }).join('');
  bindSeatActions();
}

function seatHtml(s) {
  const typeTag = s.anonymous
    ? '<span class="type-tag anon">匿名占位</span>'
    : s.guest && s.guest.type === 'child'
      ? '<span class="type-tag child">儿童</span>'
      : '<span class="type-tag adult">成人</span>';
  const chairBlock = s.chair
    ? `${chip(s.chair.status)}
       <span title="实体椅编码">${s.chair.code}</span>
       ${s.chair.verification === 'pending' ? '<span class="status-chip verif-pending">待核验</span>' : ''}
       ${s.chair.deployed ? '📍' : ''}`
    : '<span class="hint">无绑定椅</span>';
  const actionBtns = s.needsAttention
    ? `<button class="tiny warn" data-act="goto-issue" data-seat="${s.seatId}">处理方案</button>`
    : seatActionButtons(s);
  return `
    <div class="seat">
      <span class="card-label">${s.tableCardLabel || '·'}</span>
      <span class="guest">${s.guest ? escapeHtml(s.guest.name) : '（未命名儿童位）'} ${typeTag}</span>
      ${chairBlock}
      ${s.locked ? '<span class="lock" title="已锁定">🔒</span>' : ''}
      <span class="seat-actions">${actionBtns}</span>
    </div>`;
}

function seatActionButtons(s) {
  const btns = [];
  if (s.chair) {
    if (s.chair.status === 'reserved') btns.push(`<button class="tiny" data-act="deploy" data-seat="${s.seatId}">布置</button>`);
    if (s.chair.status === 'deployed') btns.push(`<button class="tiny ghost" data-act="undeploy" data-seat="${s.seatId}">撤场</button>`);
    btns.push(`<button class="tiny ghost" data-act="swap" data-seat="${s.seatId}">换椅</button>`);
    btns.push(`<button class="tiny ghost" data-act="fault" data-chair="${s.chair.id}">故障</button>`);
    btns.push(`<button class="tiny ghost" data-act="withdraw" data-chair="${s.chair.id}">撤回</button>`);
  }
  btns.push(`<button class="tiny ghost" data-act="transfer" data-seat="${s.seatId}">换桌</button>`);
  btns.push(`<button class="tiny ghost" data-act="${s.locked ? 'unlock' : 'lock'}" data-seat="${s.seatId}">${s.locked ? '解锁' : '锁定'}</button>`);
  btns.push(`<button class="tiny danger" data-act="release" data-seat="${s.seatId}">释放</button>`);
  return btns.join('');
}

function bindSeatActions() {
  $$('#tableView button[data-act]').forEach((btn) => {
    btn.addEventListener('click', () => onSeatAction(btn.dataset.act, btn.dataset));
  });
}

async function onSeatAction(act, ds) {
  try {
    if (act === 'deploy') { await api('POST', `/api/seats/${ds.seat}/deploy`, {}, { idem: true }); toast('已布置'); }
    else if (act === 'undeploy') { await api('POST', `/api/seats/${ds.seat}/undeploy`, {}, { idem: true }); toast('已撤场（归还清点）'); }
    else if (act === 'lock') { await api('POST', `/api/seats/${ds.seat}/lock`, {}); toast('席位已锁定'); }
    else if (act === 'unlock') { await api('POST', `/api/seats/${ds.seat}/unlock`, {}); toast('席位已解锁'); }
    else if (act === 'fault') {
      const comment = prompt('故障说明（可留空）：', '');
      await api('POST', `/api/chairs/${ds.chair}/fault`, { comment }, { idem: true });
      toast('已标记故障，绑定席进入待处理');
    } else if (act === 'withdraw') {
      const comment = prompt('撤回/停用原因（可留空）：', '');
      await api('POST', `/api/chairs/${ds.chair}/withdraw`, { comment }, { idem: true });
      toast('资源已撤回，绑定席进入待处理');
    } else if (act === 'release') {
      if (!confirm('释放将结束预约并移除席位卡。已布置椅子会一并撤场归还。确定？')) return;
      await api('POST', `/api/seats/${ds.seat}/release`, { allowUndeploy: true }, { idem: true });
      toast('已释放');
    } else if (act === 'transfer') {
      await transferDialog(ds.seat);
      return;
    } else if (act === 'swap') {
      await swapDialog(ds.seat);
      return;
    } else if (act === 'goto-issue') {
      $$('.tab').find((b) => b.dataset.tab === 'issues').click();
      return;
    }
    await refreshAll();
  } catch (e) {
    toast(`操作失败：${e.message}${e.code ? `（${e.code}）` : ''}`, true);
  }
}

async function transferDialog(seatId) {
  const tables = state.projectState.tables;
  const freeChairs = state.chairs.filter((c) => c.status === 'available' && c.verification === 'verified');
  const answer = await openModal('换桌', `
    <div class="field"><label>目标桌 *</label>
      <select id="f-table">${tables.map((t) => `<option value="${t.id}">${t.name}（容量 ${t.capacity}）</option>`).join('')}</select></div>
    <div class="field"><label>目标椅（儿童席必选；留空则自动取一把可用椅）</label>
      <select id="f-chair"><option value="">自动选择可用椅</option>
        ${freeChairs.map((c) => `<option value="${c.id}">${c.code} ${escapeHtml(c.label || '')}</option>`).join('')}
      </select></div>
    <p class="hint">目标桌满员/关系冲突/无可用椅时，本次换桌整体失败，原预约完整保留。</p>`);
  if (!answer) return;
  await api('POST', `/api/seats/${seatId}/transfer`, {
    targetTableId: $('#f-table').value,
    targetChairId: $('#f-chair').value || null
  }, { idem: true });
  toast('换座成功');
  await refreshAll();
}

async function swapDialog(seatId) {
  const freeChairs = state.chairs.filter((c) => c.status === 'available' && c.verification === 'verified');
  if (!freeChairs.length) return toast('没有可用的替换椅', true);
  const answer = await openModal('同桌换椅', `
    <div class="field"><label>替换为</label>
      <select id="f-chair2">${freeChairs.map((c) => `<option value="${c.id}">${c.code} ${escapeHtml(c.label || '')}</option>`).join('')}</select></div>`);
  if (!answer) return;
  await api('POST', `/api/seats/${seatId}/swap-chair`, { targetChairId: $('#f-chair2').value }, { idem: true });
  toast('已更换实体椅，旧椅归还');
  await refreshAll();
}

// ---------- 椅子资源表 ----------

function renderChairs() {
  const rows = state.chairs.map((c) => {
    const bound = state.projectState.reservations.find((r) => r.id && r.chairId === c.id && r.status === 'active');
    const seat = bound && state.projectState.seats.find((s) => s.id === bound.seatId);
    const table = seat && state.projectState.tables.find((t) => t.id === seat.tableId);
    const actions = [];
    if (c.verification === 'pending') actions.push(`<button class="tiny" data-chair-op="verify" data-id="${c.id}">核验通过</button>`);
    if (c.status === 'faulty') actions.push(`<button class="tiny" data-chair-op="repair" data-id="${c.id}">修复</button>`);
    if (c.status === 'returned' && !bound) actions.push(`<button class="tiny" data-chair-op="checkin" data-id="${c.id}">清点回库</button>`);
    if (!['faulty', 'decommissioned'].includes(c.status)) actions.push(`<button class="tiny ghost" data-chair-op="fault" data-id="${c.id}">故障</button>`);
    if (c.status !== 'decommissioned') actions.push(`<button class="tiny ghost" data-chair-op="withdraw" data-id="${c.id}">撤回</button>`);
    return `<tr>
      <td><strong>${c.code}</strong></td>
      <td>${escapeHtml(c.label || '')}</td>
      <td>${chip(c.status)}</td>
      <td>${c.verification === 'pending' ? '<span class="status-chip verif-pending">待核验</span>' : '已核验'}</td>
      <td>${bound && table ? `${table.name} / ${seat.tableCardLabel || bound.seatId}` : '—'}</td>
      <td>${actions.join(' ')}</td>
    </tr>`;
  }).join('');
  $('#chairRows').innerHTML = rows || '<tr><td colspan="6" class="empty">暂无椅子资源</td></tr>';
  $$('#chairRows button[data-chair-op]').forEach((b) => b.addEventListener('click', async () => {
    try {
      const op = b.dataset.chairOp;
      if (op === 'fault' || op === 'withdraw') {
        const comment = prompt(`${op === 'fault' ? '故障说明' : '撤回原因'}（可留空）：`, '');
        await api('POST', `/api/chairs/${b.dataset.id}/${op}`, { comment }, { idem: true });
        toast(op === 'fault' ? '已标记故障' : '已撤回');
      } else if (op === 'repair') {
        await api('POST', `/api/chairs/${b.dataset.id}/repair`, {}, { idem: true });
        toast('修复完成');
      } else if (op === 'checkin') {
        await api('POST', `/api/chairs/${b.dataset.id}/checkin`, {}, { idem: true });
        toast('已清点回库');
      } else if (op === 'verify') {
        await api('POST', `/api/chairs/${b.dataset.id}/verify`, {}, { idem: true });
        toast('核验通过');
      }
      await refreshAll();
    } catch (e) {
      toast(`${e.code || '错误'}：${e.message}`, true);
    }
  }));
}

// ---------- 自动排座 ----------

async function renderDiagnostics(data) {
  const el = $('#diagResult');
  let html = `<div class="diag-summary">
    <strong>结论：</strong>${data.feasible ? '<span class="diag-ok">全部宾客可排座</span>' : '<span class="diag-bad">存在无法排座的宾客</span>'}
    · 待排 ${data.decisions.length + data.unresolved.length} 人 · 可排 ${data.decisions.length} · 阻塞 ${data.unresolved.length}
    · 剩余可用儿童椅 ${data.freeChairsForRun}
  </div>`;
  html += '<div class="diag-table"><strong>桌位占用推演</strong><table class="grid"><thead><tr><th>桌</th><th>容量</th><th>前排占用</th><th>后排占用</th></tr></thead><tbody>';
  for (const t of data.tables) {
    html += `<tr><td>${t.name}</td><td>${t.capacity}</td><td>${t.occupiedBefore}</td><td>${t.occupiedAfter}</td></tr>`;
  }
  html += '</tbody></table></div>';
  if (data.unresolved.length) {
    html += '<h4>阻塞明细（诊断）</h4>' + data.unresolved.map((u) =>
      `<div class="unresolved-item"><strong>${escapeHtml(u.name)}</strong>（${u.type === 'child' ? '儿童' : '成人'}）：${reasonText(u.reason)}
      <div class="hint">${u.detail.map((d) => `${d.tableId}: ${d.reasons.join(', ')}`).join(' ｜ ')}</div></div>`).join('');
  }
  if (data.decisions.length) {
    html += '<h4>建议排座</h4>' + data.decisions.map((d) =>
      `<div class="decision-item">${escapeHtml(d.name)}（${d.type === 'child' ? '儿童' : '成人'}）→ ${d.tableName}${d.chairId ? ` · 绑定椅 <code>${d.chairId}</code>` : ''}</div>`).join('');
  }
  el.innerHTML = html;
}

function reasonText(code) {
  return {
    NO_AVAILABLE_CHAIR: '没有可用实体儿童椅（禁止抽象占位）',
    ALL_TABLES_FULL: '所有桌已满',
    RELATION_AVOID_BLOCKS_ALL_TABLES: '回避关系导致无法同桌',
    TOGETHER_CANNOT_BE_SATISFIED: '同行关系无法同时满足',
    NO_FEASIBLE_TABLE: '没有满足全部约束的桌位'
  }[code] || code;
}

// ---------- 待处理 ----------

function renderIssues() {
  const wrap = $('#issueList');
  $('#issuesEmpty').classList.toggle('hidden', state.issues.length > 0);
  wrap.innerHTML = state.issues.map((i) => {
    const seat = state.projectState.seats.find((s) => s.id === i.seatId);
    const chair = state.projectState.chairs.find((c) => c.id === i.chairId);
    const freeChairs = state.chairs.filter((c) => c.status === 'available' && c.verification === 'verified');
    return `<div class="issue-card">
      <h4>${i.kind === 'chair_fault' ? '🔧 椅子故障' : '🚫 椅子撤回'} · ${chair ? chair.code : i.chairId}</h4>
      <div class="meta-line">
        席位 ${seat ? (seat.tableCardLabel || i.seatId) : i.seatId}
        ${i.seatLocked ? '· <strong>席位已锁定 🔒</strong>' : ''}
        ${i.chairWasDeployed ? '· 故障前已布置 📍' : ''}
        · ${new Date(i.createdAt).toLocaleString()}
        ${i.note ? '· 备注：' + escapeHtml(i.note) : ''}
      </div>
      <p class="hint">系统不会自动移动该儿童席。请人工选择处理方式：</p>
      <div class="actions">
        <select id="repl-${i.id}">
          <option value="">自动选择可用替换椅</option>
          ${freeChairs.map((c) => `<option value="${c.id}">${c.code} ${escapeHtml(c.label || '')}</option>`).join('')}
        </select>
        <button class="tiny" data-issue-op="replace" data-id="${i.id}">替换为另一实体椅</button>
        <button class="tiny ghost" data-issue-op="keep" data-id="${i.id}" ${i.kind === 'chair_withdrawn' ? 'disabled title="撤回资源不可保留"' : ''}>修复后保留原椅</button>
        <label class="inline"><input type="checkbox" id="force-${i.id}" /> 我确认强制撤销锁定席</label>
        <button class="tiny danger" data-issue-op="revoke" data-id="${i.id}">撤销该儿童席</button>
      </div>
    </div>`;
  }).join('');
  $$('#issueList button[data-issue-op]').forEach((b) => b.addEventListener('click', async () => {
    try {
      const id = b.dataset.id;
      const op = b.dataset.issueOp;
      const body = { resolution: op };
      if (op === 'replace') body.replacementChairId = $(`#repl-${id}`).value || null;
      if (op === 'revoke') body.force = $(`#force-${id}`).checked;
      await api('POST', `/api/issues/${id}/resolve`, body, { idem: true });
      toast('方案已处理');
      await refreshAll();
    } catch (e) {
      toast(`${e.code || '错误'}：${e.message}`, true);
    }
  }));
}

// ---------- 历史 ----------

async function loadHistory() {
  const params = new URLSearchParams();
  if ($('#historyFilter').value) params.set('action', $('#historyFilter').value);
  if ($('#historyResult').value) params.set('result', $('#historyResult').value);
  params.set('limit', '200');
  const data = await api('GET', `/api/projects/${state.projectId}/audit?${params}`);
  $('#historyRows').innerHTML = data.items.map((a) => `
    <tr class="${a.result === 'failed' ? 'failed-row' : ''}">
      <td>${new Date(a.at).toLocaleString()}</td>
      <td>${a.action}</td>
      <td>${a.result === 'failed' ? `<span class="status-chip status-faulty">失败${a.reason ? '：' + a.reason : ''}</span>` : '<span class="status-chip status-available">成功</span>'}</td>
      <td>${a.entityType || ''}${a.entityId ? '/' + a.entityId : ''}</td>
      <td>${escapeHtml(a.actor)}</td>
      <td><code>${escapeHtml(JSON.stringify(a.detail))}</code></td>
    </tr>`).join('') || '<tr><td colspan="6" class="empty">暂无记录</td></tr>';
}

// ---------- 迁移 / 导入 ----------

async function doMigrate() {
  try {
    const raw = JSON.parse($('#legacyJson').value);
    const summary = await api('POST', `/api/projects/${state.projectId}/import-legacy`, { legacy: raw }, { idem: true });
    $('#migrateResult').textContent = '迁移完成：\n' + JSON.stringify(summary, null, 2);
    toast('迁移成功：儿童席已绑定待核验实体椅');
    await loadProjects();
  } catch (e) {
    $('#migrateResult').textContent = `迁移失败（已回滚）：${e.code || ''} ${e.message}`;
    toast(`迁移失败：${e.message}`, true);
  }
}

async function doCsvImport(targetProjectId) {
  try {
    const csv = $('#csvText').value;
    const r = await api('POST', `/api/projects/${targetProjectId}/chairs-import`, { csv }, { idem: true });
    toast(`已导入 ${r.imported} 把椅子`);
    await refreshAll();
  } catch (e) {
    toast(`导入失败（整批回滚）：${e.message}`, true);
  }
}

// ---------- 通用弹层 ----------

function openModal(title, bodyHtml) {
  return new Promise((resolve) => {
    $('#modalTitle').textContent = title;
    $('#modalBody').innerHTML = bodyHtml;
    $('#modal').classList.remove('hidden');
    state.modalResolve = (ok) => { $('#modal').classList.add('hidden'); resolve(ok); };
  });
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- 事件绑定 ----------

function bindEvents() {
  $('#projectSelect').addEventListener('change', async (e) => {
    state.projectId = e.target.value;
    await refreshAll();
  });
  $('#refreshBtn').addEventListener('click', refreshAll);
  $$('.tab').forEach((b) => b.addEventListener('click', () => {
    $$('.tab').forEach((x) => x.classList.remove('active'));
    $$('.tab-panel').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    $(`#tab-${b.dataset.tab}`).classList.add('active');
    if (b.dataset.tab === 'history') loadHistory();
  }));
  $('#modalCancel').addEventListener('click', () => state.modalResolve(false));
  $('#modalOk').addEventListener('click', () => state.modalResolve(true));
  $('#addChairBtn').addEventListener('click', async () => {
    const code = prompt('椅子编码（唯一）：', `CH-${Date.now().toString(36).toUpperCase()}`);
    if (!code) return;
    const label = prompt('名称：', code) || code;
    try {
      await api('POST', `/api/projects/${state.projectId}/chairs`, { code, label }, { idem: true });
      toast('椅子已登记为可用');
      await refreshAll();
    } catch (e) { toast(e.message, true); }
  });
  $('#importCsvBtn').addEventListener('click', () => doCsvImport(state.projectId));
  $('#exportCsvBtn').addEventListener('click', () => {
    window.location = `/api/projects/${state.projectId}/chairs?format=csv`;
  });
  $('#diagnoseBtn').addEventListener('click', async () => {
    try { renderDiagnostics(await api('POST', `/api/projects/${state.projectId}/auto-seat/diagnose`, {})); }
    catch (e) { toast(e.message, true); }
  });
  $('#autoSeatBtn').addEventListener('click', async () => {
    try {
      const r = await api('POST', `/api/projects/${state.projectId}/auto-seat`, { allowPartial: $('#allowPartial').checked }, { idem: true });
      renderDiagnostics({ ...r, dryRun: false });
      toast(`自动排座完成：${r.seated} 人，未排 ${r.unresolved.length} 人`);
      await refreshAll();
    } catch (e) {
      toast(`${e.code}：${e.message}（已整体回滚，可先运行诊断）`, true);
      try { renderDiagnostics(await api('POST', `/api/projects/${state.projectId}/auto-seat/diagnose`, {})); } catch {}
    }
  });
  $('#historyRefresh').addEventListener('click', loadHistory);
  $('#migrateBtn').addEventListener('click', doMigrate);
  $('#csvImportBtn').addEventListener('click', () => doCsvImport(state.projectId));
}

bindEvents();
loadProjects().catch((e) => toast(`初始化失败：${e.message}`, true));
