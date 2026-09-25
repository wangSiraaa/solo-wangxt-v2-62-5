// 排座核心引擎：纯逻辑、可在浏览器 IndexedDB 与 Node 内存库上运行。
// 约定：所有写操作都在单个事务内完成；回调抛错由存储层整体回滚。
import { genId, nowIso } from './store.js';

export const CHAIR_STATUSES = [
  'available', // 可用
  'reserved', // 已预留
  'deployed', // 已布置
  'returned', // 已归还（流转完成，可再次入库；正常流转用 available）
  'fault', // 故障
  'retired', // 停用
  'pending_verification', // 待核验（旧项目占位迁移）
];
export const RESERVATION_ACTIVE = ['reserved', 'deployed'];
export const RESERVATION_DONE = ['released', 'returned'];
export const ASSIGNMENT_ACTIVE = ['seated'];

export class OpError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'OpError';
    this.code = code;
    this.details = details;
  }
}

function requireFound(value, message, code = 'NOT_FOUND') {  if (!value) throw new OpError(code, message);
  return value;
}

function sameProject(entity, projectId, label) {
  if (entity && entity.projectId !== projectId) {
    throw new OpError('PROJECT_MISMATCH', `${label}不属于当前项目`);
  }
}

/**
 * 操作包装器：业务事务回滚后，在独立事务中补写失败审计。
 * 成功操作的审计在业务事务内（与数据同生共死）；失败审计独立持久化，
 * 因此任何一次预约/转移/释放尝试无论成败都可在历史中追溯。
 */
export async function audited(db, projectId, action, actor, fn, detail = null) {
  try {
    return await fn();
  } catch (err) {
    try {
      await db.withTx('readwrite', async (tx) => {
        await tx.repo('audits').put({
          id: genId('aud'), projectId, action, actor: actor || 'system',
          targetType: null, targetId: null, detail,
          ok: false, errorCode: err.code || err.name || 'ERROR',
          at: nowIso(),
        });
      });
    } catch {
      // 审计失败不掩盖原始业务错误
    }
    throw err;
  }
}

async function audit(tx, { projectId, action, actor = 'system', targetType = null, targetId = null, detail = null, ok = true, errorCode = null }) {
  const at = nowIso();
  await tx.repo('audits').put({
    id: genId('aud'),
    projectId,
    action,
    actor,
    targetType,
    targetId,
    detail,
    ok,
    errorCode,
    at,
  });
}

/** 幂等封装：成功结果按 key 保存；执行抛错不保存，可安全重试。 */
async function idempotent(tx, key, request, executor) {
  if (!key) throw new OpError('IDEMPOTENCY_KEY_REQUIRED', '写操作必须提供 idempotencyKey');
  const ops = tx.repo('operations');
  const existing = await ops.get(key);
  if (existing) {
    if (JSON.stringify(existing.request ?? null) !== JSON.stringify(request ?? null)) {
      throw new OpError('IDEMPOTENCY_CONFLICT', `幂等键 ${key} 已被不同请求占用`);
    }
    return { ...(existing.response ?? { ok: true }), idempotentReplay: true };
  }
  const response = await executor();
  await ops.put({ id: key, request, response, at: nowIso() });
  return response;
}

async function loadState(tx, projectId) {
  const [tables, guests, chairs, reservations, assignments, issues] = await Promise.all([
    tx.repo('tables').find((r) => r.projectId === projectId),
    tx.repo('guests').find((r) => r.projectId === projectId),
    tx.repo('chairs').find((r) => r.projectId === projectId),
    tx.repo('reservations').find((r) => r.projectId === projectId),
    tx.repo('assignments').find((r) => r.projectId === projectId),
    tx.repo('issues').find((r) => r.projectId === projectId),
  ]);
  const byId = (list) => new Map(list.map((r) => [r.id, r]));
  return {
    tables,
    guests,
    chairs,
    reservations,
    assignments,
    issues,
    tableById: byId(tables),
    guestById: byId(guests),
    chairById: byId(chairs),
  };
}

export const activeReservations = (rs) => rs.filter((r) => RESERVATION_ACTIVE.includes(r.status));
export const activeAssignments = (as) => as.filter((a) => ASSIGNMENT_ACTIVE.includes(a.status));

function reservationForGuest(reservations, guestId) {
  return activeReservations(reservations).find((r) => r.guestId === guestId) ?? null;
}
function assignmentForGuest(assignments, guestId) {
  return activeAssignments(assignments).find((a) => a.guestId === guestId) ?? null;
}

function tableOccupancy(state, tableId) {
  const resCount = activeReservations(state.reservations).filter((r) => r.tableId === tableId).length;
  const asgCount = activeAssignments(state.assignments).filter((a) => a.tableId === tableId).length;
  return resCount + asgCount;
}

async function openIssue(tx, { projectId, type, reservationId = null, chairId = null, guestId = null, tableId = null, message, blocking = true }) {
  const id = genId('iss');
  await tx.repo('issues').put({
    id, projectId, type, reservationId, chairId, guestId, tableId,
    message, blocking, status: 'open',
    createdAt: nowIso(), resolvedAt: null, resolutionNote: null,
  });
  return id;
}

async function resolveIssues(tx, projectId, predicate, note) {
  const repo = tx.repo('issues');
  const matched = await repo.find((r) => r.projectId === projectId && r.status === 'open' && predicate(r));
  for (const issue of matched) {
    issue.status = 'resolved';
    issue.resolvedAt = nowIso();
    issue.resolutionNote = note ?? null;
    await repo.put(issue);
  }
  return matched.length;
}

async function syncProjectStatus(tx, projectId) {
  const repo = tx.repo('projects');
  const project = await repo.get(projectId);
  if (!project) return;
  const open = await tx.repo('issues').find((r) => r.projectId === projectId && r.status === 'open' && r.blocking);
  project.status = open.length ? 'pending' : 'open';
  project.updatedAt = nowIso();
  await repo.put(project);
}

// ---------- 项目基础数据 ----------

export async function saveProject(db, input = {}, actor = 'system') {
  return db.withTx('readwrite', async (tx) => {
    const repo = tx.repo('projects');
    const at = nowIso();
    let project = input.id ? await repo.get(input.id) : null;
    if (!project) {
      project = {
        id: input.id || genId('proj'),
        name: input.name || '未命名活动',
        eventDate: input.eventDate || null,
        status: 'open',
        createdAt: at,
        updatedAt: at,
      };
    } else {
      project.name = input.name ?? project.name;
      project.eventDate = input.eventDate ?? project.eventDate;
      project.updatedAt = at;
    }
    await repo.put(project);
    await audit(tx, { projectId: project.id, action: 'project.save', actor, targetType: 'project', targetId: project.id });
    return project;
  });
}

