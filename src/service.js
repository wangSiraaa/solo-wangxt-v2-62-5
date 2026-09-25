'use strict';

const { FileStore } = require('./store');
const {
  CHAIR_STATUS,
  CHAIR_STATUSES,
  RESERVATION_STATUS,
  VERIFICATION,
  ISSUE_STATUS,
  ISSUE_KIND,
  ISSUE_RESOLUTION,
  GUEST_TYPE,
  RELATION,
  SCHEMA_VERSION
} = require('./constants');
const { DomainError } = require('./errors');
const { id } = require('./ids');
const { audit } = require('./audit');
const {
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
  assertChildSeatBound,
  assertAllChildSeatsBound,
  assertSeatUnlocked,
  addRelation,
  relationConflicts,
  assertRelationsOk,
  openIssueForChair,
  openIssueForSeat
} = require('./invariants');
const { migrate } = require('./migration');

class SeatService {
  /**
   * @param {object} opts
   * @param {string} [opts.dbPath] JSON 数据文件路径（默认 data/db.json）
   * @param {boolean} [opts.save] 是否落盘（测试可用 false 纯内存）
   * @param {FileStore} [opts.store] 直接注入存储
   */
  constructor(opts = {}) {
    this.store = opts.store || new FileStore(opts.dbPath || process.env.SEATING_DB || 'data/db.json', { save: opts.save !== false });
  }

  // 统一写入口：审计 actor / 幂等键透传；失败时统一补“失败审计”（随回滚单独落盘）
  _write(requestBody, fn, { idempotencyKey, actor } = {}) {
    return this.store.runWithKey(idempotencyKey || null, requestBody, async (draft) => {
      const ctx = { actor: actor || requestBody.actor || 'system', idempotencyKey: idempotencyKey || null };
      try {
        return await fn(draft, ctx);
      } catch (err) {
        // 业务内可能已经显式记录过同一失败；此处兜底保证任何失败都留痕
        const already = draft.audit.some(
          (a) => a.result === 'failed' && a.reason === (err.code || 'ERROR') && a.idempotencyKey === ctx.idempotencyKey
        );
        if (!already) {
          audit(draft, {
            action: `${requestBody.op || 'unknown'}.failed`,
            projectId: requestBody.projectId || null,
            detail: { code: err.code || 'ERROR', ...(err.details || {}) },
            result: 'failed',
            reason: err.code || 'ERROR',
            actor: ctx.actor,
            idempotencyKey: ctx.idempotencyKey
          });
        }
        throw err;
      }
    });
  }

  async _read() {
    return this.store.snapshot();
  }

  // ============ 项目 ============

  async createProject(input = {}, meta = {}) {
    return this._write({ op: 'createProject', input }, (draft, ctx) => {
      const projectId = input.id || `proj_${id('x')}`;
      if (draft.projects[projectId]) throw new DomainError('PROJECT_EXISTS', `项目 ${projectId} 已存在`);
      const project = {
        id: projectId,
        name: input.name || projectId,
        eventDate: input.eventDate || null,
        createdAt: new Date().toISOString(),
        schemaVersion: SCHEMA_VERSION
      };
      draft.projects[projectId] = project;
      audit(draft, { action: 'project.create', projectId, entityType: 'project', entityId: projectId, detail: { name: project.name }, actor: ctx.actor, idempotencyKey: ctx.idempotencyKey });
      return project;
    }, meta);
  }

  // ============ 桌 ============

  async addTable(projectId, input = {}, meta = {}) {
    return this._write({ op: 'addTable', projectId, input }, (draft, ctx) => {
      mustProject(draft, projectId);
      const tableId = input.id || `tbl_${id('x')}`;
      if (draft.tables[tableId]) throw new DomainError('TABLE_EXISTS', `桌 ${tableId} 已存在`);
      const capacity = Number(input.capacity);
      if (!Number.isInteger(capacity) || capacity < 1) throw new DomainError('TABLE_CAPACITY_INVALID', '桌容量必须为正整数', { status: 400 });
      const table = { id: tableId, projectId, name: input.name || tableId, capacity, meta: input.meta || {} };
      draft.tables[tableId] = table;
      audit(draft, { action: 'table.add', projectId, entityType: 'table', entityId: tableId, detail: { capacity, name: table.name }, actor: ctx.actor, idempotencyKey: ctx.idempotencyKey });
      return table;
    }, meta);
  }

  // ============ 宾客 / 关系 ============

  async addGuest(projectId, input = {}, meta = {}) {
    return this._write({ op: 'addGuest', projectId, input }, (draft, ctx) => {
      mustProject(draft, projectId);
      const guestId = input.id || `gst_${id('x')}`;
      if (draft.guests[guestId]) throw new DomainError('GUEST_EXISTS', `宾客 ${guestId} 已存在`);
      const type = input.type === GUEST_TYPE.CHILD ? GUEST_TYPE.CHILD : GUEST_TYPE.ADULT;
      const guest = { id: guestId, projectId, name: input.name || guestId, type, relations: input.relations || [] };
      draft.guests[guestId] = guest;
      audit(draft, { action: 'guest.add', projectId, entityType: 'guest', entityId: guestId, detail: { name: guest.name, type }, actor: ctx.actor, idempotencyKey: ctx.idempotencyKey });
      return guest;
    }, meta);
  }

  async setRelation(projectId, guestAId, guestBId, type, meta = {}) {
    return this._write({ op: 'setRelation', projectId, guestAId, guestBId, type }, (draft, ctx) => {
      mustProject(draft, projectId);
      const [a, b] = addRelation(draft, guestAId, guestBId, type);
      audit(draft, { action: 'guest.relation', projectId, entityType: 'guest', entityId: guestAId, detail: { with: guestBId, type }, actor: ctx.actor, idempotencyKey: ctx.idempotencyKey });
      return { guest: a, with: b };
    }, meta);
  }

  // ============ 椅子资源 ============

  async addChair(projectId, input = {}, meta = {}) {
    return this._write({ op: 'addChair', projectId, input }, (draft, ctx) => {
      mustProject(draft, projectId);
      return createChair(draft, projectId, input, ctx);
    }, meta);
  }

  /**
   * 批量导入椅子。CSV 行：code,label,status,verification
   * 整个批次是一个事务：任一行非法全部回滚。
   */
  async importChairs(projectId, rows, meta = {}) {
    return this._write({ op: 'importChairs', projectId, rows }, (draft, ctx) => {
      mustProject(draft, projectId);
      const created = [];
      const seenCodes = new Set();
      rows.forEach((row0, index) => {
        const row = normalizeCsvRow(row0);
        if (!row.code) throw new DomainError('IMPORT_INVALID', `第 ${index + 1} 行缺少 code`, { status: 400, index });
        if (seenCodes.has(row.code)) throw new DomainError('IMPORT_DUPLICATE_CODE', `第 ${index + 1} 行 code 重复: ${row.code}`, { status: 400, index, code: row.code });
        if (Object.values(draft.chairs).some((c) => c.projectId === projectId && c.code === row.code)) {
          throw new DomainError('IMPORT_CODE_EXISTS', `code 已存在: ${row.code}`, { status: 409, index, code: row.code });
        }
        seenCodes.add(row.code);
        const status = row.status || CHAIR_STATUS.AVAILABLE;
        if (!CHAIR_STATUSES.includes(status)) throw new DomainError('IMPORT_INVALID', `第 ${index + 1} 行状态非法: ${status}`, { status: 400, index });
        if (status !== CHAIR_STATUS.AVAILABLE) throw new DomainError('IMPORT_INVALID', `第 ${index + 1} 行：仅允许导入 ${CHAIR_STATUS.AVAILABLE} 资源，其余状态由业务流转产生`, { status: 400, index });
        const chair = createChair(draft, projectId, {
          code: row.code,
          label: row.label || row.code,
          verification: row.verification === VERIFICATION.PENDING ? VERIFICATION.PENDING : VERIFICATION.VERIFIED
        }, ctx, { silent: true });
        created.push(chair);
      });
      audit(draft, { action: 'chair.import', projectId, entityType: 'project', entityId: projectId, detail: { count: created.length, codes: created.map((c) => c.code) }, actor: ctx.actor, idempotencyKey: ctx.idempotencyKey });
      return { imported: created.length, chairs: created };
    }, meta);
  }

