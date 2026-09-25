import { createDb } from '../core/store.js';
import * as engine from '../core/engine.js';

const ACTOR = '现场操作员';
const STATUS_LABEL = {
  available: '可用',
  reserved: '已预留',
  deployed: '已布置',
  returned: '已归还',
  fault: '故障',
  retired: '停用',
  pending_verification: '待核验',
};
const ACTION_LABEL = {
  'reservation.reserve': '预留儿童椅',
  'reservation.move': '换桌（儿童）',
  'assignment.move': '换桌（成人）',
  'reservation.replace_chair': '人工换椅',
  'reservation.release': '撤销预留',
  'reservation.deploy': '现场布置',
  'reservation.lock': '锁定/解锁预约',
  'chair.return': '归还椅子',
  'chair.fault': '标记故障',
  'chair.retire': '停用椅子',
  'chair.repair': '修复椅子',
  'chair.verify': '核验椅子',
  'auto.arrange': '自动排座',
  'legacy.migrate': '旧项目迁移',
  'chairs.import': '批量导入椅子',
  'issue.resolve': '问题处理',
};

const db = createDb();
const state = { projectId: localStorage.getItem('projectId') || null, board: null, tab: 'board' };

const idKey = () => (crypto?.randomUUID ? crypto.randomUUID() : `k_${Date.now()}_${Math.random().toString(36).slice(2)}`);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(message, kind = '') {
  const el = document.querySelector('#toast');
  el.textContent = message;
  el.className = `toast ${kind === 'error' ? 'error' : ''}`;
  setTimeout(() => el.classList.add('hidden'), kind === 'error' ? 5000 : 2500);
  el.classList.remove('hidden');
}