export async function createTable(db, { projectId, name, capacity, locked = false, idempotencyKey, actor = 'system' }) {
  const request = { projectId, name, capacity, locked };
  return db.withTx('readwrite', (tx) => idempotent(tx, idempotencyKey, request, async () => {
    await requireFound(await tx.repo('projects').get(projectId), '项目不存在');
    const cap = Number(capacity);
    if (!Number.isInteger(cap) || cap < 1) throw new OpError('BAD_CAPACITY', '桌容量必须为正整数');
    const table = {
      id: genId('tbl'), projectId, name: name || '未命名桌',
      capacity: cap, locked: !!locked, createdAt: nowIso(),
    };
    await tx.repo('tables').put(table);
    await audit(tx, { projectId, action: 'table.create', actor, targetType: 'table', targetId: table.id, detail: { capacity: cap, locked } });
    return { ok: true, table };
  }));
}

export async function setTableLocked(db, { projectId, tableId, locked, idempotencyKey, actor = 'system' }) {
  const request = { projectId, tableId, locked };
  return db.withTx('readwrite', (tx) => idempotent(tx, idempotencyKey, request, async () => {
    const table = await tx.repo('tables').get(tableId);
    requireFound(table, '桌位不存在');
    sameProject(table, projectId, '桌位');
    table.locked = !!locked;
    await tx.repo('tables').put(table);
    await audit(tx, { projectId, action: 'table.lock', actor, targetType: 'table', targetId: tableId, detail: { locked } });
    return { ok: true, table };
  }));
}

export async function createGuest(db, { projectId, name = null, type = 'adult', groupId = null, anonymous = false, idempotencyKey, actor = 'system' }) {
  const request = { projectId, name, type, groupId, anonymous };
  return db.withTx('readwrite', (tx) => idempotent(tx, idempotencyKey, request, async () => {
    await requireFound(await tx.repo('projects').get(projectId), '项目不存在');
    if (!['adult', 'child'].includes(type)) throw new OpError('BAD_GUEST_TYPE', '宾客类型必须是 adult 或 child');
    const guest = {
      id: genId('gst'), projectId,
      name: name || (type === 'child' ? '匿名儿童' : '匿名宾客'),
      anonymous: anonymous || !name,
      type, groupId: groupId || null,
      createdAt: nowIso(),
    };
    await tx.repo('guests').put(guest);
    await audit(tx, { projectId, action: 'guest.create', actor, targetType: 'guest', targetId: guest.id, detail: { type, groupId } });
    return { ok: true, guest };
  }));
}

// ---------- 儿童椅预约 / 转移 / 释放 ----------

export async function reserveChildChair(db, { projectId, guestId, chairId, tableId = null, locked = false, idempotencyKey, actor = 'system' }) {
  const request = { projectId, guestId, chairId, tableId, locked };
  return db.withTx('readwrite', (tx) => idempotent(tx, idempotencyKey, request, async () => {
    const state = await loadState(tx, projectId);
    const guest = state.guestById.get(guestId);
    requireFound(guest, '儿童宾客不存在');
    if (guest.type !== 'child') throw new OpError('NOT_A_CHILD', '只有儿童宾客可以绑定儿童椅');
    const chair = state.chairById.get(chairId);
    requireFound(chair, '儿童椅资源不存在');
    if (chair.status !== 'available') throw new OpError('CHAIR_NOT_AVAILABLE', `椅子 ${chair.label || chair.id} 当前状态为 ${chair.status}，无法预留`, { chairStatus: chair.status });
    if (reservationForGuest(state.reservations, guestId)) {
      throw new OpError('GUEST_ALREADY_RESERVED', '该儿童已有有效儿童椅预约');
    }
    let table = null;
    if (tableId) {
      table = state.tableById.get(tableId);
      requireFound(table, '目标桌不存在');
      if (table.locked) throw new OpError('TABLE_LOCKED', `桌位 ${table.name} 已锁定，不能新增预留`);
      if (tableOccupancy(state, tableId) >= table.capacity) {
        throw new OpError('TABLE_FULL', `桌位 ${table.name} 已满员`);
      }
    }
    const at = nowIso();
    const reservation = {
      id: genId('rsv'), projectId, guestId, chairId, tableId,
      status: 'reserved', locked: !!locked, version: 1,
      createdAt: at, updatedAt: at, releasedAt: null, releaseReason: null,
      history: [{ at, by: actor, action: 'reserve', chairId, tableId }],
    };
    chair.status = 'reserved';
    chair.updatedAt = at;
    await tx.repo('reservations').put(reservation);
    await tx.repo('chairs').put(chair);
    await audit(tx, { projectId, action: 'reservation.reserve', actor, targetType: 'reservation', targetId: reservation.id, detail: { guestId, chairId, tableId, locked } });
    return { ok: true, reservation, chair };
  }));
}

export async function setReservationLocked(db, { projectId, reservationId, locked, idempotencyKey, actor = 'system' }) {
  const request = { projectId, reservationId, locked };
  return db.withTx('readwrite', (tx) => idempotent(tx, idempotencyKey, request, async () => {
    const res = await tx.repo('reservations').get(reservationId);
    requireFound(res, '预约不存在');
    sameProject(res, projectId, '预约');
    if (!RESERVATION_ACTIVE.includes(res.status)) throw new OpError('RESERVATION_NOT_ACTIVE', '只有有效预约可以锁定/解锁');
    res.locked = !!locked;
    res.version += 1;
    res.updatedAt = nowIso();
    res.history.push({ at: res.updatedAt, by: actor, action: locked ? 'lock' : 'unlock' });
    await tx.repo('reservations').put(res);
    await audit(tx, { projectId, action: 'reservation.lock', actor, targetType: 'reservation', targetId: reservationId, detail: { locked } });
    return { ok: true, reservation: res };
  }));
}