  async exportChairs(projectId, meta = {}) {
    // 导出是只读操作，但也走审计
    const draft = await this._read();
    mustProject(draft, projectId);
    const chairs = Object.values(draft.chairs).filter((c) => c.projectId === projectId);
    return chairs.map((c) => ({
      code: c.code,
      label: c.label || '',
      status: c.status,
      verification: c.verification || VERIFICATION.VERIFIED,
      seatId: boundSeatForChair(draft, c.id),
      createdAt: c.createdAt || ''
    }));
  }

  async listChairs(projectId, meta = {}) {
    const draft = await this._read();
    if (projectId) mustProject(draft, projectId);
    return Object.values(draft.chairs)
      .filter((c) => !projectId || c.projectId === projectId)
      .map((c) => ({ ...c, boundSeatId: boundSeatForChair(draft, c.id), openIssueId: (openIssueForChair(draft, c.id) || {}).id || null }));
  }

  async chairInventory(projectId, meta = {}) {
    const draft = await this._read();
    if (projectId) mustProject(draft, projectId);
    return chairInventory(draft, projectId);
  }

  /**
   * 核验迁移来的待核验资源
   */
  async verifyChair(chairId, input = {}, meta = {}) {
    return this._write({ op: 'verifyChair', chairId, input }, (draft, ctx) => {
      const chair = mustChair(draft, chairId);
      if (chair.verification !== VERIFICATION.PENDING) throw new DomainError('CHAIR_NOT_PENDING', `椅子 ${chair.code} 不在待核验状态`);
      chair.verification = VERIFICATION.VERIFIED;
      chair.verifiedAt = new Date().toISOString();
      chair.verifiedBy = ctx.actor;
      audit(draft, { action: 'chair.verify', projectId: chair.projectId, entityType: 'chair', entityId: chairId, detail: { code: chair.code }, actor: ctx.actor, idempotencyKey: ctx.idempotencyKey });
      return chair;
    }, meta);
  }

  async setChairStatus(chairId, status, input = {}, meta = {}) {
    return this._write({ op: 'setChairStatus', chairId, status, input }, (draft, ctx) => {
      const chair = mustChair(draft, chairId);
      const comment = input.comment || null;
      switch (status) {
        case CHAIR_STATUS.FAULTY:
          return markFault(draft, chair, comment, ctx);
        case CHAIR_STATUS.DECOMMISSIONED:
          return markWithdrawn(draft, chair, comment, ctx, input);
        case CHAIR_STATUS.AVAILABLE:
          return repairChair(draft, chair, ctx, input);
        default:
          throw new DomainError('CHAIR_STATUS_TRANSITION_UNSUPPORTED', `不支持手动切换到 ${status}`, { status: 400 });
      }
    }, meta);
  }

  // ============ 席位与预约 ============

  /**
   * 儿童宾客入座 或 创建匿名儿童椅占位。
   * 必须同时绑定一把具体实体椅（可用椅），不允许先占抽象位再补。
   */
  async createSeat(projectId, input = {}, meta = {}) {
    return this._write({ op: 'createSeat', projectId, input }, (draft, ctx) => {
      mustProject(draft, projectId);
      const table = mustTable(draft, input.tableId);
      let requiresChair;
      let guest = null;
      if (input.guestId) {
        guest = mustGuest(draft, input.guestId);
        if (guest.projectId !== projectId) throw new DomainError('GUEST_PROJECT_MISMATCH', '宾客不属于该项目');
        requiresChair = guest.type === GUEST_TYPE.CHILD;
        if (Object.values(draft.seats).some((s) => s.guestId === guest.id)) {
          throw new DomainError('GUEST_ALREADY_SEATED', `宾客 ${guest.name} 已有席位`, { status: 409, guestId: guest.id });
        }
      } else {
        if (!input.anonymous) throw new DomainError('SEAT_INPUT_INVALID', '需提供 guestId 或声明 anonymous 占位', { status: 400 });
        requiresChair = true;
      }
      ensureCapacity(draft, table.id);
      if (guest) assertRelationsOk(draft, guest.id, table.id);

      const seatId = input.id || `seat_${id('x')}`;
      const seat = {
        id: seatId,
        projectId,
        tableId: table.id,
        guestId: guest ? guest.id : null,
        anonymous: !guest,
        requiresChair,
        tableCardLabel: input.tableCardLabel || null,
        locked: !!input.locked,
        createdAt: new Date().toISOString()
      };
      draft.seats[seatId] = seat;

      let reservation = null;
      if (requiresChair) {
        const chair = pickChair(draft, projectId, input.chairId, ctx);
        reservation = bindChairToSeat(draft, chair, seat, ctx, { action: 'chair.reserve', comment: input.comment });
      }

      audit(draft, { action: 'seat.create', projectId, entityType: 'seat', entityId: seatId, detail: { tableId: table.id, guestId: seat.guestId, anonymous: seat.anonymous, reservationId: reservation && reservation.id, chairId: reservation && reservation.chairId }, actor: ctx.actor, idempotencyKey: ctx.idempotencyKey });
      return { seat, reservation };
    }, meta);
  }

  /**
   * 单独为既有儿童席预留椅子（正常路径下 createSeat 已绑定，此接口用于显式预留/补录）。
   */
  async reserveChair(projectId, seatId, input = {}, meta = {}) {
    return this._write({ op: 'reserveChair', projectId, seatId, chairId: input.chairId || null }, (draft, ctx) => {
      if (projectId) mustProject(draft, projectId);
      const seat = mustSeat(draft, seatId);
      if (projectId && seat.projectId !== projectId) throw new DomainError('SEAT_PROJECT_MISMATCH', '席位不属于该项目');
      if (activeReservationForSeat(draft, seatId)) {
        throw new DomainError('SEAT_ALREADY_RESERVED', `席位 ${seatId} 已有生效中的椅子预约`, { status: 409, seatId });
      }
      assertChildSeatBoundRequirement(draft, seat);
      const chair = pickChair(draft, projectId, input.chairId, ctx);
      const reservation = bindChairToSeat(draft, chair, seat, ctx, { action: 'chair.reserve', comment: input.comment });
      return { seat, reservation };
    }, meta);
  }

