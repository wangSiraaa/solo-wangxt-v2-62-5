'use strict';

const {
  CHAIR_STATUS,
  CHAIR_FREE_STATUSES,
  RESERVATION_STATUS,
  GUEST_TYPE,
  RELATION
} = require('./constants');
const { DomainError } = require('./errors');

// ---------- 实体查找（带显式错误码） ----------

function mustGet(draft, collection, key, code) {
  const obj = draft[collection] && draft[collection][key];
  if (!obj) throw new DomainError(code || 'NOT_FOUND', `${collection} 不存在: ${key}`, { status: 404, entityType: collection, entityId: key });
  return obj;
}
const mustProject = (d, p) => mustGet(d, 'projects', p, 'PROJECT_NOT_FOUND');
const mustTable = (d, t) => mustGet(d, 'tables', t, 'TABLE_NOT_FOUND');
const mustGuest = (d, g) => mustGet(d, 'guests', g, 'GUEST_NOT_FOUND');
const mustSeat = (d, s) => mustGet(d, 'seats', s, 'SEAT_NOT_FOUND');
const mustChair = (d, c) => mustGet(d, 'chairs', c, 'CHAIR_NOT_FOUND');
const mustReservation = (d, r) => mustGet(d, 'reservations', r, 'RESERVATION_NOT_FOUND');
const mustIssue = (d, i) => mustGet(d, 'issues', i, 'ISSUE_NOT_FOUND');

// ---------- 预约 / 椅子查询 ----------

function activeReservations(draft) {
  return Object.values(draft.reservations).filter((r) => r.status === RESERVATION_STATUS.ACTIVE);
}

function activeReservationForSeat(draft, seatId) {
  return activeReservations(draft).find((r) => r.seatId === seatId) || null;
}

function activeReservationForChair(draft, chairId) {
  return activeReservations(draft).find((r) => r.chairId === chairId) || null;
}

/**
 * 椅子可被新预约使用：仅 available。
 * 已预留/已布置不可重复预约；故障/停用/归还清点中的椅子不可超卖。
 */
function isChairFree(chair) {
  return CHAIR_FREE_STATUSES.has(chair.status);
}

function freeChairs(draft, { includePendingVerification = true, projectId = null } = {}) {
  return Object.values(draft.chairs).filter((c) => {
    if (!isChairFree(c)) return false;
    if (!includePendingVerification && c.verification === 'pending') return false;
    if (projectId && c.projectId !== projectId) return false;
    return true;
  });
}

function chairInventory(draft, projectId = null) {
  const chairs = Object.values(draft.chairs).filter((c) => !projectId || !c.projectId || c.projectId === projectId);
  const inv = { total: chairs.length, available: 0, reserved: 0, deployed: 0, returned: 0, faulty: 0, decommissioned: 0, pendingVerification: 0 };
  for (const c of chairs) {
    inv[c.status] = (inv[c.status] || 0) + 1;
    if (c.verification === 'pending') inv.pendingVerification += 1;
  }
  return inv;
}

// ---------- 桌容量 ----------

function seatsAt(draft, tableId) {
  return Object.values(draft.seats).filter((s) => s.tableId === tableId);
}

function occupancy(draft, tableId) {
  return seatsAt(draft, tableId).length;
}

function ensureCapacity(draft, tableId, { extra = 1, seatIdToIgnore = null } = {}) {
  const table = mustTable(draft, tableId);
  const used = seatsAt(draft, tableId).filter((s) => s.id !== seatIdToIgnore).length + extra;
  if (used > table.capacity) {
    throw new DomainError(
      'TABLE_CAPACITY_EXCEEDED',
      `桌 ${table.name || table.id} 容量 ${table.capacity}，当前需求 ${used}`,
      { status: 409, tableId, capacity: table.capacity, requested: used }
    );
  }
}

// ---------- 儿童席强绑定不变量 ----------

/**
 * 每个儿童席（儿童宾客 或 匿名儿童椅占位）必须存在一条生效中的实体椅预约。
 * 用于事务提交前的最终断言，也是迁移/修复的自检入口。
 */
function seatRequiresChair(seat, draft) {
  if (!seat.requiresChair) return false;
  if (seat.guestId) {
    const g = draft.guests[seat.guestId];
    if (g && g.type === GUEST_TYPE.CHILD) return true;
  }
  return true; // 匿名占位本身即需要椅子
}