/** 批量（可整组）换桌：容量、锁定、关系约束与儿童椅可用性全部在单事务内校验。 */
export async function moveGuestsToTable(db, { projectId, guestIds, toTableId, chairAssignments = {}, idempotencyKey, actor = 'system' }) {
  const request = { projectId, guestIds: [...guestIds].sort(), toTableId, chairAssignments };
  return db.withTx('readwrite', (tx) => idempotent(tx, idempotencyKey, request, async () => {
    if (!Array.isArray(guestIds) || guestIds.length === 0) throw new OpError('NO_GUESTS', '未指定要移动的宾客');
    const state = await loadState(tx, projectId);
    const target = state.tableById.get(toTableId);
    requireFound(target, '目标桌不存在');
    if (target.locked) throw new OpError('TABLE_LOCKED', `桌位 ${target.name} 已锁定，不能换入`);

    const movers = [];
    for (const guestId of guestIds) {
      const guest = state.guestById.get(guestId);
      requireFound(guest, `宾客 ${guestId} 不存在`);
      const res = reservationForGuest(state.reservations, guestId);
      const asg = assignmentForGuest(state.assignments, guestId);
      const fromTableId = res?.tableId ?? asg?.tableId ?? null;
      if (fromTableId === toTableId) throw new OpError('SAME_TABLE', '宾客已在目标桌');
      if (guest.type === 'child' && !res) {
        throw new OpError('NOT_RESERVED', `儿童 ${guest.name} 未绑定儿童椅，不能换桌；请先预留实体椅`);
      }
      if (res?.locked) throw new OpError('RESERVATION_LOCKED', `儿童 ${guest.name} 的预约已锁定，请先解锁或走人工替换`);
      // 关系约束：同组未随本次一起移动、且已坐在其他桌的成员会造成拆分
      if (guest.groupId) {
        const split = state.guests.filter((g) =>
          g.id !== guest.id && g.groupId === guest.groupId && !guestIds.includes(g.id)
          && (reservationForGuest(state.reservations, g.id)?.tableId
            ?? assignmentForGuest(state.assignments, g.id)?.tableId
            ?? null) !== null
          && (reservationForGuest(state.reservations, g.id)?.tableId
            ?? assignmentForGuest(state.assignments, g.id)?.tableId
            ?? null) !== toTableId,
        );
        if (split.length) {
          throw new OpError('GROUP_SPLIT', `换桌会拆散关系组 ${guest.groupId}，请整组一起移动`, { groupId: guest.groupId, splitGuestIds: split.map((g) => g.id) });
        }
      }
      movers.push({ guest, res, asg, fromTableId });
    }

    if (tableOccupancy(state, toTableId) + movers.length > target.capacity) {
      throw new OpError('TABLE_FULL', `目标桌容量不足（需要 ${movers.length} 个位置）`, {
        capacity: target.capacity, occupancy: tableOccupancy(state, toTableId),
      });
    }

    // 本事务内的儿童椅分配池：已预留/故障/停用/待核验均不可用
    const chairPool = state.chairs.filter((c) => c.status === 'available');
    const takeChair = (guest) => {
      const wanted = chairAssignments[guest.id];
      let chair;
      if (wanted) {
        chair = chairPool.find((c) => c.id === wanted);
        if (!chair) throw new OpError('CHAIR_NOT_AVAILABLE', `指定椅子 ${wanted} 不可用或已被本次移动占用`);
      } else {
        chair = chairPool
          .filter((c) => !c.tableId || c.tableId === toTableId)
          .sort((a, b) => a.id.localeCompare(b.id))[0]
          ?? chairPool.sort((a, b) => a.id.localeCompare(b.id))[0];
      }
      if (!chair) throw new OpError('CHAIR_EXHAUSTED', '目标桌无可用儿童椅；原预约完整保留，未做任何改动', { tableId: toTableId });
      chairPool.splice(chairPool.indexOf(chair), 1);
      return chair;
    };

    const at = nowIso();
    const results = [];
    for (const m of movers) {
      if (m.guest.type === 'child') {
        const newChair = takeChair(m.guest);
        const oldChair = state.chairById.get(m.res.chairId);
        if (oldChair && ['reserved', 'deployed'].includes(oldChair.status)) {
          oldChair.status = 'available';
          oldChair.updatedAt = at;
          await tx.repo('chairs').put(oldChair);
        }
        m.res.chairId = newChair.id;
        m.res.tableId = toTableId;
        m.res.status = 'reserved';
        m.res.version += 1;
        m.res.updatedAt = at;
        m.res.history.push({ at, by: actor, action: 'move', fromTableId: m.fromTableId, toTableId, fromChairId: oldChair?.id ?? null, toChairId: newChair.id });
        newChair.status = 'reserved';
        newChair.updatedAt = at;
        await tx.repo('chairs').put(newChair);
        await tx.repo('reservations').put(m.res);
        await audit(tx, { projectId, action: 'reservation.move', actor, targetType: 'reservation', targetId: m.res.id, detail: { guestId: m.guest.id, fromTableId: m.fromTableId, toTableId, toChairId: newChair.id } });
        results.push({ guestId: m.guest.id, reservationId: m.res.id, chairId: newChair.id });
      } else {
        let asg = m.asg;
        if (asg) {
          asg.tableId = toTableId;
          asg.version += 1;
          asg.updatedAt = at;
          asg.history.push({ at, by: actor, action: 'move', fromTableId: m.fromTableId, toTableId });
        } else {
          asg = {
            id: genId('asg'), projectId, guestId: m.guest.id, tableId: toTableId,
            status: 'seated', version: 1, createdAt: at, updatedAt: at,
            history: [{ at, by: actor, action: 'assign', tableId: toTableId }],
          };
        }
        await tx.repo('assignments').put(asg);
        await audit(tx, { projectId, action: 'assignment.move', actor, targetType: 'assignment', targetId: asg.id, detail: { guestId: m.guest.id, fromTableId: m.fromTableId, toTableId } });
        results.push({ guestId: m.guest.id, assignmentId: asg.id });
      }
    }
    return { ok: true, moves: results };
  }));
}

export function moveGuestToTable(db, args) {
  return moveGuestsToTable(db, { ...args, guestIds: [args.guestId], chairAssignments: args.chairId ? { [args.guestId]: args.chairId } : {} });
}