  /**
   * 释放椅子（离席 / 撤销占位）。锁定席默认拒绝，需显式 force（会单独审计）。
   */
  async releaseSeat(seatId, input = {}, meta = {}) {
    return this._write({ op: 'releaseSeat', seatId, input }, (draft, ctx) => {
      const seat = mustSeat(draft, seatId);
      const projectId = seat.projectId;
      if (seat.locked && !input.force) {
        audit(draft, { action: 'seat.release', projectId, entityType: 'seat', entityId: seatId, result: 'failed', reason: 'SEAT_LOCKED', detail: {}, actor: ctx.actor, idempotencyKey: ctx.idempotencyKey });
        assertSeatUnlocked(seat, '释放');
      }
      const reservation = activeReservationForSeat(draft, seatId);
      let chair = null;
      if (reservation) {
        chair = mustChair(draft, reservation.chairId);
        if (reservation.deployed || chair.status === CHAIR_STATUS.DEPLOYED) {
          if (!input.allowUndeploy) throw new DomainError('CHAIR_STILL_DEPLOYED', '椅子已布置，请先撤场或显式 allowUndeploy', { status: 409, seatId, chairId: chair.id });
          reservation.deployed = false;
          chair.status = CHAIR_STATUS.RETURNED;
          chair.returnedAt = new Date().toISOString();
          pushHistory(reservation, 'undeployed', ctx, '释放时撤场');
          audit(draft, { action: 'chair.undeploy', projectId, entityType: 'chair', entityId: chair.id, detail: { seatId }, actor: ctx.actor, idempotencyKey: ctx.idempotencyKey });
        }
        reservation.status = RESERVATION_STATUS.RELEASED;
        reservation.endedAt = new Date().toISOString();
        reservation.endReason = input.reason || 'released';
        pushHistory(reservation, 'released', ctx, input.reason || '人工释放');
        if (chair.status === CHAIR_STATUS.RESERVED) {
          chair.status = CHAIR_STATUS.RETURNED;
          chair.returnedAt = new Date().toISOString();
        }
        audit(draft, { action: 'chair.release', projectId, entityType: 'reservation', entityId: reservation.id, detail: { seatId, chairId: chair.id, force: !!input.force }, actor: ctx.actor, idempotencyKey: ctx.idempotencyKey });
      }
      // 删除席位卡（成人席同样适用）；儿童椅绑定关系随预约结束而解除
      delete draft.seats[seatId];
      audit(draft, { action: 'seat.release', projectId, entityType: 'seat', entityId: seatId, detail: { removed: true, force: !!input.force, reservationId: reservation && reservation.id }, actor: ctx.actor, idempotencyKey: ctx.idempotencyKey });
      return { released: true, seatId, reservationId: reservation ? reservation.id : null, chairId: chair ? chair.id : null };
    }, meta);
  }

  /**
   * 布置：预留椅到场就桌
   */
  async deployChair(seatId, input = {}, meta = {}) {
    return this._write({ op: 'deployChair', seatId, input }, (draft, ctx) => {
      const seat = mustSeat(draft, seatId);
      const reservation = activeReservationForSeat(draft, seatId);
      if (!reservation) throw new DomainError('RESERVATION_NOT_FOUND', '该席没有生效中的椅子预约', { status: 409, seatId });
      if (reservation.deployed) throw new DomainError('CHAIR_ALREADY_DEPLOYED', '椅子已处于已布置状态', { status: 409, seatId });
      const chair = mustChair(draft, reservation.chairId);
      if (chair.status !== CHAIR_STATUS.RESERVED) throw new DomainError('CHAIR_NOT_RESERVED', `仅已预留资源可布置，当前状态 ${chair.status}`, { status: 409, chairId: chair.id });
      if (chair.verification === VERIFICATION.PENDING) throw new DomainError('CHAIR_UNVERIFIED', '待核验资源需先核验通过才能布置', { status: 409, chairId: chair.id });
      chair.status = CHAIR_STATUS.DEPLOYED;
      chair.deployedAt = new Date().toISOString();
      reservation.deployed = true;
      reservation.deployedAt = chair.deployedAt;
      pushHistory(reservation, 'deployed', ctx, input.comment || '到场就桌');
      audit(draft, { action: 'chair.deploy', projectId: seat.projectId, entityType: 'chair', entityId: chair.id, detail: { seatId, reservationId: reservation.id }, actor: ctx.actor, idempotencyKey: ctx.idempotencyKey });
      return { seat, reservation, chair };
    }, meta);
  }

  /**
   * 撤场：已布置 -> 归还清点
   */
  async undeployChair(seatId, input = {}, meta = {}) {
    return this._write({ op: 'undeployChair', seatId, input }, (draft, ctx) => {
      const seat = mustSeat(draft, seatId);
      const reservation = activeReservationForSeat(draft, seatId);
      if (!reservation) throw new DomainError('RESERVATION_NOT_FOUND', '该席没有生效中的椅子预约', { status: 409, seatId });
      const chair = mustChair(draft, reservation.chairId);
      if (chair.status !== CHAIR_STATUS.DEPLOYED) throw new DomainError('CHAIR_NOT_DEPLOYED', `当前状态 ${chair.status}，无需撤场`, { status: 409, chairId: chair.id });
      chair.status = CHAIR_STATUS.RETURNED;
      chair.returnedAt = new Date().toISOString();
      reservation.deployed = false;
      pushHistory(reservation, 'undeployed', ctx, input.comment || '撤场');
      audit(draft, { action: 'chair.undeploy', projectId: seat.projectId, entityType: 'chair', entityId: chair.id, detail: { seatId }, actor: ctx.actor, idempotencyKey: ctx.idempotencyKey });
      return { seat, reservation, chair };
    }, meta);
  }

  /**
   * 归还清点完成：returned -> available，回库再利用
   */
  async checkinChair(chairId, input = {}, meta = {}) {
    return this._write({ op: 'checkinChair', chairId, input }, (draft, ctx) => {
      const chair = mustChair(draft, chairId);
      if (chair.status !== CHAIR_STATUS.RETURNED) throw new DomainError('CHAIR_NOT_RETURNED', `仅已归还资源可清点回库，当前 ${chair.status}`, { status: 409, chairId });
      if (activeReservationForChair(draft, chair.id)) throw new DomainError('CHAIR_STILL_BOUND', '该椅仍有生效预约，不能回库', { status: 409, chairId });
      chair.status = CHAIR_STATUS.AVAILABLE;
      chair.checkedInAt = new Date().toISOString();
      delete chair.returnedAt;
      audit(draft, { action: 'chair.checkin', projectId: chair.projectId, entityType: 'chair', entityId: chair.id, detail: { code: chair.code }, actor: ctx.actor, idempotencyKey: ctx.idempotencyKey });
      return chair;
    }, meta);
  }