function assertChildSeatBound(draft, seat) {
  if (!seatRequiresChair(seat, draft)) return;
  const r = activeReservationForSeat(draft, seat.id);
  if (!r) {
    throw new DomainError(
      'CHILD_SEAT_UNBOUND',
      `儿童席 ${seat.tableCardLabel || seat.id} 缺少实体椅预约`,
      { status: 409, seatId: seat.id }
    );
  }
  const chair = draft.chairs[r.chairId];
  if (!chair) {
    throw new DomainError('CHAIR_NOT_FOUND', `预约 ${r.id} 绑定的椅子不存在`, { status: 409, reservationId: r.id });
  }
}

function assertAllChildSeatsBound(draft, projectId = null) {
  for (const seat of Object.values(draft.seats)) {
    if (projectId && seat.projectId !== projectId) continue;
    assertChildSeatBound(draft, seat);
  }
}

// ---------- 锁定 ----------

function assertSeatUnlocked(seat, action = '操作') {
  if (seat.locked) {
    throw new DomainError('SEAT_LOCKED', `席位已锁定，禁止${action}`, { status: 423, seatId: seat.id });
  }
}

// ---------- 关系约束 ----------

function relationSet(guest) {
  return new Map((guest.relations || []).map((r) => [r.guestId, r.type]));
}

function addRelation(draft, guestAId, guestBId, type) {
  if (guestAId === guestBId) throw new DomainError('RELATION_SELF', '不能与自身建立关系');
  if (![RELATION.TOGETHER, RELATION.AVOID].includes(type)) throw new DomainError('RELATION_TYPE_INVALID', `未知关系 ${type}`);
  const a = mustGuest(draft, guestAId);
  const b = mustGuest(draft, guestBId);
  a.relations = a.relations || [];
  b.relations = b.relations || [];
  setRel(a, guestBId, type);
  setRel(b, guestAId, type);
  return [a, b];
}

function setRel(guest, otherId, type) {
  const idx = guest.relations.findIndex((r) => r.guestId === otherId);
  if (idx >= 0) guest.relations[idx] = { guestId: otherId, type };
  else guest.relations.push({ guestId: otherId, type });
}

/**
 * 检查把 guestId 放到 tableId 时是否违反关系约束。
 * @returns {{togetherViolations: string[], avoidViolations: string[]}}
 */
function relationConflicts(draft, guestId, tableId, { ignoreSeatId = null } = {}) {
  const guest = draft.guests[guestId];
  const togetherViolations = [];
  const avoidViolations = [];
  if (!guest || !guest.relations) return { togetherViolations, avoidViolations };

  for (const rel of guest.relations) {
    const other = draft.guests[rel.guestId];
    if (!other) continue;
    const otherSeat = Object.values(draft.seats).find((s) => s.guestId === rel.guestId && s.id !== ignoreSeatId);
    if (!otherSeat) continue; // 对方尚未入座，暂不构成违反
    if (rel.type === RELATION.TOGETHER && otherSeat.tableId !== tableId) {
      togetherViolations.push(rel.guestId);
    }
    if (rel.type === RELATION.AVOID && otherSeat.tableId === tableId) {
      avoidViolations.push(rel.guestId);
    }
  }
  return { togetherViolations, avoidViolations };
}

function assertRelationsOk(draft, guestId, tableId, opts = {}) {
  const { togetherViolations, avoidViolations } = relationConflicts(draft, guestId, tableId, opts);
  if (togetherViolations.length || avoidViolations.length) {
    throw new DomainError(
      'RELATION_VIOLATION',
      '关系约束不满足',
      { status: 409, guestId, tableId, togetherViolations, avoidViolations }
    );
  }
}

// ---------- 开放问题 ----------

function openIssueForChair(draft, chairId) {
  return Object.values(draft.issues).find((i) => i.status === 'open' && i.chairId === chairId) || null;
}
function openIssueForSeat(draft, seatId) {
  return Object.values(draft.issues).find((i) => i.status === 'open' && i.seatId === seatId) || null;
}

module.exports = {
  mustGet,
  mustProject,
  mustTable,
  mustGuest,
  mustSeat,
  mustChair,
  mustReservation,
  mustIssue,
  activeReservations,
  activeReservationForSeat,
  activeReservationForChair,
  isChairFree,
  freeChairs,
  chairInventory,
  seatsAt,
  occupancy,
  ensureCapacity,
  seatRequiresChair,
  assertChildSeatBound,
  assertAllChildSeatsBound,
  assertSeatUnlocked,
  addRelation,
  relationConflicts,
  assertRelationsOk,
  openIssueForChair,
  openIssueForSeat,
  CHAIR_STATUS
};