/** 同一桌内人工更换故障/撤回椅子；不动桌卡、不动锁定关系。 */
export async function replaceChair(db, { projectId, reservationId, newChairId, reason = null, idempotencyKey, actor = 'system' }) {
  const request = { projectId, reservationId, newChairId, reason };
  return db.withTx('readwrite', (tx) => idempotent(tx, idempotencyKey, request, async () => {
    const state = await loadState(tx, projectId);
    const res = await tx.repo('reservations').get(reservationId);
    requireFound(res, '预约不存在');
    sameProject(res, projectId, '预约');
    if (!RESERVATION_ACTIVE.includes(res.status)) throw new OpError('RESERVATION_NOT_ACTIVE', '只能为有效预约更换椅子');
    const newChair = state.chairById.get(newChairId);
    requireFound(newChair, '新椅子资源不存在');
    if (newChair.status !== 'available') throw new OpError('CHAIR_NOT_AVAILABLE', `新椅子当前状态为 ${newChair.status}`);
    if (res.tableId && newChair.tableId && res.tableId !== newChair.tableId) {
      throw new OpError('CHAIR_TABLE_MISMATCH', '换椅仅限同一桌；跨桌请使用换桌操作');
    }
    let targetTable = res.tableId;
    if (!res.tableId && newChair.tableId) {
      const table = state.tableById.get(newChair.tableId);
      requireFound(table, '新椅子绑定的桌位不存在');
      if (table.locked) throw new OpError('TABLE_LOCKED', '新椅子所在桌已锁定');
      if (tableOccupancy(state, table.id) >= table.capacity) throw new OpError('TABLE_FULL', '新椅子所在桌已满员');
      targetTable = table.id;
    }
    const at = nowIso();
    const oldChair = state.chairById.get(res.chairId);
    if (oldChair && ['reserved', 'deployed'].includes(oldChair.status)) {
      oldChair.status = 'available';
      oldChair.updatedAt = at;
      await tx.repo('chairs').put(oldChair);
    }
    res.chairId = newChair.id;
    res.tableId = targetTable;
    res.version += 1;
    res.updatedAt = at;
    res.history.push({ at, by: actor, action: 'replace_chair', fromChairId: oldChair?.id ?? null, toChairId: newChair.id, reason });
    newChair.status = res.status === 'deployed' ? 'deployed' : 'reserved';
    newChair.updatedAt = at;
    await tx.repo('reservations').put(res);
    await tx.repo('chairs').put(newChair);
    await resolveIssues(tx, projectId, (i) => i.reservationId === reservationId && i.status === 'open' && ['chair_fault', 'chair_retired'].includes(i.type), '人工已替换椅子');
    await syncProjectStatus(tx, projectId);
    await audit(tx, { projectId, action: 'reservation.replace_chair', actor, targetType: 'reservation', targetId: reservationId, detail: { fromChairId: oldChair?.id ?? null, toChairId: newChair.id, reason } });
    return { ok: true, reservation: res, chair: newChair };
  }));
}

export async function releaseReservation(db, { projectId, reservationId, reason = 'manual_release', idempotencyKey, actor = 'system' }) {
  const request = { projectId, reservationId, reason };
  return db.withTx('readwrite', (tx) => idempotent(tx, idempotencyKey, request, async () => {
    const res = await tx.repo('reservations').get(reservationId);
    requireFound(res, '预约不存在');
    sameProject(res, projectId, '预约');
    if (!RESERVATION_ACTIVE.includes(res.status)) throw new OpError('RESERVATION_NOT_ACTIVE', '预约已结束，无需释放');
    if (res.locked) throw new OpError('RESERVATION_LOCKED', '预约已锁定；请先由人工解锁再撤销');
    const at = nowIso();
    const chair = await tx.repo('chairs').get(res.chairId);
    if (chair && ['reserved', 'deployed'].includes(chair.status)) {
      chair.status = 'available';
      chair.updatedAt = at;
      await tx.repo('chairs').put(chair);
    }
    res.status = 'released';
    res.releasedAt = at;
    res.releaseReason = reason;
    res.version += 1;
    res.updatedAt = at;
    res.history.push({ at, by: actor, action: 'release', reason });
    await tx.repo('reservations').put(res);
    await audit(tx, { projectId, action: 'reservation.release', actor, targetType: 'reservation', targetId: reservationId, detail: { chairId: res.chairId, reason } });
    return { ok: true, reservation: res };
  }));
}

export async function deployReservation(db, { projectId, reservationId, idempotencyKey, actor = 'system' }) {
  const request = { projectId, reservationId };
  return db.withTx('readwrite', (tx) => idempotent(tx, idempotencyKey, request, async () => {
    const res = await tx.repo('reservations').get(reservationId);
    requireFound(res, '预约不存在');
    sameProject(res, projectId, '预约');
    if (res.status !== 'reserved') throw new OpError('NOT_RESERVED_STATE', `当前状态 ${res.status} 不能布置`);
    const chair = await tx.repo('chairs').get(res.chairId);
    requireFound(chair, '椅子资源不存在');
    if (chair.status !== 'reserved') throw new OpError('CHAIR_NOT_AVAILABLE', `椅子当前状态为 ${chair.status}，不能布置`);
    const at = nowIso();
    res.status = 'deployed';
    res.version += 1;
    res.updatedAt = at;
    res.history.push({ at, by: actor, action: 'deploy' });
    chair.status = 'deployed';
    chair.updatedAt = at;
    await tx.repo('reservations').put(res);
    await tx.repo('chairs').put(chair);
    await audit(tx, { projectId, action: 'reservation.deploy', actor, targetType: 'reservation', targetId: reservationId, detail: { chairId: chair.id } });
    return { ok: true, reservation: res, chair };
  }));
}

export async function returnChair(db, { projectId, chairId, idempotencyKey, actor = 'system' }) {
  const request = { projectId, chairId };
  return db.withTx('readwrite', (tx) => idempotent(tx, idempotencyKey, request, async () => {
    const state = await loadState(tx, projectId);
    const chair = state.chairById.get(chairId);
    requireFound(chair, '椅子不存在');
    if (!['reserved', 'deployed'].includes(chair.status)) {
      throw new OpError('CHAIR_NOT_IN_USE', `椅子当前状态为 ${chair.status}，不在使用中`);
    }
    const res = activeReservations(state.reservations).find((r) => r.chairId === chairId);
    const at = nowIso();
    if (res) {
      res.status = 'returned';
      res.version += 1;
      res.updatedAt = at;
      res.history.push({ at, by: actor, action: 'return', chairId });
      await tx.repo('reservations').put(res);
    }
    chair.status = 'available';
    chair.updatedAt = at;
    await tx.repo('chairs').put(chair);
    await audit(tx, { projectId, action: 'chair.return', actor, targetType: 'chair', targetId: chairId, detail: { reservationId: res?.id ?? null } });
    return { ok: true, chair, reservation: res ?? null };
  }));
}

// ---------- 资源状态：故障 / 停用 / 修复 / 核验 ----------