  /**
   * 换桌 / 换椅。核心保证：
   *  - 源席未锁定；目标桌容量、关系约束同时满足；
   *  - 儿童席必须在目标方案中拿到一把可用实体椅，否则整体失败、原预约完整保留；
   *  - 已布置椅子随换桌先撤场归还（除非 stayDeployed 且提供同桌新椅）；
   *  - 全流程单事务，失败即回滚。
   */
  async transferSeat(seatId, input = {}, meta = {}) {
    return this._write({ op: 'transferSeat', seatId, targetTableId: input.targetTableId, targetChairId: input.targetChairId || null }, (draft, ctx) => {
      const seat = mustSeat(draft, seatId);
      const targetTableId = input.targetTableId;
      if (!targetTableId) throw new DomainError('TARGET_TABLE_REQUIRED', '换桌需要 targetTableId', { status: 400 });
      const targetTable = mustTable(draft, targetTableId);
      if (targetTable.projectId !== seat.projectId) throw new DomainError('TABLE_PROJECT_MISMATCH', '目标桌不属于同一项目');

      assertSeatUnlocked(seat, '换桌');
      const oldReservation = activeReservationForSeat(draft, seatId);
      if (oldReservation && oldReservation.locked && !input.force) {
        throw new DomainError('RESERVATION_LOCKED', '该儿童椅预约已锁定，禁止换座', { status: 423, seatId });
      }
      ensureCapacity(draft, targetTableId, { seatIdToIgnore: seatId });
      if (seat.guestId) assertRelationsOk(draft, seat.guestId, targetTableId, { ignoreSeatId: seatId });

      let oldChair = null;
      if (oldReservation) oldChair = mustChair(draft, oldReservation.chairId);

      // 预演新椅选择：目标无可用椅时在此抛出，尚未做任何修改 -> 原预约完整保留
      let newChair = null;
      if (seat.requiresChair) {
        const sameChair = oldChair && oldChair.id === (input.targetChairId || oldChair.id);
        if (oldChair && sameChair && input.keepChair) {
          // 显式要求原椅跟随（仅允许 reserved 状态；已布置的物理椅不能静默移动桌位）
          if (oldChair.status === CHAIR_STATUS.DEPLOYED && !input.allowMoveDeployed) {
            throw new DomainError('CHAIR_DEPLOYED_MOVE_DENIED', '已布置实体椅不能随换桌静默移动，请先撤场或换一把目标椅', { status: 409, seatId, chairId: oldChair.id });
          }
          newChair = oldChair;
        } else {
          newChair = pickChair(draft, seat.projectId, input.targetChairId || null, ctx, { excludeChairId: oldChair ? oldChair.id : null });
        }
      }

      // ---- 以下为已通过全部校验的提交阶段 ----
      const oldTableId = seat.tableId;
      seat.tableId = targetTableId;
      if (input.tableCardLabel !== undefined) seat.tableCardLabel = input.tableCardLabel;

      let resultReservation = oldReservation;
      if (seat.requiresChair && newChair && (!oldChair || newChair.id !== oldChair.id)) {
        // 旧椅归还
        if (oldReservation) {
          const wasDeployed = oldReservation.deployed;
          oldReservation.status = RESERVATION_STATUS.TRANSFERRED;
          oldReservation.endedAt = new Date().toISOString();
          pushHistory(oldReservation, 'transferred', ctx, `换桌至 ${targetTable.name}`);
          if (oldChair.status === CHAIR_STATUS.DEPLOYED || wasDeployed) {
            oldChair.status = CHAIR_STATUS.RETURNED;
            oldChair.returnedAt = new Date().toISOString();
          } else if (oldChair.status === CHAIR_STATUS.RESERVED) {
            oldChair.status = CHAIR_STATUS.RETURNED;
            oldChair.returnedAt = new Date().toISOString();
          }
          audit(draft, { action: 'chair.return-on-transfer', projectId: seat.projectId, entityType: 'chair', entityId: oldChair.id, detail: { seatId, fromTableId: oldTableId }, actor: ctx.actor, idempotencyKey: ctx.idempotencyKey });
        }
        // 新椅预留并绑定
        resultReservation = bindChairToSeat(draft, newChair, seat, ctx, {
          action: 'chair.reserve-on-transfer',
          comment: `换桌 ${oldTableId} -> ${targetTableId}`,
          deploy: input.deployNewChair === true
        });
      } else if (oldReservation && newChair && newChair.id === oldChair.id) {
        pushHistory(oldReservation, 'transferred-same-chair', ctx, `原椅随席换桌至 ${targetTable.name}`);
      }

      audit(draft, { action: 'seat.transfer', projectId: seat.projectId, entityType: 'seat', entityId: seatId, detail: { fromTableId: oldTableId, toTableId: targetTableId, oldChairId: oldChair && oldChair.id, newChairId: newChair && newChair.id, reservationId: resultReservation && resultReservation.id }, actor: ctx.actor, idempotencyKey: ctx.idempotencyKey });
      return { seat, reservation: resultReservation, oldChairId: oldChair ? oldChair.id : null, newChairId: newChair ? newChair.id : null };
    }, meta);
  }

  /**
   * 单独换椅（同桌替换实体资源，不换桌）
   */
  async swapChair(seatId, input = {}, meta = {}) {
    return this._write({ op: 'swapChair', seatId, targetChairId: input.targetChairId || null }, (draft, ctx) => {
      const seat = mustSeat(draft, seatId);
      assertSeatUnlocked(seat, '更换儿童椅');
      const oldReservation = activeReservationForSeat(draft, seatId);
      if (!oldReservation) throw new DomainError('RESERVATION_NOT_FOUND', '该席没有生效中的椅子预约', { status: 409, seatId });
      if (oldReservation.locked && !input.force) throw new DomainError('RESERVATION_LOCKED', '预约已锁定', { status: 423, seatId });
      const oldChair = mustChair(draft, oldReservation.chairId);
      const newChair = pickChair(draft, seat.projectId, input.targetChairId || null, ctx, { excludeChairId: oldChair.id });

      oldReservation.status = RESERVATION_STATUS.TRANSFERRED;
      oldReservation.endedAt = new Date().toISOString();
      pushHistory(oldReservation, 'chair-swapped', ctx, input.comment || '同桌换椅');
      const wasDeployed = oldReservation.deployed || oldChair.status === CHAIR_STATUS.DEPLOYED;
      oldChair.status = CHAIR_STATUS.RETURNED;
      oldChair.returnedAt = new Date().toISOString();
      const reservation = bindChairToSeat(draft, newChair, seat, ctx, { action: 'chair.swap', comment: input.comment, deploy: wasDeployed && input.deployNewChair !== false });
      audit(draft, { action: 'seat.chair-swap', projectId: seat.projectId, entityType: 'seat', entityId: seatId, detail: { oldChairId: oldChair.id, newChairId: newChair.id }, actor: ctx.actor, idempotencyKey: ctx.idempotencyKey });
      return { seat, reservation, oldChairId: oldChair.id, newChairId: newChair.id };
    }, meta);
  }

  async setSeatLock(seatId, locked, input = {}, meta = {}) {
    return this._write({ op: 'setSeatLock', seatId, locked }, (draft, ctx) => {
      const seat = mustSeat(draft, seatId);
      seat.locked = !!locked;
      const reservation = activeReservationForSeat(draft, seatId);
      if (reservation) reservation.locked = !!locked;
      audit(draft, { action: 'seat.lock', projectId: seat.projectId, entityType: 'seat', entityId: seatId, detail: { locked: !!locked, reservationId: reservation && reservation.id }, actor: ctx.actor, idempotencyKey: ctx.idempotencyKey });
      return { seat, reservation };
    }, meta);
  }

  // ============ 故障 / 撤回 -> 待处理 ============

  /**
   * 解决待处理方案：replace / revoke / keep
   */
  async resolveIssue(issueId, input = {}, meta = {}) {
    return this._write({ op: 'resolveIssue', issueId, resolution: input.resolution, replacementChairId: input.replacementChairId || null }, (draft, ctx) => {
      const issue = mustIssue(draft, issueId);
      if (issue.status !== ISSUE_STATUS.OPEN) throw new DomainError('ISSUE_NOT_OPEN', `方案 ${issueId} 已解决`, { status: 409, issueId });
      const seat = mustSeat(draft, issue.seatId);
      const reservation = activeReservationForSeat(draft, issue.seatId);
      if (!reservation) throw new DomainError('RESERVATION_NOT_FOUND', '关联预约已不存在，无法解决该方案', { status: 409, issueId });

      switch (input.resolution) {
        case ISSUE_RESOLUTION.REPLACE:
          return resolveReplace(draft, issue, seat, reservation, input, ctx);
        case ISSUE_RESOLUTION.REVOKE:
          return resolveRevoke(draft, issue, seat, reservation, input, ctx);
        case ISSUE_RESOLUTION.KEEP:
          return resolveKeep(draft, issue, seat, reservation, input, ctx);
        default:
          throw new DomainError('RESOLUTION_INVALID', `未知处理方式 ${input.resolution}`, { status: 400 });
      }
    }, meta);
  }

  // ============ 自动排座 + 诊断 ============

  /**
   * 只读诊断：给出当前未入座宾客的可行性分析，不做任何修改。
   */
  async diagnoseAutoSeating(projectId, input = {}) {
    const draft = await this._read();
    mustProject(draft, projectId);
    return computeAutoSeating(draft, projectId, input, { dryRun: true });
  }

