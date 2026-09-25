'use strict';

/**
 * 旧项目（v1，儿童椅只是抽象占位）-> v2 实体资源模型迁移。
 *
 * 迁移规则：
 *  - 桌容量、桌卡编号(tableCardLabel)、席位锁定标记原样保留；
 *  - 每个儿童宾客席 / 匿名儿童椅占位生成一把“待核验”实体椅(verification=pending)，
 *    并建立 active 预约把席与椅绑定 —— 迁移后系统立刻满足“儿童席必须绑定具体资源”；
 *  - 待核验椅默认状态为 reserved（已预留、未布置），核验通过后可正常布置；
 *    核验发现损坏走与普通资源相同的故障 -> 待处理 -> 替换/撤销流程；
 *  - 幂等：同一 legacy projectId 重复导入直接返回既有结果。
 */

const { CHAIR_STATUS, RESERVATION_STATUS, VERIFICATION, GUEST_TYPE, SCHEMA_VERSION } = require('./constants');
const { DomainError } = require('./errors');
const { id } = require('./ids');
const { audit } = require('./audit');

function normalizeLegacy(raw) {
  if (!raw || typeof raw !== 'object') throw new DomainError('LEGACY_INVALID', '旧项目数据不是对象');
  const project = raw.project || { id: raw.projectId, name: raw.name };
  if (!project || !project.id) throw new DomainError('LEGACY_INVALID', '旧项目缺少 project.id');
  const tables = raw.tables || [];
  const guests = raw.guests || [];
  const placeholders = raw.childPlaceholders || raw.placeholders || [];
  return { project, tables, guests, placeholders, version: raw.version || 1 };
}

function migrate(draft, raw, { actor = 'migration', sourceName = 'legacy-import', allowCopy = false } = {}) {
  const legacy = normalizeLegacy(raw);
  const projectId = legacy.project.id;

  if (draft.projects[projectId]) {
    if (!allowCopy) {
      throw new DomainError('LEGACY_PROJECT_EXISTS', `项目 ${projectId} 已存在，迁移是幂等操作，无需重复导入`, {
        status: 409,
        projectId
      });
    }
  }

  const summary = {
    projectId,
    tables: 0,
    guests: 0,
    seats: 0,
    childSeats: 0,
    chairs: 0,
    reservations: 0
  };

  // 项目
  draft.projects[projectId] = {
    id: projectId,
    name: legacy.project.name || projectId,
    eventDate: legacy.project.date || legacy.project.eventDate || null,
    createdAt: new Date().toISOString(),
    schemaVersion: SCHEMA_VERSION,
    legacy: true,
    legacySource: sourceName
  };

  // 桌（保留容量及旧桌级元数据）
  for (const t of legacy.tables) {
    if (!t.id) throw new DomainError('LEGACY_INVALID', '旧桌缺少 id');
    draft.tables[t.id] = {
      id: t.id,
      projectId,
      name: t.name || t.id,
      capacity: t.capacity,
      meta: { locked: !!t.locked, ...(t.meta || {}) }
    };
    summary.tables += 1;
  }

  const seatsToBind = [];

  // 宾客（含儿童宾客的旧占位标记）
  for (const g of legacy.guests) {
    if (!g.id) throw new DomainError('LEGACY_INVALID', '旧宾客缺少 id');
    draft.guests[g.id] = {
      id: g.id,
      projectId,
      name: g.name || g.id,
      type: g.type === GUEST_TYPE.CHILD ? GUEST_TYPE.CHILD : GUEST_TYPE.ADULT,
      relations: g.relations || [],
      legacy: true
    };
    summary.guests += 1;

    if (g.tableId) {
      const seatId = g.seatId || `seat_${g.id}`;
      const requiresChair = draft.guests[g.id].type === GUEST_TYPE.CHILD || !!g.requiresChair;
      draft.seats[seatId] = {
        id: seatId,
        projectId,
        tableId: g.tableId,
        guestId: g.id,
        anonymous: false,
        requiresChair,
        tableCardLabel: g.tableCardLabel || g.seatLabel || null,
        locked: !!g.locked,
        legacy: true
      };
      summary.seats += 1;
      if (requiresChair) {
        seatsToBind.push({ seatId, placeholderId: g.placeholderId || g.id, locked: !!g.locked });
        summary.childSeats += 1;
      }
    }
  }

  // 匿名儿童椅占位
  for (const p of legacy.placeholders) {
    if (!p.id) throw new DomainError('LEGACY_INVALID', '旧占位缺少 id');
    const seatId = p.seatId || `seat_ph_${p.id}`;
    draft.seats[seatId] = {
      id: seatId,
      projectId,
      tableId: p.tableId,
      guestId: null,
      anonymous: true,
      requiresChair: true,
      tableCardLabel: p.tableCardLabel || p.seatLabel || null,
      locked: !!p.locked,
      legacy: true
    };
    summary.seats += 1;
    seatsToBind.push({ seatId, placeholderId: p.id, locked: !!p.locked });
    summary.childSeats += 1;
  }

  // 为每个儿童席生成待核验实体椅 + active 预约
  let seq = 1;
  for (const bind of seatsToBind) {
    const seat = draft.seats[bind.seatId];
    const code = `${projectId.slice(0, 8).toUpperCase()}-MIG-${String(seq).padStart(3, '0')}`;
    seq += 1;
    const chairId = `chair_mig_${projectId}_${bind.placeholderId}`;
    draft.chairs[chairId] = {
      id: chairId,
      projectId,
      code,
      label: `迁移待核验椅 ${code}`,
      status: CHAIR_STATUS.RESERVED,
      verification: VERIFICATION.PENDING,
      source: 'legacy-migration',
      sourcePlaceholderId: bind.placeholderId,
      createdAt: new Date().toISOString()
    };
    summary.chairs += 1;

    const reservationId = `res_mig_${projectId}_${bind.placeholderId}`;
    draft.reservations[reservationId] = {
      id: reservationId,
      projectId,
      chairId,
      seatId: bind.seatId,
      guestId: seat.guestId,
      anonymous: !!seat.anonymous,
      status: RESERVATION_STATUS.ACTIVE,
      deployed: false,
      locked: bind.locked,
      source: 'legacy-migration',
      createdAt: new Date().toISOString(),
      history: [
        {
          at: new Date().toISOString(),
          action: 'migrated',
          detail: `由 v1 占位 ${bind.placeholderId} 迁移，资源待核验`
        }
      ]
    };
    summary.reservations += 1;
  }

  draft.projects[projectId].migratedAt = new Date().toISOString();

  audit(draft, {
    action: 'migration.legacy-import',
    projectId,
    entityType: 'project',
    entityId: projectId,
    detail: { sourceName, legacyVersion: legacy.version, summary },
    actor
  });

  return summary;
}

module.exports = { migrate, normalizeLegacy };