async function markResourceOut(db, { projectId, chairId, targetStatus, issueType, reason, idempotencyKey, actor }) {
  const request = { projectId, chairId, targetStatus, reason };
  return db.withTx('readwrite', (tx) => idempotent(tx, idempotencyKey, request, async () => {
    const state = await loadState(tx, projectId);
    const chair = state.chairById.get(chairId);
    requireFound(chair, '椅子不存在');
    if (chair.status === targetStatus) throw new OpError('ALREADY_IN_STATE', `椅子已处于 ${targetStatus} 状态`);
    if (chair.status === 'retired' || chair.status === 'fault') {
      throw new OpError('CHAIR_UNAVAILABLE', `椅子当前为 ${chair.status}，不能再标记 ${targetStatus}`);
    }
    const res = activeReservations(state.reservations).find((r) => r.chairId === chairId);
    const at = nowIso();
    chair.status = targetStatus;
    chair.updatedAt = at;
    if (targetStatus === 'fault') {
      chair.faultAt = at;
      chair.faultReason = reason || null;
    } else {
      chair.retiredAt = at;
      chair.retireReason = reason || null;
    }
    await tx.repo('chairs').put(chair);
    let issueId = null;
    if (res) {
      // 关键规则：绝不悄悄挪动已锁定/已布置儿童席，只开“方案待处理”问题
      const guest = state.guestById.get(res.guestId);
      issueId = await openIssue(tx, {
        projectId, type: issueType, reservationId: res.id, chairId, guestId: res.guestId, tableId: res.tableId,
        message: `椅子 ${chair.label || chair.id} ${targetStatus === 'fault' ? '故障' : '停用'}：儿童 ${guest?.name ?? res.guestId} 的${res.locked ? '已锁定' : ''}预约保持不动，等待人工替换或撤销`,
        blocking: true,
      });
    }
    await syncProjectStatus(tx, projectId);
    await audit(tx, { projectId, action: targetStatus === 'fault' ? 'chair.fault' : 'chair.retire', actor, targetType: 'chair', targetId: chairId, detail: { reason, reservationId: res?.id ?? null, issueId } });
    return { ok: true, chair, impactedReservation: res ?? null, issueId };
  }));
}

export const markChairFault = (db, args) => markResourceOut(db, { ...args, targetStatus: 'fault', issueType: 'chair_fault' });
export const retireChair = (db, args) => markResourceOut(db, { ...args, targetStatus: 'retired', issueType: 'chair_retired' });

export async function repairChair(db, { projectId, chairId, idempotencyKey, actor = 'system' }) {
  const request = { projectId, chairId };
  return db.withTx('readwrite', (tx) => idempotent(tx, idempotencyKey, request, async () => {
    const state = await loadState(tx, projectId);
    const chair = state.chairById.get(chairId);
    requireFound(chair, '椅子不存在');
    if (chair.status !== 'fault') throw new OpError('NOT_FAULT', `椅子当前为 ${chair.status}，不能修复`);
    const res = activeReservations(state.reservations).find((r) => r.chairId === chairId);
    const at = nowIso();
    // 修复后若预约仍指向该椅，恢复为预约/布置所需状态，不移动任何方案
    chair.status = res ? res.status : 'available';
    chair.faultAt = null;
    chair.faultReason = null;
    chair.updatedAt = at;
    await tx.repo('chairs').put(chair);
    await resolveIssues(tx, projectId, (i) => i.chairId === chairId && i.type === 'chair_fault', '资源已修复，保留原预约');
    await syncProjectStatus(tx, projectId);
    await audit(tx, { projectId, action: 'chair.repair', actor, targetType: 'chair', targetId: chairId, detail: { reservationId: res?.id ?? null } });
    return { ok: true, chair };
  }));
}

export async function verifyChair(db, { projectId, chairId, idempotencyKey, actor = 'system' }) {
  const request = { projectId, chairId };
  return db.withTx('readwrite', (tx) => idempotent(tx, idempotencyKey, request, async () => {
    const state = await loadState(tx, projectId);
    const chair = state.chairById.get(chairId);
    requireFound(chair, '椅子不存在');
    if (chair.status !== 'pending_verification') throw new OpError('NOT_PENDING', `椅子当前为 ${chair.status}，无需核验`);
    const at = nowIso();
    const activeRes = activeReservations(state.reservations).find((r) => r.chairId === chairId);
    // 待核验资源在旧项目迁移时已绑定有效预约：核验通过后回到预约所需状态
    chair.status = activeRes ? activeRes.status : 'available';
    chair.verified = true;
    chair.verifiedAt = at;
    chair.updatedAt = at;
    await tx.repo('chairs').put(chair);
    await resolveIssues(tx, projectId, (i) => i.chairId === chairId && i.type === 'verification_needed', '资源已现场核验');
    await syncProjectStatus(tx, projectId);
    await audit(tx, { projectId, action: 'chair.verify', actor, targetType: 'chair', targetId: chairId });
    return { ok: true, chair };
  }));
}

export async function resolveIssue(db, { projectId, issueId, note, idempotencyKey, actor = 'system' }) {
  const request = { projectId, issueId, note };
  return db.withTx('readwrite', (tx) => idempotent(tx, idempotencyKey, request, async () => {
    const issue = await tx.repo('issues').get(issueId);
    requireFound(issue, '问题不存在');
    sameProject(issue, projectId, '问题');
    issue.status = 'resolved';
    issue.resolvedAt = nowIso();
    issue.resolutionNote = note || '人工处理';
    await tx.repo('issues').put(issue);
    await syncProjectStatus(tx, projectId);
    await audit(tx, { projectId, action: 'issue.resolve', actor, targetType: 'issue', targetId: issueId, detail: { note } });
    return { ok: true, issue };
  }));
}

// ---------- 自动排座（全成或全败） ----------