  /**
   * 执行自动排座。默认原子模式：任一人排不下则整体回滚；
   * allowPartial=true 时允许部分成功，未排入者进入 unresolved。
   */
  async autoSeat(projectId, input = {}, meta = {}) {
    return this._write({ op: 'autoSeat', projectId, input: { ...input, guestIds: input.guestIds || null } }, (draft, ctx) => {
      mustProject(draft, projectId);
      const plan = computeAutoSeating(draft, projectId, input, { dryRun: false });
      if (!input.allowPartial && plan.unresolved.length > 0) {
        audit(draft, {
          action: 'autoseat',
          projectId,
          entityType: 'project',
          entityId: projectId,
          result: 'failed',
          reason: 'AUTOSEAT_HAS_UNRESOLVED',
          detail: { unresolved: plan.unresolved.map((u) => ({ guestId: u.guestId, reason: u.reason })) },
          actor: ctx.actor,
          idempotencyKey: ctx.idempotencyKey
        });
        throw new DomainError('AUTOSEAT_HAS_UNRESOLVED', '存在无法排座的宾客，已整体回滚（可查看诊断）', {
          status: 409,
          unresolved: plan.unresolved
        });
      }

      // 应用方案
      const createdSeats = [];
      const createdReservations = [];
      for (const dec of plan.decisions) {
        const guest = draft.guests[dec.guestId];
        const requiresChair = guest.type === GUEST_TYPE.CHILD;
        const seat = {
          id: `seat_auto_${id('x')}`,
          projectId,
          tableId: dec.tableId,
          guestId: guest.id,
          anonymous: false,
          requiresChair,
          tableCardLabel: null,
          locked: false,
          createdAt: new Date().toISOString(),
          autoSeated: true
        };
        draft.seats[seat.id] = seat;
        let reservation = null;
        if (requiresChair && dec.chairId) {
          const chair = mustChair(draft, dec.chairId);
          reservation = bindChairToSeat(draft, chair, seat, ctx, { action: 'chair.reserve-autoseat', comment: '自动排座', silent: true });
          createdReservations.push(reservation.id);
        }
        createdSeats.push(seat.id);
      }

      // 提交前断言：儿童席强绑定
      assertAllChildSeatsBound(draft, projectId);

      audit(draft, {
        action: 'autoseat',
        projectId,
        entityType: 'project',
        entityId: projectId,
        detail: {
          seated: plan.decisions.length,
          unresolved: plan.unresolved.map((u) => u.guestId),
          seats: createdSeats,
          reservations: createdReservations,
          allowPartial: !!input.allowPartial
        },
        actor: ctx.actor,
        idempotencyKey: ctx.idempotencyKey
      });
      return { seated: plan.decisions.length, decisions: plan.decisions, unresolved: plan.unresolved, diagnostics: plan.tables };
    }, meta);
  }

  // ============ 迁移 ============

  async importLegacy(rawLegacy, meta = {}) {
    return this._write({ op: 'importLegacy', projectId: rawLegacy && rawLegacy.project && rawLegacy.project.id }, (draft, ctx) => {
      const summary = migrate(draft, rawLegacy, { actor: ctx.actor, allowCopy: false });
      assertAllChildSeatsBound(draft, summary.projectId);
      return summary;
    }, meta);
  }

  // ============ 查询 / 可视化 / 历史 ============

  async getProjectState(projectId) {
    const draft = await this._read();
    mustProject(draft, projectId);
    return {
      project: draft.projects[projectId],
      tables: Object.values(draft.tables).filter((t) => t.projectId === projectId),
      guests: Object.values(draft.guests).filter((g) => g.projectId === projectId),
      seats: Object.values(draft.seats).filter((s) => s.projectId === projectId),
      chairs: Object.values(draft.chairs).filter((c) => c.projectId === projectId),
      reservations: Object.values(draft.reservations).filter((r) => r.projectId === projectId),
      issues: Object.values(draft.issues).filter((i) => i.projectId === projectId),
      inventory: chairInventory(draft, projectId)
    };
  }

  /**
   * 桌位资源可视化：每桌席位卡 + 绑定椅子状态 + 占用率
   */
  async tableView(projectId) {
    const draft = await this._read();
    mustProject(draft, projectId);
    return Object.values(draft.tables)
      .filter((t) => t.projectId === projectId)
      .map((table) => {
        const seats = seatsAt(draft, table.id).map((seat) => {
          const guest = seat.guestId ? draft.guests[seat.guestId] : null;
          const reservation = activeReservationForSeat(draft, seat.id);
          const chair = reservation ? draft.chairs[reservation.chairId] : null;
          const issue = openIssueForSeat(draft, seat.id);
          return {
            seatId: seat.id,
            tableCardLabel: seat.tableCardLabel,
            locked: seat.locked,
            anonymous: seat.anonymous,
            requiresChair: seat.requiresChair,
            guest: guest ? { id: guest.id, name: guest.name, type: guest.type } : null,
            chair: chair
              ? {
                  id: chair.id,
                  code: chair.code,
                  label: chair.label,
                  status: chair.status,
                  verification: chair.verification,
                  deployed: reservation.deployed,
                  reservationLocked: reservation.locked
                }
              : null,
            issue: issue ? { id: issue.id, kind: issue.kind, status: issue.status } : null,
            needsAttention: !!issue,
            legacy: !!seat.legacy
          };
        });
        const used = seats.length;
        return {
          tableId: table.id,
          name: table.name,
          capacity: table.capacity,
          used,
          free: table.capacity - used,
          occupancyRate: table.capacity ? used / table.capacity : 0,
          childSeats: seats.filter((s) => s.requiresChair).length,
          deployedChairs: seats.filter((s) => s.chair && s.chair.status === CHAIR_STATUS.DEPLOYED).length,
          attentionCount: seats.filter((s) => s.needsAttention).length,
          seats
        };
      });
  }

  async issues(projectId, input = {}) {
    const draft = await this._read();
    let items = Object.values(draft.issues);
    if (projectId) items = items.filter((i) => i.projectId === projectId);
    if (input.status) items = items.filter((i) => i.status === input.status);
    return items;
  }

  async auditHistory(input = {}) {
    const draft = await this._read();
    let items = draft.audit.slice();
    if (input.projectId) items = items.filter((a) => a.projectId === input.projectId);
    if (input.entityType) items = items.filter((a) => a.entityType === input.entityType);
    if (input.entityId) items = items.filter((a) => a.entityId === input.entityId);
    if (input.action) items = items.filter((a) => a.action === input.action);
    if (input.result) items = items.filter((a) => a.result === input.result);
    items.sort((a, b) => (a.at < b.at ? 1 : -1));
    const limit = input.limit ? Math.min(Number(input.limit), 1000) : 100;
    const offset = input.offset ? Number(input.offset) : 0;
    return { total: items.length, items: items.slice(offset, offset + limit) };
  }

  async reservations(projectId) {
    const draft = await this._read();
    return Object.values(draft.reservations).filter((r) => !projectId || r.projectId === projectId);
  }
}

// ================= 内部领域辅助函数 =================

function createChair(draft, projectId, input, ctx, { silent = false } = {}) {
  const chairId = input.id || `chair_${id('x')}`;
  if (draft.chairs[chairId]) throw new DomainError('CHAIR_EXISTS', `椅子 ${chairId} 已存在`);
  const code = input.code || `CH-${String(Object.values(draft.chairs).length + 1).padStart(4, '0')}`;
  if (Object.values(draft.chairs).some((c) => c.projectId === projectId && c.code === code)) {
    throw new DomainError('CHAIR_CODE_EXISTS', `椅子编码 ${code} 已存在`, { status: 409, code });
  }
  const chair = {
    id: chairId,
    projectId,
    code,
    label: input.label || code,
    status: CHAIR_STATUS.AVAILABLE,
    verification: input.verification === VERIFICATION.PENDING ? VERIFICATION.PENDING : VERIFICATION.VERIFIED,
    source: input.source || 'manual',
    createdAt: new Date().toISOString()
  };
  draft.chairs[chairId] = chair;
  if (!silent) {
    audit(draft, { action: 'chair.add', projectId, entityType: 'chair', entityId: chairId, detail: { code }, actor: ctx.actor, idempotencyKey: ctx.idempotencyKey });
  }
  return chair;
}