function ask({ title, fields = [], confirmText = '确认' }) {
  return new Promise((resolve) => {
    const modal = document.querySelector('#modal');
    document.querySelector('#modalTitle').textContent = title;
    document.querySelector('#modalConfirm').textContent = confirmText;
    document.querySelector('#modalBody').innerHTML = fields.map((f) => {
      const common = `name="${esc(f.name)}" ${f.required ? 'required' : ''}`;
      if (f.type === 'select') {
        return `<label class="field"><span>${esc(f.label)}</span><select ${common}>${f.options.map((o) => `<option value="${esc(o.value)}" ${o.value === f.value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select></label>`;
      }
      if (f.type === 'textarea') {
        return `<label class="field"><span>${esc(f.label)}</span><textarea rows="${f.rows || 5}" ${common}>${esc(f.value ?? '')}</textarea></label>`;
      }
      return `<label class="field"><span>${esc(f.label)}</span><input type="${f.type || 'text'}" ${common} value="${esc(f.value ?? '')}" /></label>`;
    }).join('');
    modal.returnValue = '';
    modal.showModal();
    modal.addEventListener('close', function onClose() {
      modal.removeEventListener('close', onClose);
      if (modal.returnValue !== 'confirm') return resolve(null);
      const data = {};
      for (const f of fields) {
        const input = modal.querySelector(`[name="${f.name}"]`);
        data[f.name] = f.type === 'number' ? Number(input.value) : input.value;
      }
      resolve(data);
    });
  });
}

async function call(label, projectId, action, fn, detail = null) {
  try {
    const result = await engine.audited(db, projectId, action, ACTOR, fn, detail);
    toast(`${label}成功`);
    return result;
  } catch (err) {
    toast(`${label}失败：${err.message}（事务已回滚，数据未改动）`, 'error');
    console.error(err);
    return null;
  }
}

async function refresh() {
  if (state.projectId) {
    state.board = await engine.getBoardState(db, state.projectId);
    if (!state.board.project) {
      state.projectId = null;
      localStorage.removeItem('projectId');
    }
  }
  if (!state.projectId) {
    const dump = await db.dump();
    if (dump.projects.length) {
      state.projectId = dump.projects[0].id;
      localStorage.setItem('projectId', state.projectId);
      state.board = await engine.getBoardState(db, state.projectId);
    }
  }
  render();
}

// ---------- 示例数据 / 导入导出 ----------

async function loadModernSample() {
  const project = await engine.saveProject(db, { name: `周末亲子宴 ${new Date().toLocaleString('zh-CN')}` });
  state.projectId = project.id;
  localStorage.setItem('projectId', project.id);
  const t1 = await engine.createTable(db, { projectId: project.id, name: '向日葵桌', capacity: 4, idempotencyKey: idKey() });
  await engine.createTable(db, { projectId: project.id, name: '小海豚桌', capacity: 6, idempotencyKey: idKey() });
  const g1 = await engine.createGuest(db, { projectId: project.id, name: '王女士', type: 'adult', groupId: 'family-wang', idempotencyKey: idKey() });
  const c1 = await engine.createGuest(db, { projectId: project.id, name: '小宝', type: 'child', groupId: 'family-wang', idempotencyKey: idKey() });
  const c2 = await engine.createGuest(db, { projectId: project.id, name: '小贝', type: 'child', idempotencyKey: idKey() });
  await engine.createGuest(db, { projectId: project.id, type: 'child', idempotencyKey: idKey() }); // 匿名儿童：必须绑定具体资源
  await engine.importChairs(db, { projectId: project.id, chairs: [
    { label: '实体椅 C-01', tableId: t1.table.id }, { label: '实体椅 C-02' },
    { label: '实体椅 C-03' }, { label: '实体椅 C-04' },
  ], idempotencyKey: idKey() });
  const board = await engine.getBoardState(db, project.id);
  const chairs = board.chairs;
  await engine.reserveChildChair(db, { projectId: project.id, guestId: c1.guest.id, chairId: chairs[0].id, tableId: t1.table.id, idempotencyKey: idKey() });
  await engine.reserveChildChair(db, { projectId: project.id, guestId: c2.guest.id, chairId: chairs[1].id, tableId: t1.table.id, idempotencyKey: idKey() });
  await refresh();
  toast('现代示例已载入：两把实体椅已预留，仍有一名匿名儿童待绑定');
}

async function loadLegacySample() {
  const legacy = {
    project: { id: `old${Date.now()}`, name: '旧项目：林府婚礼（迁移预览）' },
    tables: [{ id: 1, name: '家庭主桌（旧锁定）', capacity: 4, locked: true }, { id: 2, name: '好友桌', capacity: 8 }],
    childChairs: [{ id: 7, label: '旧库存实体椅', tableId: 2 }],
    guests: [
      { id: 1, name: '林爸爸', type: 'adult', tableId: 1 },
      { id: 2, name: '林小宝', type: 'child', tableId: 1, childChairPlaceholder: 1 },
      { id: 3, type: 'child', tableId: 2, childChairPlaceholder: 1 },
    ],
  };
  const result = await engine.migrateLegacyProject(db, legacy, { idempotencyKey: idKey() });
  state.projectId = result.projectId;
  localStorage.setItem('projectId', state.projectId);
  await refresh();
  toast('旧项目占位已迁移为“待核验”资源，容量、锁定、原桌卡均保留');
}

function downloadJson(name, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function exportBundleToStoreDump(dump) {
  return {
    projects: dump.project ? [dump.project] : [],
    tables: dump.tables ?? [],
    guests: dump.guests ?? [],
    chairs: dump.chairs ?? [],
    reservations: dump.reservations ?? [],
    assignments: dump.assignments ?? [],
    issues: dump.issues ?? [],
    audits: dump.audits ?? [],
    operations: [],
    migrations: [],
  };
}

// ---------- 渲染 ----------

function statusChip(status) {
  return `<span class="chair-chip status-${status}">${STATUS_LABEL[status] || status}</span>`;
}

function render() {
  renderMeta();
  const view = document.querySelector('#view');
  if (!state.board?.project) {
    view.innerHTML = '<div class="card"><h2>暂无项目</h2><p class="muted">点击右上角“载入现代示例”或“载入旧项目示例”开始。</p></div>';
    return;
  }
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
  if (state.tab === 'board') view.innerHTML = renderBoard();
  if (state.tab === 'resources') view.innerHTML = renderResources();
  if (state.tab === 'diagnose') view.innerHTML = renderDiagnose();
  if (state.tab === 'history') void renderHistory();
}

function renderMeta() {
  const p = state.board?.project;
  document.querySelector('#projectMeta').innerHTML = p
    ? `当前项目：<b>${esc(p.name)}</b> · 状态：${p.status === 'pending' ? '<span class="badge error">方案待处理</span>' : '<span class="badge ok">正常</span>'}${p.migratedFrom ? ' · 旧项目迁移' : ''}`
    : '暂无项目';
}

function seatedAtMap() {
  const map = new Map();
  for (const r of engine.activeReservations(state.board.reservations)) map.set(r.guestId, r.tableId);
  for (const a of engine.activeAssignments(state.board.assignments)) map.set(a.guestId, a.tableId);
  return map;
}

function renderBoard() {
  const b = state.board;
  const seatedAt = seatedAtMap();
  const guestById = new Map(b.guests.map((g) => [g.id, g]));
  const chairById = new Map(b.chairs.map((c) => [c.id, c]));
  const openIssues = b.issues.filter((i) => i.status === 'open');

  const summary = `<div class="summary">
    <div class="card"><h2>椅子池</h2>${Object.entries(b.chairSummary).map(([k, v]) => v ? `<span class="muted">${STATUS_LABEL[k]}</span> <b>${v}</b>　` : '').join('')}</div>
    <div class="card"><h2>宾客</h2><b>${b.guests.length}</b> 人，已入座 <b>${seatedAt.size}</b>，儿童预约 <b>${engine.activeReservations(b.reservations).length}</b></div>
    <div class="card"><h2>待处理</h2><b class="${openIssues.some((i) => i.blocking) ? '' : 'muted'}">${openIssues.filter((i) => i.blocking).length}</b> 个阻断问题，${openIssues.length - openIssues.filter((i) => i.blocking).length} 个提示</div>
  </div>`;

  const issueHtml = openIssues.length ? `<div class="card ${openIssues.some((i) => i.blocking) ? 'pending' : ''}">
    <h2>方案待处理（故障/撤回不移动已锁席，只能人工替换或撤销）</h2>
    ${openIssues.map((i) => `<div class="issue ${i.blocking ? '' : 'nonblocking'}">
      <div>${esc(i.message)}</div>
      <div class="row" style="margin-top:6px">
        ${i.reservationId ? `<button class="small" data-action="replace-for-reservation" data-id="${i.reservationId}">人工替换椅子</button>
        <button class="small danger" data-action="release-reservation" data-id="${i.reservationId}">撤销该预约</button>` : ''}
        ${i.type === 'verification_needed' && i.chairId ? `<button class="small" data-action="verify-chair" data-id="${i.chairId}">现场核验为可用</button>` : ''}
        <button class="small secondary" data-action="resolve-issue" data-id="${i.id}">标记人工已处理</button>
      </div>
    </div>`).join('')}
  </div>` : '';

  const unbound = b.guests.filter((g) => g.type === 'child' && !engine.activeReservations(b.reservations).some((r) => r.guestId === g.id));
  const unboundHtml = unbound.length ? `<div class="card"><h2>待绑定具体椅子资源的儿童（不得使用抽象占位）</h2>
    ${unbound.map((g) => `<div class="row space-between"><span>${g.anonymous ? '<span class="badge warning">匿名儿童</span> ' : ''}${esc(g.name)}${g.groupId ? ` <span class="muted">关系组 ${esc(g.groupId)}</span>` : ''}</span>
    <button class="small primary" data-action="reserve" data-guest="${g.id}">预留实体椅</button></div>`).join('')}</div>` : '';

  const tableCards = b.tables.map((t) => {
    const occ = engine.activeReservations(b.reservations).filter((r) => r.tableId === t.id).length
      + engine.activeAssignments(b.assignments).filter((a) => a.tableId === t.id).length;
    const childSeats = engine.activeReservations(b.reservations).filter((r) => r.tableId === t.id).map((r) => {
      const g = guestById.get(r.guestId);
      const c = chairById.get(r.chairId);
      return `<div class="seat child">
        <div class="row space-between"><span>🧒 ${g?.anonymous ? '<span class="badge warning">匿名</span> ' : ''}${esc(g?.name || r.guestId)} ${r.locked ? '<span class="lock">🔒锁定</span>' : ''}${g?.groupId ? ` <span class="muted">组:${esc(g.groupId)}</span>` : ''}</span>${statusChip(c?.status)}</div>
        <div class="muted">椅子：${esc(c?.label || r.chairId)}</div>
        <div class="row" style="margin-top:6px">
          <button class="small" data-action="move" data-id="${r.id}">换桌</button>
          <button class="small" data-action="replace-for-reservation" data-id="${r.id}">换椅</button>
          ${r.status === 'reserved' ? `<button class="small" data-action="deploy" data-id="${r.id}">布置</button>` : ''}
          <button class="small" data-action="toggle-lock" data-id="${r.id}">${r.locked ? '解锁' : '锁定'}</button>
          <button class="small secondary" data-action="fault-chair" data-id="${r.chairId}">故障</button>
          <button class="small secondary" data-action="retire-chair" data-id="${r.chairId}">停用</button>
          <button class="small danger" data-action="release-reservation" data-id="${r.id}">释放</button>
        </div>
      </div>`;
    }).join('');
    const adultSeats = engine.activeAssignments(b.assignments).filter((a) => a.tableId === t.id).map((a) => {
      const g = guestById.get(a.guestId);
      return `<div class="seat"><div class="row space-between"><span>🧑 ${g?.anonymous ? '<span class="badge warning">匿名</span> ' : ''}${esc(g?.name || a.guestId)}${g?.groupId ? ` <span class="muted">组:${esc(g.groupId)}</span>` : ''}</span>
      <button class="small" data-action="move-adult" data-id="${a.guestId}">换桌</button></div></div>`;
    }).join('');
    return `<div class="card ${t.locked ? 'pending' : ''}">
      <div class="table-shape"></div>
      <div class="row space-between"><h2 style="margin:0">${esc(t.name)} ${t.locked ? '<span class="lock">🔒</span>' : ''}</h2><span class="muted">${occ}/${t.capacity}</span></div>
      <div class="muted" style="margin:4px 0 8px">${t.synthesized ? '<span class="badge warning">迁移补建桌</span> ' : ''}容量 ${t.capacity}　<button class="small" data-action="toggle-table-lock" data-id="${t.id}">${t.locked ? '解锁桌' : '锁定桌'}</button></div>
      <div class="grid">${childSeats}${adultSeats || '<div class="muted">暂无成人席位</div>'}</div>
    </div>`;
  }).join('');

  return `${summary}${issueHtml}<div class="grid board-grid">${tableCards}</div>${unboundHtml}`;
}

function renderResources() {
  const b = state.board;
  const tableName = new Map(b.tables.map((t) => [t.id, t.name]));
  const guestName = new Map(b.guests.map((g) => [g.id, g.name]));
  return `<div class="grid">
    <div class="card"><h2>新增桌位</h2>
      <button class="primary" data-action="add-table">新增桌位</button>
    </div>
    <div class="card"><h2>宾客</h2>
      <div class="row" style="margin-bottom:8px"><button class="primary" data-action="add-guest">新增宾客/匿名儿童</button></div>
      <table><thead><tr><th>姓名</th><th>类型</th><th>关系组</th><th>来源</th></tr></thead><tbody>
      ${b.guests.map((g) => `<tr><td>${g.anonymous ? '<span class="badge warning">匿名</span> ' : ''}${esc(g.name)}</td><td>${g.type === 'child' ? '儿童' : '成人'}</td><td>${esc(g.groupId || '-')}</td><td>${g.legacyRef ? '旧项目迁移' : '新建'}</td></tr>`).join('')}
      </tbody></table>
    </div>
    <div class="card"><h2>儿童椅实体资源（批量导入/导出）</h2>
      <div class="row" style="margin-bottom:8px">
        <button class="primary" data-action="import-chairs-ui">批量导入</button>
        <button class="secondary" data-action="export-chairs">导出椅子 JSON</button>
      </div>
      <p class="muted">导入格式：<code>[{"label":"C-10","tableId":null,"status":"available"}]</code>；待核验：<code>pending_verification</code>。有有效预约的椅子导入时自动跳过。</p>
      <table><thead><tr><th>资源</th><th>状态</th><th>绑定桌</th><th>当前使用</th><th>核验</th><th>操作</th></tr></thead><tbody>
      ${b.chairs.map((c) => {
        const r = engine.activeReservations(b.reservations).find((x) => x.chairId === c.id);
        const actions = c.status === 'fault'
          ? `<button class="small" data-action="repair-chair" data-id="${c.id}">修复</button>`
          : c.status === 'pending_verification'
            ? `<button class="small" data-action="verify-chair" data-id="${c.id}">核验可用</button>`
            : ['available', 'reserved', 'deployed'].includes(c.status)
              ? `<button class="small" data-action="fault-chair" data-id="${c.id}">故障</button><button class="small" data-action="retire-chair" data-id="${c.id}">停用</button>${c.status !== 'available' ? `<button class="small" data-action="return-chair" data-id="${c.id}">归还</button>` : ''}`
              : '<span class="muted">停用</span>';
        return `<tr><td>${esc(c.label)}<div class="muted">${esc(c.id.slice(0, 18))}…</div>${c.legacyPlaceholder ? '<span class="badge warning">旧占位</span>' : ''}</td>
        <td>${statusChip(c.status)}</td><td>${esc(tableName.get(c.tableId) || c.tableId || '-')}</td>
        <td>${r ? esc(guestName.get(r.guestId) || r.guestId) : '-'}</td><td>${c.verified ? '✅' : '<span class="badge warning">待核验</span>'}</td><td><div class="row">${actions}</div></td></tr>`;
      }).join('')}
      </tbody></table>
    </div>
  </div>`;
}

function renderDiagnose() {
  return `<div class="card">
    <h2>自动排座诊断</h2>
    <p class="muted">自动排座在单一事务内同时校验：桌容量、桌/预约锁定、关系组同桌、儿童椅实体不超卖；诊断只读不落库，执行时全成或全败。存在阻断级“方案待处理”时拒绝执行。</p>
    <div class="row">
      <button class="primary" data-action="run-diagnose">运行诊断（只读）</button>
      <button class="secondary" data-action="run-auto">执行自动排座</button>
    </div>
    <div id="diagResult" style="margin-top:12px"><span class="muted">点击“运行诊断”查看排座预案。</span></div>
  </div>`;
}

async function renderHistory() {
  const audits = await engine.listAudits(db, { projectId: state.projectId, limit: 300 });
  const actions = [...new Set(audits.map((a) => a.action))];
  document.querySelector('#view').innerHTML = `<div class="card">
    <h2>历史与审计（成功随业务事务提交，失败独立留痕）</h2>
    <label class="field"><span>按操作过滤</span><select id="auditFilter">
      <option value="">全部操作（${audits.length}）</option>
      ${actions.map((a) => `<option value="${esc(a)}">${esc(ACTION_LABEL[a] || a)}</option>`).join('')}
    </select></label>
    <table><thead><tr><th>时间</th><th>结果</th><th>操作</th><th>操作人</th><th>对象</th><th>详情</th></tr></thead><tbody id="auditRows">
    ${auditRowsHtml(audits)}
    </tbody></table>
  </div>`;
  document.querySelector('#auditFilter').addEventListener('change', (e) => {
    document.querySelector('#auditRows').innerHTML = auditRowsHtml(e.target.value ? audits.filter((a) => a.action === e.target.value) : audits);
  });
}

function auditRowsHtml(audits) {
  return audits.map((a) => `<tr>
    <td class="muted">${new Date(a.at).toLocaleString('zh-CN')}</td>
    <td>${a.ok ? '<span class="badge ok">成功</span>' : `<span class="badge error">失败 ${esc(a.errorCode || '')}</span>`}</td>
    <td>${esc(ACTION_LABEL[a.action] || a.action)}</td><td>${esc(a.actor)}</td>
    <td>${esc(a.targetType || '')} ${esc(a.targetId ? String(a.targetId).slice(0, 16) : '')}</td>
    <td class="muted"><code>${esc(JSON.stringify(a.detail))}</code></td>
  </tr>`).join('');
}

// ---------- 交互动作 ----------

async function reserveChairFor(guestId) {
  const b = state.board;
  const available = b.chairs.filter((c) => c.status === 'available');
  if (!available.length) return toast('没有可用实体椅：无法用抽象占位创建儿童席', 'error');
  const data = await ask({
    title: '为儿童预留实体椅',
    fields: [
      { name: 'chairId', label: '选择具体椅子', type: 'select', required: true, options: available.map((c) => ({ value: c.id, label: `${c.label}${c.tableId ? `（${b.tables.find((t) => t.id === c.tableId)?.name || c.tableId}）` : ''}` })) },
      { name: 'tableId', label: '绑定桌卡（可选，不选则只占用椅子不入桌）', type: 'select', options: [{ value: '', label: '不绑定桌' }, ...b.tables.map((t) => ({ value: t.id, label: `${t.name}（容量 ${t.capacity}）${t.locked ? ' 🔒' : ''}` }))] },
      { name: 'locked', label: '是否同时锁定', type: 'select', options: [{ value: 'false', label: '不锁定' }, { value: 'true', label: '锁定' }] },
    ],
  });
  if (!data) return;
  await call('预留', state.projectId, 'reservation.reserve', () => engine.reserveChildChair(db, {
    projectId: state.projectId, guestId, chairId: data.chairId, tableId: data.tableId || null,
    locked: data.locked === 'true', idempotencyKey: idKey(), actor: ACTOR,
  }));
  await refresh();
}

async function moveReservation(reservationId) {
  const b = state.board;
  const r = b.reservations.find((x) => x.id === reservationId);
  const g = b.guests.find((x) => x.id === r.guestId);
  // 关系组：已同桌的整组一起移动
  const groupMates = g.groupId
    ? b.guests.filter((x) => x.groupId === g.groupId && x.id !== g.id && ((seatedAtMap().get(x.id) ?? null) === r.tableId))
    : [];
  const guestIds = [g.id, ...groupMates.map((x) => x.id)];
  const data = await ask({
    title: groupMates.length ? `换桌（关系约束：整组 ${guestIds.length} 人一起移动）` : '换桌',
    fields: [
      { name: 'tableId', label: '目标桌', type: 'select', required: true, options: b.tables.filter((t) => t.id !== r.tableId).map((t) => ({ value: t.id, label: `${t.name}（容量 ${t.capacity}）${t.locked ? ' 🔒锁定' : ''}` })) },
      { name: 'chairId', label: '儿童椅（留空=自动选可用椅；不足则整单回滚）', type: 'select', options: [{ value: '', label: '自动选择' }, ...b.chairs.filter((c) => c.status === 'available').map((c) => ({ value: c.id, label: c.label }))] },
    ],
  });
  if (!data) return;
  await call('换桌', state.projectId, 'reservation.move', () => engine.moveGuestsToTable(db, {
    projectId: state.projectId, guestIds, toTableId: data.tableId,
    chairAssignments: data.chairId ? { [g.id]: data.chairId } : {}, idempotencyKey: idKey(), actor: ACTOR,
  }));
  await refresh();
}

async function moveAdult(guestId) {
  const b = state.board;
  const g = b.guests.find((x) => x.id === guestId);
  const seatedAt = seatedAtMap();
  const from = seatedAt.get(guestId);
  const groupMates = g.groupId ? b.guests.filter((x) => x.groupId === g.groupId && x.id !== guestId && seatedAt.get(x.id) === from) : [];
  const data = await ask({ title: '成人换桌', fields: [{ name: 'tableId', label: '目标桌', type: 'select', required: true, options: b.tables.filter((t) => t.id !== from).map((t) => ({ value: t.id, label: t.name })) }] });
  if (!data) return;
  await call('换桌', state.projectId, 'assignment.move', () => engine.moveGuestsToTable(db, {
    projectId: state.projectId, guestIds: [guestId, ...groupMates.map((x) => x.id)], toTableId: data.tableId, idempotencyKey: idKey(), actor: ACTOR,
  }));
  await refresh();
}

async function replaceForReservation(reservationId) {
  const b = state.board;
  const r = b.reservations.find((x) => x.id === reservationId);
  if (!r) return toast('找不到预约', 'error');
  const candidates = b.chairs.filter((c) => c.status === 'available' && (!r.tableId || !c.tableId || c.tableId === r.tableId));
  if (!candidates.length) return toast('没有可替换的可用椅（备用椅可先不绑桌）；原预约保持不动', 'error');
  const data = await ask({
    title: '人工替换椅子（不移动桌卡/锁定关系）',
    fields: [
      { name: 'chairId', label: '备用椅', type: 'select', required: true, options: candidates.map((c) => ({ value: c.id, label: c.label })) },
      { name: 'reason', label: '原因' },
    ],
  });
  if (!data) return;
  await call('人工换椅', state.projectId, 'reservation.replace_chair', () => engine.replaceChair(db, {
    projectId: state.projectId, reservationId, newChairId: data.chairId, reason: data.reason, idempotencyKey: idKey(), actor: ACTOR,
  }));
  await refresh();
}

async function chairStatusDialog(chairId, kind) {
  const b = state.board;
  if (kind === 'fault' || kind === 'retire') {
    const data = await ask({ title: kind === 'fault' ? '标记椅子故障' : '停用椅子', fields: [{ name: 'reason', label: '原因（已布置/锁定席不会被移动，只产生待处理项）' }] });
    if (!data) return;
    const action = kind === 'fault' ? 'chair.fault' : 'chair.retire';
    const label = kind === 'fault' ? '标记故障' : '停用';
    await call(label, state.projectId, action, () => (kind === 'fault' ? engine.markChairFault : engine.retireChair)(db, {
      projectId: state.projectId, chairId, reason: data.reason, idempotencyKey: idKey(), actor: ACTOR,
    }));
  }
  if (kind === 'repair') await call('修复', state.projectId, 'chair.repair', () => engine.repairChair(db, { projectId: state.projectId, chairId, idempotencyKey: idKey(), actor: ACTOR }));
  if (kind === 'verify') await call('核验', state.projectId, 'chair.verify', () => engine.verifyChair(db, { projectId: state.projectId, chairId, idempotencyKey: idKey(), actor: ACTOR }));
  if (kind === 'return') await call('归还', state.projectId, 'chair.return', () => engine.returnChair(db, { projectId: state.projectId, chairId, idempotencyKey: idKey(), actor: ACTOR }));
  await refresh();
}

async function showDiagnose(execute) {
  const target = document.querySelector('#diagResult');
  if (execute) {
    const r = await call('自动排座', state.projectId, 'auto.arrange', () => engine.autoArrange(db, { projectId: state.projectId, idempotencyKey: idKey(), actor: ACTOR }));
    if (!r) { target.innerHTML = '<span class="badge error">执行失败</span>'; return; }
    await refresh();
    return;
  }
  const diag = await engine.diagnoseSeating(db, state.projectId);
  const row = (x, cls) => `<div class="badge ${cls}" style="margin:3px">${esc(x.message)}</div>`;
  target.innerHTML = `
    <div>${diag.ok ? '<span class="badge ok">诊断通过，可执行自动排座</span>' : '<span class="badge error">存在阻断问题，执行将被整体回滚</span>'}</div>
    ${diag.errors.map((x) => row(x, 'error')).join('')}${diag.warnings.map((x) => row(x, 'warning')).join('')}${diag.infos.map((x) => row(x, 'info')).join('')}
    <h3 style="margin-top:10px">预案（${diag.placements.length} 组）</h3>
    ${diag.placements.map((p) => {
      const t = state.board.tables.find((x) => x.id === p.tableId);
      return `<div class="seat">${esc(t?.name || p.tableId)}：${p.guestIds.map((id) => esc(state.board.guests.find((g) => g.id === id)?.name || id)).join('、')}${p.chairIds.length ? `；儿童椅 ${p.chairIds.length} 把` : ''}</div>`;
    }).join('') || '<span class="muted">无待排宾客</span>'}`;
}

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action], label.button input[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const id = btn.dataset.id;
  try {
    if (action === 'sample-modern') await loadModernSample();
    if (action === 'sample-legacy') await loadLegacySample();
    if (action === 'export-all' && state.projectId) downloadJson(`seating-project-${Date.now()}.json`, await engine.exportProject(db, state.projectId));
    if (!state.projectId && !['sample-modern', 'sample-legacy'].includes(action)) return;

    if (action === 'add-table') {
      const d = await ask({ title: '新增桌位', fields: [{ name: 'name', label: '桌名', required: true }, { name: 'capacity', label: '容量', type: 'number', value: 8, required: true }] });
      if (d) await call('新增桌位', state.projectId, 'table.create', () => engine.createTable(db, { projectId: state.projectId, name: d.name, capacity: d.capacity, idempotencyKey: idKey(), actor: ACTOR }));
    }
    if (action === 'add-guest') {
      const d = await ask({ title: '新增宾客', fields: [
        { name: 'name', label: '姓名（留空=匿名）' },
        { name: 'type', label: '类型', type: 'select', options: [{ value: 'child', label: '儿童（必须绑定实体椅）' }, { value: 'adult', label: '成人' }] },
        { name: 'groupId', label: '关系组标识（留空=无）' },
      ] });
      if (d) await call('新增宾客', state.projectId, 'guest.create', () => engine.createGuest(db, { projectId: state.projectId, name: d.name, type: d.type, groupId: d.groupId, anonymous: !d.name, idempotencyKey: idKey(), actor: ACTOR }));
    }
    if (action === 'import-chairs-ui') {
      const d = await ask({ title: '批量导入儿童椅', confirmText: '导入', fields: [{ name: 'json', label: 'JSON 数组', type: 'textarea', value: '[\n  {"label":"C-10","tableId":null,"status":"available"}\n]' }] });
      if (d) {
        let chairs;
        try { chairs = JSON.parse(d.json); } catch { return toast('JSON 解析失败', 'error'); }
        const r = await call('批量导入', state.projectId, 'chairs.import', () => engine.importChairs(db, { projectId: state.projectId, chairs, idempotencyKey: idKey(), actor: ACTOR }));
        if (r?.warnings?.length) toast(`导入完成：新增 ${r.imported}，更新 ${r.updated}，跳过 ${r.skipped}`);
      }
    }
    if (action === 'export-chairs') {
      const { chairs } = state.board;
      downloadJson(`child-chairs-${Date.now()}.json`, chairs.map(({ id, label, tableId, status, verified }) => ({ id, label, tableId, status, verified })));
    }
    if (action === 'reserve') await reserveChairFor(btn.dataset.guest);
    if (action === 'move') await moveReservation(id);
    if (action === 'move-adult') await moveAdult(id);
    if (action === 'replace-for-reservation') await replaceForReservation(id);
    if (action === 'deploy') await call('布置', state.projectId, 'reservation.deploy', () => engine.deployReservation(db, { projectId: state.projectId, reservationId: id, idempotencyKey: idKey(), actor: ACTOR }));
    if (action === 'toggle-lock') {
      const r = state.board.reservations.find((x) => x.id === id);
      await call('锁定状态更新', state.projectId, 'reservation.lock', () => engine.setReservationLocked(db, { projectId: state.projectId, reservationId: id, locked: !r.locked, idempotencyKey: idKey(), actor: ACTOR }));
    }
    if (action === 'toggle-table-lock') {
      const t = state.board.tables.find((x) => x.id === id);
      await call('桌位锁定更新', state.projectId, 'table.lock', () => engine.setTableLocked(db, { projectId: state.projectId, tableId: id, locked: !t.locked, idempotencyKey: idKey(), actor: ACTOR }));
    }
    if (action === 'release-reservation') await call('释放预留', state.projectId, 'reservation.release', () => engine.releaseReservation(db, { projectId: state.projectId, reservationId: id, idempotencyKey: idKey(), actor: ACTOR }));
    if (action === 'fault-chair') await chairStatusDialog(id, 'fault');
    if (action === 'retire-chair') await chairStatusDialog(id, 'retire');
    if (action === 'repair-chair') await chairStatusDialog(id, 'repair');
    if (action === 'verify-chair') await chairStatusDialog(id, 'verify');
    if (action === 'return-chair') await chairStatusDialog(id, 'return');
    if (action === 'resolve-issue') {
      const d = await ask({ title: '人工处理说明', fields: [{ name: 'note', label: '处理结果', required: true }] });
      if (d) await call('问题处理', state.projectId, 'issue.resolve', () => engine.resolveIssue(db, { projectId: state.projectId, issueId: id, note: d.note, idempotencyKey: idKey(), actor: ACTOR }));
    }
    if (action === 'run-diagnose') await showDiagnose(false);
    if (action === 'run-auto') await showDiagnose(true);

    await refresh();
  } catch (err) {
    toast(`操作失败：${err.message}`, 'error');
    console.error(err);
  }
});

document.querySelector('#tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tab]');
  if (!btn) return;
  state.tab = btn.dataset.tab;
  void refresh();
});

// 全项目备份导入
document.querySelector('input[data-action="import-all-file"]').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const dump = JSON.parse(await file.text());
    if (!dump.project?.id) throw new Error('备份缺少 project');
    await db.load(exportBundleToStoreDump(dump));
    state.projectId = dump.project.id;
    localStorage.setItem('projectId', state.projectId);
    await refresh();
    toast('备份已导入（IndexedDB 浏览器本地持久化）');
  } catch (err) {
    toast(`导入失败：${err.message}`, 'error');
  } finally {
    e.target.value = '';
  }
});

void refresh();