async function computePlan(tx, projectId) {
  const state = await loadState(tx, projectId);
  const errors = [];
  const warnings = [];
  const infos = [];

  for (const issue of state.issues.filter((i) => i.status === 'open' && i.blocking)) {
    errors.push({ type: 'PLAN_PENDING', message: issue.message, issueId: issue.id });
  }

  // 容量异常巡检（不应出现，出现即拒绝自动排座）
  for (const table of state.tables) {
    const occ = tableOccupancy(state, table.id);
    if (occ > table.capacity) errors.push({ type: 'OVER_CAPACITY', tableId: table.id, message: `${table.name} 已超容量（${occ}/${table.capacity}）` });
  }
  // 被占用资源异常巡检
  for (const chair of state.chairs.filter((c) => ['fault', 'retired'].includes(c.status))) {
    const res = activeReservations(state.reservations).find((r) => r.chairId === chair.id);
    if (res) errors.push({ type: chair.status === 'fault' ? 'CHAIR_FAULT' : 'CHAIR_RETIRED', chairId: chair.id, reservationId: res.id, message: `椅子 ${chair.label || chair.id} ${chair.status === 'fault' ? '故障' : '停用'}但仍被预约占用` });
  }
  for (const chair of state.chairs.filter((c) => c.status === 'pending_verification')) {
    warnings.push({ type: 'PENDING_VERIFICATION', chairId: chair.id, message: `椅子 ${chair.label || chair.id} 待现场核验，自动排座不会分配` });
  }

  const seatedAt = (guestId) => reservationForGuest(state.reservations, guestId)?.tableId
    ?? assignmentForGuest(state.assignments, guestId)?.tableId
    ?? null;

  // 关系组拆分巡检（仅提示，不静默修复）
  const groups = new Map();
  for (const g of state.guests.filter((x) => x.groupId)) {
    if (!groups.has(g.groupId)) groups.set(g.groupId, []);
    groups.get(g.groupId).push(g);
  }
  for (const [groupId, members] of groups) {
    const tables = new Set(members.map((m) => seatedAt(m.id)).filter(Boolean));
    if (tables.size > 1) warnings.push({ type: 'GROUP_SPLIT', groupId, message: `关系组 ${groupId} 当前分散在多张桌，自动排座不会重新挪动已坐成员` });
  }

  // 构造待排单元：未入座宾客，按关系组合并
  const unseated = state.guests.filter((g) => seatedAt(g.id) === null);
  const unitsMap = new Map();
  for (const guest of unseated) {
    const key = guest.groupId || `solo_${guest.id}`;
    if (!unitsMap.has(key)) {
      // 同组已入座成员会把整组钉在原桌
      const seatedMembers = state.guests.filter((g) => g.groupId === guest.groupId).map((m) => ({ g: m, t: seatedAt(m.id) })).filter((x) => x.t);
      let pinnedTableId = null;
      if (guest.groupId && seatedMembers.length) {
        const pinTables = [...new Set(seatedMembers.map((x) => x.t))];
        if (pinTables.length === 1) pinnedTableId = pinTables[0];
      }
      unitsMap.set(key, { key, groupId: guest.groupId || null, guestIds: [], pinnedTableId });
    }
    unitsMap.get(key).guestIds.push(guest.id);
  }
  const units = [...unitsMap.values()].map((u) => ({
    ...u,
    members: u.guestIds.map((id) => state.guestById.get(id)),
  })).map((u) => ({
    ...u,
    size: u.members.length,
    children: u.members.filter((g) => g.type === 'child').length,
  }));

  // 模拟容量与儿童椅分配（不写库）
  const occupancy = new Map(state.tables.map((t) => [t.id, tableOccupancy(state, t)]));
  const availableChairs = state.chairs.filter((c) => c.status === 'available');
  const usedChairIds = new Set();
  const placements = [];

  const sorted = units
    .sort((a, b) => Number(b.pinnedTableId !== null) - Number(a.pinnedTableId !== null))
    .sort((a, b) => b.size - a.size)
    .sort((a, b) => b.children - a.children);

  for (const unit of sorted) {
    if (unit.pinnedTableId && new Set(
      state.guests.filter((g) => g.groupId === unit.groupId).map((m) => seatedAt(m.id)).filter(Boolean),
    ).size > 1) {
      errors.push({ type: 'GROUP_SPLIT', groupId: unit.groupId, message: `关系组 ${unit.groupId} 已拆分，无法自动并入同一桌` });
      continue;
    }
    const candidates = state.tables.filter((t) => {
      if (t.locked) return false; // 锁定桌一律不接受自动新增
      if (unit.pinnedTableId) return t.id === unit.pinnedTableId;
      return true;
    }).filter((t) => (occupancy.get(t.id) ?? 0) + unit.size <= t.capacity)
      .filter((t) => {
        if (!unit.children) return true;
        const sameTable = availableChairs.filter((c) => !usedChairIds.has(c.id) && (!c.tableId || c.tableId === t.id)).length;
        const globalLeft = availableChairs.filter((c) => !usedChairIds.has(c.id)).length;
        return globalLeft >= unit.children && (sameTable >= unit.children || globalLeft >= unit.children);
      })
      .sort((a, b) => (a.capacity - (occupancy.get(a.id) ?? 0)) - (b.capacity - (occupancy.get(b.id) ?? 0)) || a.id.localeCompare(b.id));
    const table = candidates[0];
    if (!table) {
      const reasons = [];
      const lockedCandidates = state.tables.filter((t) => !unit.pinnedTableId || t.id === unit.pinnedTableId).filter((t) => t.locked);
      if (lockedCandidates.length && !unit.pinnedTableId) reasons.push('未锁定桌均不合适');
      if (unit.children && availableChairs.filter((c) => !usedChairIds.has(c.id)).length < unit.children) reasons.push('儿童椅总数不足');
      else if (unit.children) reasons.push('候选桌无足够儿童椅');
      reasons.push('桌容量不足');
      errors.push({ type: 'NO_TABLE', groupId: unit.groupId, guestIds: unit.guestIds, size: unit.size, children: unit.children, message: `无法为 ${unit.members.map((m) => m.name).join('、')} 安排桌位（${reasons.join('；')}）` });
      continue;
    }
    const chairIds = [];
    for (let i = 0; i < unit.children; i += 1) {
      const pool = availableChairs.filter((c) => !usedChairIds.has(c.id));
      const pick = pool.filter((c) => !c.tableId || c.tableId === table.id).sort((a, b) => a.id.localeCompare(b.id))[0]
        ?? pool.sort((a, b) => a.id.localeCompare(b.id))[0];
      if (!pick) {
        errors.push({ type: 'CHAIR_EXHAUSTED', message: '儿童椅数量不足，无法完成自动排座' });
        break;
      }
      usedChairIds.add(pick.id);
      chairIds.push(pick.id);
    }
    occupancy.set(table.id, (occupancy.get(table.id) ?? 0) + unit.size);
    placements.push({ tableId: table.id, guestIds: unit.guestIds, chairIds });
  }

  const ok = errors.length === 0;
  if (unseated.length === 0) infos.push({ type: 'ALL_SEATED', message: '所有宾客已有座位' });
  return { ok, errors, warnings, infos, placements, unseatedCount: unseated.length };
}