function boundSeatForChair(draft, chairId) {
  const r = activeReservationForChair(draft, chairId);
  return r ? r.seatId : null;
}

function normalizeCsvRow(row) {
  if (typeof row === 'string') {
    // 极简 CSV 解析（无引号内嵌逗号场景足够；导入模板不含复杂文本）
    const [code, label, status, verification] = row.split(',').map((s) => s.trim());
    return { code, label, status, verification };
  }
  return { code: row.code, label: row.label, status: row.status, verification: row.verification };
}

/**
 * 选择并占用一把可用椅。指定 chairId 时必须可用；否则取任意一把可用椅。
 * 重复/并发争抢在串行事务下表现为：后到者在此处得到 CHAIR_NOT_AVAILABLE，
 * 保证最后一把椅只有一个操作成功（不超卖）。
 */
function pickChair(draft, projectId, chairId, ctx, { excludeChairId = null } = {}) {
  let chair;
  if (chairId) {
    chair = mustChair(draft, chairId);
    if (chair.projectId !== projectId) throw new DomainError('CHAIR_PROJECT_MISMATCH', '椅子不属于该项目', { status: 409, chairId });
    if (!isChairFree(chair)) {
      throw new DomainError('CHAIR_NOT_AVAILABLE', `椅子 ${chair.code} 当前状态 ${chair.status}，不可预留`, {
        status: 409,
        chairId,
        chairStatus: chair.status
      });
    }
  } else {
    chair = freeChairs(draft, { projectId }).find((c) => c.id !== excludeChairId);
    if (!chair) {
      throw new DomainError('NO_CHAIR_AVAILABLE', '没有可用的实体儿童椅，儿童席无法建立（拒绝抽象占位）', { status: 409 });
    }
  }
  if (chair.verification === VERIFICATION.PENDING) {
    throw new DomainError('CHAIR_UNVERIFIED', `椅子 ${chair.code} 待核验，不能用于新预留，请先核验或选择其他椅子`, { status: 409, chairId: chair.id });
  }
  return chair;
}

function bindChairToSeat(draft, chair, seat, ctx, { action = 'chair.reserve', comment = null, deploy = false, silent = false } = {}) {
  if (!isChairFree(chair)) {
    throw new DomainError('CHAIR_NOT_AVAILABLE', `椅子 ${chair.code} 不可预留（${chair.status}）`, { status: 409, chairId: chair.id });
  }
  const existing = activeReservationForSeat(draft, seat.id);
  if (existing) throw new DomainError('SEAT_ALREADY_RESERVED', '席位已存在生效预约', { status: 409, seatId: seat.id });
  if (activeReservationForChair(draft, chair.id)) throw new DomainError('CHAIR_ALREADY_BOUND', '椅子已被其他生效预约占用', { status: 409, chairId: chair.id });

  chair.status = CHAIR_STATUS.RESERVED;
  chair.reservedAt = new Date().toISOString();
  const reservation = {
    id: `res_${id('x')}`,
    projectId: seat.projectId,
    chairId: chair.id,
    seatId: seat.id,
    guestId: seat.guestId,
    anonymous: !!seat.anonymous,
    status: RESERVATION_STATUS.ACTIVE,
    deployed: false,
    locked: !!seat.locked,
    source: action,
    comment: comment || null,
    createdAt: new Date().toISOString(),
    history: [{ at: new Date().toISOString(), action, detail: comment || `预留 ${chair.code}` }]
  };
  draft.reservations[reservation.id] = reservation;

  if (deploy) {
    chair.status = CHAIR_STATUS.DEPLOYED;
    chair.deployedAt = new Date().toISOString();
    reservation.deployed = true;
    reservation.deployedAt = chair.deployedAt;
  }

  if (!silent) {
    audit(draft, {
      action,
      projectId: seat.projectId,
      entityType: 'reservation',
      entityId: reservation.id,
      detail: { seatId: seat.id, chairId: chair.id, code: chair.code, deployed: reservation.deployed, comment },
      actor: ctx.actor,
      idempotencyKey: ctx.idempotencyKey
    });
  }
  return reservation;
}

function pushHistory(reservation, action, ctx, detail) {
  reservation.history = reservation.history || [];
  reservation.history.push({ at: new Date().toISOString(), action, detail: detail || null, by: ctx.actor });
}

function assertChildSeatBoundRequirement(draft, seat) {
  if (!seat.requiresChair) {
    throw new DomainError('SEAT_NOT_CHILD', `席位 ${seat.id} 不是儿童席，无需儿童椅`, { status: 400, seatId: seat.id });
  }
  if (seat.guestId) {
    const g = draft.guests[seat.guestId];
    if (!g || g.type !== GUEST_TYPE.CHILD) throw new DomainError('SEAT_NOT_CHILD', '该席位宾客不是儿童', { status: 400, seatId: seat.id });
  }
}

// ============ 故障 / 撤回 实现 ============

function markFault(draft, chair, comment, ctx) {
  if (chair.status === CHAIR_STATUS.DECOMMISSIONED) throw new DomainError('CHAIR_DECOMMISSIONED', '已停用资源不能标记故障', { status: 409, chairId: chair.id });
  const reservation = activeReservationForChair(draft, chair.id);
  const previousStatus = chair.status;
  chair.status = CHAIR_STATUS.FAULTY;
  chair.faultyAt = new Date().toISOString();
  chair.faultNote = comment || null;

  audit(draft, { action: 'chair.fault', projectId: chair.projectId, entityType: 'chair', entityId: chair.id, detail: { code: chair.code, previousStatus, bound: !!reservation, comment }, actor: ctx.actor, idempotencyKey: ctx.idempotencyKey });

  if (reservation) {
    // 关键规则：不挪动席位、不释放预约，只生成待处理方案
    const seat = mustSeat(draft, reservation.seatId);
    if (openIssueForChair(draft, chair.id)) throw new DomainError('ISSUE_ALREADY_OPEN', '该椅已有待处理方案', { status: 409, chairId: chair.id });
    const issue = {
      id: `iss_${id('x')}`,
      projectId: chair.projectId,
      kind: ISSUE_KIND.FAULT,
      status: ISSUE_STATUS.OPEN,
      chairId: chair.id,
      seatId: seat.id,
      reservationId: reservation.id,
      seatLocked: !!seat.locked,
      reservationLocked: !!reservation.locked,
      chairWasDeployed: !!reservation.deployed,
      note: comment || null,
      createdAt: new Date().toISOString(),
      history: [{ at: new Date().toISOString(), action: 'opened', detail: `椅子 ${chair.code} 故障，方案待人工处理` }]
    };
    draft.issues[issue.id] = issue;
    audit(draft, { action: 'issue.open', projectId: chair.projectId, entityType: 'issue', entityId: issue.id, detail: { kind: issue.kind, chairId: chair.id, seatId: seat.id, locked: !!seat.locked }, actor: ctx.actor, idempotencyKey: ctx.idempotencyKey });
    return { chair, issue };
  }
  return { chair, issue: null };
}

function markWithdrawn(draft, chair, comment, ctx, input = {}) {
  if (chair.status === CHAIR_STATUS.DECOMMISSIONED) throw new DomainError('CHAIR_ALREADY_DECOMMISSIONED', '资源已停用', { status: 409, chairId: chair.id });
  const reservation = activeReservationForChair(draft, chair.id);
  const previousStatus = chair.status;
  chair.status = CHAIR_STATUS.DECOMMISSIONED;
  chair.decommissionedAt = new Date().toISOString();
  chair.decommissionNote = comment || null;

  audit(draft, { action: 'chair.withdraw', projectId: chair.projectId, entityType: 'chair', entityId: chair.id, detail: { code: chair.code, previousStatus, bound: !!reservation, comment }, actor: ctx.actor, idempotencyKey: ctx.idempotencyKey });

  if (reservation) {
    // 撤回已绑定（含已布置/已锁定）的资源：不移动席位、不释放预约，只挂待处理方案
    const seat = mustSeat(draft, reservation.seatId);
    if (openIssueForChair(draft, chair.id)) throw new DomainError('ISSUE_ALREADY_OPEN', '该椅已有待处理方案', { status: 409, chairId: chair.id });
    const issue = {
      id: `iss_${id('x')}`,
      projectId: chair.projectId,
      kind: ISSUE_KIND.WITHDRAWN,
      status: ISSUE_STATUS.OPEN,
      chairId: chair.id,
      seatId: seat.id,
      reservationId: reservation.id,
      seatLocked: !!seat.locked,
      reservationLocked: !!reservation.locked,
      chairWasDeployed: !!reservation.deployed,
      note: comment || null,
      createdAt: new Date().toISOString(),
      history: [{ at: new Date().toISOString(), action: 'opened', detail: `椅子 ${chair.code} 被撤回，方案待人工处理` }]
    };
    draft.issues[issue.id] = issue;
    audit(draft, { action: 'issue.open', projectId: chair.projectId, entityType: 'issue', entityId: issue.id, detail: { kind: issue.kind, chairId: chair.id, seatId: seat.id }, actor: ctx.actor, idempotencyKey: ctx.idempotencyKey });
    return { chair, issue };
  }
  return { chair, issue: null };
}

/**
 * 修复：故障且无生效预约（或方案选择保留）的椅子恢复可用
 */
function repairChair(draft, chair, ctx, input = {}) {
  if (chair.status !== CHAIR_STATUS.FAULTY) throw new DomainError('CHAIR_NOT_FAULTY', `仅故障资源可修复，当前 ${chair.status}`, { status: 409, chairId: chair.id });
  const reservation = activeReservationForChair(draft, chair.id);
  if (reservation && !input.keepReservation) {
    throw new DomainError('CHAIR_STILL_BOUND', '故障椅仍绑定生效预约，请通过待处理方案“保留原椅(keep)”完成修复', { status: 409, chairId, reservationId: reservation.id });
  }
  chair.status = CHAIR_STATUS.RESERVED; // 仍被预约占用 -> 回到已预留
  chair.repairedAt = new Date().toISOString();
  delete chair.faultyAt;
  chair.faultNote = null;
  audit(draft, { action: 'chair.repair', projectId: chair.projectId, entityType: 'chair', entityId: chair.id, detail: { code: chair.code, keptReservation: !!reservation }, actor: ctx.actor, idempotencyKey: ctx.idempotencyKey });
  if (reservation) {
    const issue = openIssueForChair(draft, chair.id);
    if (issue) {
      issue.status = ISSUE_STATUS.RESOLVED;
      issue.resolvedAt = new Date().toISOString();
      issue.resolution = ISSUE_RESOLUTION.KEEP;
      issue.resolvedBy = ctx.actor;
      issue.history.push({ at: new Date().toISOString(), action: 'resolved', detail: '修复后保留原椅与原席' });
      audit(draft, { action: 'issue.resolve', projectId: chair.projectId, entityType: 'issue', entityId: issue.id, detail: { resolution: ISSUE_RESOLUTION.KEEP }, actor: ctx.actor, idempotencyKey: ctx.idempotencyKey });
    }
  } else {
    chair.status = CHAIR_STATUS.AVAILABLE;
  }
  return { chair, issue: openIssueForChair(draft, chair.id) };
}

// ============ 待处理方案解决 ============

function resolveReplace(draft, issue, seat, reservation, input, ctx) {
  const faultyChair = mustChair(draft, reservation.chairId);
  const wasDeployed = reservation.deployed;
  let newChair;
  if (input.replacementChairId) {
    newChair = draft.chairs[input.replacementChairId];
    if (!newChair) throw new DomainError('CHAIR_NOT_FOUND', '替换椅不存在', { status: 404, chairId: input.replacementChairId });
    if (newChair.projectId !== issue.projectId) throw new DomainError('CHAIR_PROJECT_MISMATCH', '替换椅不属于该项目');
    if (!isChairFree(newChair)) throw new DomainError('CHAIR_NOT_AVAILABLE', `替换椅 ${newChair.code} 不可用（${newChair.status}）`, { status: 409, chairId: newChair.id });
    if (newChair.verification === VERIFICATION.PENDING) throw new DomainError('CHAIR_UNVERIFIED', '替换椅待核验', { status: 409, chairId: newChair.id });
  } else {
    newChair = freeChairs(draft, { projectId: issue.projectId }).find((c) => c.id !== faultyChair.id);
    if (!newChair) throw new DomainError('NO_CHAIR_AVAILABLE', '没有可用于替换的实体椅，方案无法以 replace 解决（可选择 revoke）', { status: 409, issueId: issue.id });
  }

  reservation.status = RESERVATION_STATUS.REPLACED;
  reservation.endedAt = new Date().toISOString();
  pushHistory(reservation, 'replaced', ctx, `因 ${issue.kind} 替换为 ${newChair.code}`);

  const newReservation = {
    id: `res_${id('x')}`,
    projectId: issue.projectId,
    chairId: newChair.id,
    seatId: seat.id,
    guestId: seat.guestId,
    anonymous: !!seat.anonymous,
    status: RESERVATION_STATUS.ACTIVE,
    deployed: wasDeployed,
    locked: reservation.locked,
    source: 'issue-replace',
    createdAt: new Date().toISOString(),
    history: [{ at: new Date().toISOString(), action: 'reserved', detail: `替换故障/撤回椅 ${faultyChair.code}` }]
  };
  newChair.status = wasDeployed ? CHAIR_STATUS.DEPLOYED : CHAIR_STATUS.RESERVED;
  if (wasDeployed) {
    newChair.deployedAt = new Date().toISOString();
    newReservation.deployedAt = newChair.deployedAt;
  } else {
    newChair.reservedAt = new Date().toISOString();
  }
  draft.reservations[newReservation.id] = newReservation;

  issue.status = ISSUE_STATUS.RESOLVED;
  issue.resolvedAt = new Date().toISOString();
  issue.resolution = ISSUE_RESOLUTION.REPLACE;
  issue.replacementChairId = newChair.id;
  issue.replacementReservationId = newReservation.id;
  issue.resolvedBy = ctx.actor;
  issue.history.push({ at: new Date().toISOString(), action: 'resolved', detail: `人工替换为 ${newChair.code}` });

  audit(draft, { action: 'issue.resolve', projectId: issue.projectId, entityType: 'issue', entityId: issue.id, detail: { resolution: 'replace', oldChairId: faultyChair.id, newChairId: newChair.id, newReservationId: newReservation.id, seatLocked: seat.locked, wasDeployed }, actor: ctx.actor, idempotencyKey: ctx.idempotencyKey });

  // 故障/撤回椅维持其状态，不自动回库（需单独盘点/修复/停用）
  return { issue, reservation: newReservation, chair: newChair };
}