export async function diagnoseSeating(db, projectId) {
  return db.withTx('readonly', (tx) => computePlan(tx, projectId));
}

export async function autoArrange(db, { projectId, actor = 'system', idempotencyKey, dryRun = false }) {
  if (dryRun) {
    return db.withTx('readonly', (tx) => computePlan(tx, projectId));
  }
  const request = { projectId, op: 'autoArrange' };
  return db.withTx('readwrite', (tx) => idempotent(tx, idempotencyKey, request, async () => {
    const plan = await computePlan(tx, projectId);
    if (!plan.ok) {
      throw new OpError('PLAN_INVALID', '自动排座诊断未通过，未做任何改动', plan);
    }
    const state = await loadState(tx, projectId);
    const at = nowIso();
    const created = { reservations: 0, assignments: 0 };
    for (const placement of plan.placements) {
      const childGuests = placement.guestIds.map((id) => state.guestById.get(id)).filter((g) => g.type === 'child');
      const adultGuests = placement.guestIds.map((id) => state.guestById.get(id)).filter((g) => g.type === 'adult');
      for (let i = 0; i < childGuests.length; i += 1) {
        const guest = childGuests[i];
        const chairId = placement.chairIds[i];
        const chair = state.chairById.get(chairId);
        const reservation = {
          id: genId('rsv'), projectId, guestId: guest.id, chairId, tableId: placement.tableId,
          status: 'reserved', locked: false, version: 1,
          createdAt: at, updatedAt: at, releasedAt: null, releaseReason: null,
          history: [{ at, by: actor, action: 'auto_reserve', chairId, tableId: placement.tableId }],
        };
        chair.status = 'reserved';
        chair.updatedAt = at;
        await tx.repo('reservations').put(reservation);
        await tx.repo('chairs').put(chair);
        created.reservations += 1;
      }
      for (const guest of adultGuests) {
        await tx.repo('assignments').put({
          id: genId('asg'), projectId, guestId: guest.id, tableId: placement.tableId,
          status: 'seated', version: 1, createdAt: at, updatedAt: at,
          history: [{ at, by: actor, action: 'auto_assign', tableId: placement.tableId }],
        });
        created.assignments += 1;
      }
    }
    await audit(tx, { projectId, action: 'auto.arrange', actor, detail: { placements: plan.placements.length, ...created } });
    return { ok: true, ...plan, created };
  }));
}

// ---------- 旧项目迁移 ----------

export async function migrateLegacyProject(db, legacy, { actor = 'migration', idempotencyKey } = {}) {
  const request = { migration: 'legacy-project', projectId: legacy?.project?.id, legacyProjectId: legacy?.project?.legacyId };
  return db.withTx('readwrite', (tx) => idempotent(tx, idempotencyKey, request, async () => {
    if (!legacy || !legacy.project || legacy.project.id == null) throw new OpError('BAD_LEGACY', '旧项目数据缺少 project.id');
    const projectId = `leg_${legacy.project.id}`;
    const at = nowIso();
    const stats = { tables: 0, guests: 0, chairs: 0, reservations: 0, assignments: 0, issues: 0, placeholderTables: 0 };
    const warnings = [];

    const projectRepo = tx.repo('projects');
    let project = await projectRepo.get(projectId);
    if (!project) {
      project = {
        id: projectId, name: legacy.project.name || '旧项目迁移', eventDate: legacy.project.eventDate || null,
        status: 'open', createdAt: at, updatedAt: at, migratedFrom: 'legacy',
      };
      await projectRepo.put(project);
    }

    const tableIdFor = (legacyTableId) => (legacyTableId == null ? null : `leg_${legacy.project.id}_tbl_${legacyTableId}`);
    const guestIdFor = (legacyGuestId) => `leg_${legacy.project.id}_gst_${legacyGuestId}`;

    // 先统计引用，保证迁移桌保留容量（原容量优先；缺失引用桌按实际人数补建）
    const legacyTables = new Map((legacy.tables ?? []).map((t) => [t.id, t]));
    const referenced = new Map();
    for (const g of legacy.guests ?? []) {
      if (g.tableId != null) referenced.set(g.tableId, (referenced.get(g.tableId) ?? 0) + 1);
    }
    for (const [legacyTableId, refCount] of referenced) {
      if (!legacyTables.has(legacyTableId)) {
        legacyTables.set(legacyTableId, { id: legacyTableId, name: `遗留桌 ${legacyTableId}`, capacity: refCount, locked: false, synthesized: true });
        stats.placeholderTables += 1;
        warnings.push({ type: 'MISSING_LEGACY_TABLE', legacyTableId, message: `旧桌 ${legacyTableId} 缺少定义，已按 ${refCount} 人补建，请核验` });
      }
    }
    for (const t of legacyTables.values()) {
      const id = tableIdFor(t.id);
      const existing = await tx.repo('tables').get(id);
      if (!existing) {
        const cap = Math.max(Number(t.capacity) || referenced.get(t.id) || 1, referenced.get(t.id) ?? 0);
        await tx.repo('tables').put({
          id, projectId, name: t.name || `桌 ${t.id}`,
          capacity: cap, locked: !!t.locked, createdAt: at,
          legacyRef: { tableId: t.id }, synthesized: !!t.synthesized,
        });
        stats.tables += 1;
      }
    }

    // 旧项目里已存在的实体椅入库为可用资源
    for (const c of legacy.childChairs ?? []) {
      const id = `leg_${legacy.project.id}_chr_${c.id}`;
      if (!(await tx.repo('chairs').get(id))) {
        await tx.repo('chairs').put({
          id, projectId, label: c.label || `实体椅 ${c.id}`,
          status: 'available', tableId: tableIdFor(c.tableId) ?? null,
          verified: true, legacyRef: { chairId: c.id, physical: true },
          createdAt: at, updatedAt: at,
        });
        stats.chairs += 1;
      }
    }

    for (const g of legacy.guests ?? []) {
      const id = guestIdFor(g.id);
      const isChild = g.type === 'child' || g.isChild === true;
      if (!(await tx.repo('guests').get(id))) {
        await tx.repo('guests').put({
          id, projectId,
          name: g.name || (isChild ? `匿名儿童(${g.id})` : `匿名宾客(${g.id})`),
          anonymous: !g.name,
          type: isChild ? 'child' : 'adult',
          groupId: g.groupId == null ? null : `leg_${legacy.project.id}_grp_${g.groupId}`,
          createdAt: at, legacyRef: { guestId: g.id },
        });
        stats.guests += 1;
      }
      const targetTableId = tableIdFor(g.tableId);
      const targetTable = targetTableId ? await tx.repo('tables').get(targetTableId) : null;
      if (isChild) {
        const count = Math.max(0, Number(g.childChairPlaceholder ?? (g.needsChildChair === false ? 0 : 1)));
        for (let i = 0; i < count; i += 1) {
          const chairId = `leg_${legacy.project.id}_chr_for_${g.id}_${i}`;
          let chair = await tx.repo('chairs').get(chairId);
          if (!chair) {
            chair = {
              id: chairId, projectId,
              label: `待核验椅（${g.name || `匿名儿童(${g.id})`}）`,
              status: 'pending_verification', tableId: targetTableId,
              verified: false, legacyPlaceholder: true, legacyRef: { guestId: g.id, index: i },
              createdAt: at, updatedAt: at,
            };
            await tx.repo('chairs').put(chair);
            stats.chairs += 1;
            const issueId = await openIssue(tx, {
              projectId, type: 'verification_needed', chairId, guestId: id, tableId: targetTableId,
              message: `旧项目儿童椅占位已迁移为待核验资源（${chair.label}），现场核验后可转可用；容量、锁定与原桌卡保持旧项目行为`,
              blocking: false,
            });
            stats.issues += 1;
            warnings.push({ type: 'PENDING_VERIFICATION', chairId, issueId });
          }
          const reservationId = `leg_${legacy.project.id}_rsv_${g.id}_${i}`;
          if (!(await tx.repo('reservations').get(reservationId))) {
            await tx.repo('reservations').put({
              id: reservationId, projectId, guestId: id, chairId, tableId: targetTableId,
              status: 'reserved', locked: !!(g.locked || targetTable?.locked), version: 1,
              createdAt: at, updatedAt: at, releasedAt: null, releaseReason: null,
              legacyRef: { guestId: g.id, index: i },
              history: [{ at, by: actor, action: 'legacy_migrate', chairId, tableId: targetTableId }],
            });
            stats.reservations += 1;
          }
        }
      } else if (targetTableId) {
        const assignmentId = `leg_${legacy.project.id}_asg_${g.id}`;
        if (!(await tx.repo('assignments').get(assignmentId))) {
          await tx.repo('assignments').put({
            id: assignmentId, projectId, guestId: id, tableId: targetTableId,
            status: 'seated', version: 1, createdAt: at, updatedAt: at,
            lockedByTable: !!targetTable?.locked,
            history: [{ at, by: actor, action: 'legacy_migrate', tableId: targetTableId }],
          });
          stats.assignments += 1;
        }
      }
    }

    await tx.repo('migrations').put({ id: projectId, projectId, at, by: actor, stats, warnings });
    await syncProjectStatus(tx, projectId);
    await audit(tx, { projectId, action: 'legacy.migrate', actor, detail: stats });
    return { ok: true, projectId, stats, warnings };
  }));
}