function resolveRevoke(draft, issue, seat, reservation, input, ctx) {
  // 锁定席默认禁止撤销（绝不悄悄移动/抹掉已锁定儿童席），需显式 force 并留痕
  if ((seat.locked || reservation.locked) && !input.force) {
    throw new DomainError('SEAT_LOCKED', '该儿童席已锁定，撤销需显式 force 并承担审计责任', { status: 423, issueId: issue.id, seatId: seat.id });
  }
  const chair = mustChair(draft, reservation.chairId);
  reservation.status = RESERVATION_STATUS.REVOKED;
  reservation.endedAt = new Date().toISOString();
  reservation.endReason = 'issue-revoke';
  pushHistory(reservation, 'revoked', ctx, `因 ${issue.kind} 人工撤销儿童席`);

  // 席位卡保留为“空儿童位”会违反强绑定不变量；按撤销语义移除席位卡（儿童宾客回到未入座状态）
  delete draft.seats[seat.id];

  issue.status = ISSUE_STATUS.RESOLVED;
  issue.resolvedAt = new Date().toISOString();
  issue.resolution = ISSUE_RESOLUTION.REVOKE;
  issue.resolvedBy = ctx.actor;
  issue.history.push({ at: new Date().toISOString(), action: 'resolved', detail: '人工撤销席位与预约' });

  audit(draft, { action: 'issue.resolve', projectId: issue.projectId, entityType: 'issue', entityId: issue.id, detail: { resolution: 'revoke', chairId: chair.id, seatId: seat.id, guestId: seat.guestId, force: !!input.force }, actor: ctx.actor, idempotencyKey: ctx.idempotencyKey });
  return { issue, revokedSeatId: seat.id, chairId: chair.id };
}

function resolveKeep(draft, issue, seat, reservation, input, ctx) {
  const chair = mustChair(draft, reservation.chairId);
  if (issue.kind === ISSUE_KIND.WITHDRAWN) {
    throw new DomainError('KEEP_UNSUPPORTED', '撤回（停用）资源不能继续沿用，只能替换或撤销', { status: 400, issueId: issue.id });
  }
  if (chair.status !== CHAIR_STATUS.FAULTY) throw new DomainError('CHAIR_NOT_FAULTY', '仅故障资源可修复保留', { status: 409, chairId: chair.id });
  const wasDeployed = reservation.deployed;
  chair.status = wasDeployed ? CHAIR_STATUS.DEPLOYED : CHAIR_STATUS.RESERVED;
  chair.repairedAt = new Date().toISOString();
  delete chair.faultyAt;
  chair.faultNote = null;
  reservation.history.push({ at: new Date().toISOString(), action: 'kept-after-repair', detail: '修复后沿用原椅，席位不变' });

  issue.status = ISSUE_STATUS.RESOLVED;
  issue.resolvedAt = new Date().toISOString();
  issue.resolution = ISSUE_RESOLUTION.KEEP;
  issue.resolvedBy = ctx.actor;
  issue.history.push({ at: new Date().toISOString(), action: 'resolved', detail: '修复后保留原椅，未移动锁定席' });

  audit(draft, { action: 'issue.resolve', projectId: issue.projectId, entityType: 'issue', entityId: issue.id, detail: { resolution: 'keep', chairId: chair.id, seatId: seat.id, seatLocked: seat.locked }, actor: ctx.actor, idempotencyKey: ctx.idempotencyKey });
  return { issue, reservation, chair };
}

// ============ 自动排座算法（含诊断） ============

function computeAutoSeating(draft, projectId, input = {}, { dryRun = false } = {}) {
  const tables = Object.values(draft.tables).filter((t) => t.projectId === projectId);
  const seatedGuestIds = new Set(Object.values(draft.seats).filter((s) => s.projectId === projectId && s.guestId).map((s) => s.guestId));
  let guests = Object.values(draft.guests).filter((g) => g.projectId === projectId && !seatedGuestIds.has(g.id));
  if (Array.isArray(input.guestIds) && input.guestIds.length) {
    const wanted = new Set(input.guestIds);
    guests = guests.filter((g) => wanted.has(g.id));
  }

  // 儿童优先（实体椅是稀缺资源），其次 together 组规模大的优先
  const togetherDegree = (g) => (g.relations || []).filter((r) => r.type === RELATION.TOGETHER).length;
  guests.sort((a, b) => {
    if ((a.type === GUEST_TYPE.CHILD) !== (b.type === GUEST_TYPE.CHILD)) return a.type === GUEST_TYPE.CHILD ? -1 : 1;
    return togetherDegree(b) - togetherDegree(a);
  });

  // 模拟状态
  const used = new Map(tables.map((t) => [t.id, occupancy(draft, t.id)]));
  const guestTable = new Map(Object.values(draft.seats).filter((s) => s.projectId === projectId && s.guestId).map((s) => [s.guestId, s.tableId]));
  const availableChairs = freeChairs(draft, { projectId, includePendingVerification: false });

  const decisions = [];
  const unresolved = [];

  const tableDiag = tables.map((t) => ({
    tableId: t.id,
    name: t.name,
    capacity: t.capacity,
    occupiedBefore: used.get(t.id),
    freeBefore: t.capacity - used.get(t.id)
  }));

  for (const guest of guests) {
    const isChild = guest.type === GUEST_TYPE.CHILD;
    let chosen = null;
    const reasons = [];

    for (const table of tables) {
      const tableReasons = [];
      if (used.get(table.id) >= table.capacity) tableReasons.push('TABLE_FULL');
      const { togetherViolations, avoidViolations } = simulatedRelations(draft, guestTable, guest, table.id);
      if (avoidViolations.length) tableReasons.push('AVOID_TOGETHER_AT_TABLE');
      if (togetherViolations.length) tableReasons.push('TOGETHER_PARTNER_AT_OTHER_TABLE');
      if (isChild && availableChairs.length === 0) tableReasons.push('NO_AVAILABLE_CHAIR');
      if (tableReasons.length === 0) {
        chosen = table;
        break;
      }
      reasons.push({ tableId: table.id, reasons: tableReasons });
    }

    if (!chosen) {
      const summary = summarizeUnresolved(reasons, isChild && availableChairs.length === 0);
      unresolved.push({ guestId: guest.id, name: guest.name, type: guest.type, reason: summary.primary, detail: reasons });
      continue;
    }

    let chairId = null;
    if (isChild) {
      const chair = availableChairs.shift();
      chairId = chair.id;
    }
    used.set(chosen.id, used.get(chosen.id) + 1);
    guestTable.set(guest.id, chosen.id);
    decisions.push({ guestId: guest.id, name: guest.name, type: guest.type, tableId: chosen.id, tableName: chosen.name, chairId });
  }

  return {
    projectId,
    dryRun,
    decisions,
    unresolved,
    feasible: unresolved.length === 0,
    tables: tableDiag.map((t) => ({ ...t, occupiedAfter: used.get(t.tableId), freeAfter: t.capacity - used.get(t.tableId) })),
    chairInventory: chairInventory(draft, projectId),
    freeChairsForRun: availableChairs.length
  };
}

function simulatedRelations(draft, guestTable, guest, tableId) {
  const togetherViolations = [];
  const avoidViolations = [];
  for (const rel of guest.relations || []) {
    const otherTable = guestTable.get(rel.guestId);
    if (!otherTable) continue;
    if (rel.type === RELATION.TOGETHER && otherTable !== tableId) togetherViolations.push(rel.guestId);
    if (rel.type === RELATION.AVOID && otherTable === tableId) avoidViolations.push(rel.guestId);
  }
  return { togetherViolations, avoidViolations };
}

function summarizeUnresolved(perTable, noChair) {
  if (noChair) return { primary: 'NO_AVAILABLE_CHAIR' };
  if (perTable.every((r) => r.reasons.includes('TABLE_FULL'))) return { primary: 'ALL_TABLES_FULL' };
  if (perTable.length && perTable.some((r) => r.reasons.includes('AVOID_TOGETHER_AT_TABLE'))) return { primary: 'RELATION_AVOID_BLOCKS_ALL_TABLES' };
  if (perTable.length && perTable.some((r) => r.reasons.includes('TOGETHER_PARTNER_AT_OTHER_TABLE'))) return { primary: 'TOGETHER_CANNOT_BE_SATISFIED' };
  return { primary: 'NO_FEASIBLE_TABLE' };
}

module.exports = { SeatService };