// ---------- 批量导入导出 ----------

export async function importChairs(db, { projectId, chairs, actor = 'system', idempotencyKey }) {
  const request = { projectId, op: 'importChairs', count: chairs?.length, codes: (chairs ?? []).map((c) => c.id).filter(Boolean).sort() };
  return db.withTx('readwrite', (tx) => idempotent(tx, idempotencyKey, request, async () => {
    await requireFound(await tx.repo('projects').get(projectId), '项目不存在');
    const state = await loadState(tx, projectId);
    const result = { imported: 0, updated: 0, skipped: 0, warnings: [] };
    for (const input of chairs ?? []) {
      const status = input.status || 'available';
      if (!CHAIR_STATUSES.includes(status)) {
        result.skipped += 1;
        result.warnings.push({ id: input.id ?? null, message: `非法状态 ${status}，已跳过` });
        continue;
      }
      if (input.tableId && !state.tableById.has(input.tableId)) {
        result.skipped += 1;
        result.warnings.push({ id: input.id ?? null, message: `绑定桌 ${input.tableId} 不存在，已跳过` });
        continue;
      }
      const at = nowIso();
      let existing = input.id ? await tx.repo('chairs').get(input.id) : null;
      if (existing) {
        sameProject(existing, projectId, '椅子');
        const busy = activeReservations(state.reservations).some((r) => r.chairId === existing.id);
        if (busy) {
          result.skipped += 1;
          result.warnings.push({ id: existing.id, message: '椅子存在有效预约，导入不得改动，已跳过' });
          continue;
        }
        existing.label = input.label ?? existing.label;
        existing.tableId = input.tableId ?? existing.tableId;
        existing.status = status;
        existing.updatedAt = at;
        await tx.repo('chairs').put(existing);
        result.updated += 1;
      } else {
        await tx.repo('chairs').put({
          id: input.id || genId('chr'), projectId,
          label: input.label || `儿童椅 ${(input.code ?? '') || ''}`.trim() || `儿童椅 ${result.imported + 1}`,
          tableId: input.tableId || null, status,
          verified: status !== 'pending_verification',
          createdAt: at, updatedAt: at,
        });
        result.imported += 1;
      }
    }
    await audit(tx, { projectId, action: 'chairs.import', actor, detail: result });
    return { ok: true, ...result };
  }));
}

export async function exportProject(db, projectId) {
  return db.withTx('readonly', async (tx) => {
    const pick = async (name) => tx.repo(name).find((r) => r.projectId === projectId);
    const [project, tables, guests, chairs, reservations, assignments, issues, audits] = await Promise.all([
      tx.repo('projects').get(projectId),
      pick('tables'), pick('guests'), pick('chairs'), pick('reservations'), pick('assignments'),
      pick('issues'), pick('audits'),
    ]);
    return {
      format: 'tracked-child-chair-seating/v1',
      exportedAt: nowIso(),
      project, tables, guests, chairs, reservations, assignments, issues, audits,
    };
  });
}

export async function listAudits(db, { projectId, action = null, limit = 200 } = {}) {
  return db.withTx('readonly', async (tx) => {
    const audits = await tx.repo('audits').find((r) => r.projectId === projectId && (!action || r.action === action));
    return audits.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
  });
}

export async function getBoardState(db, projectId) {
  return db.withTx('readonly', async (tx) => {
    const state = await loadState(tx, projectId);
    const project = await tx.repo('projects').get(projectId);
    return {
      project,
      ...state,
      chairSummary: Object.fromEntries(CHAIR_STATUSES.map((s) => [s, state.chairs.filter((c) => c.status === s).length])),
    };
  });
}
