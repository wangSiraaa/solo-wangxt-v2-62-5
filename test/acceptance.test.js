'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { memoryService, tempDbService, freshProject, addChild } = require('./helpers');
const { SeatService } = require('../src/service');

const expectError = async (promise, code) => {
  try {
    await promise;
  } catch (err) {
    if (code) assert.equal(err.code, code, `期望错误码 ${code}，实际 ${err.code}`);
    return err;
  }
  throw new assert.AssertionError({ message: `预期失败 ${code || '(任意错误)'}，但操作成功` });
};

// ---------- 验收 1：两把实体椅分别预留后，刷新（重读）仍保持 ----------

test('AC1 两把实体椅分别预留，重新从磁盘加载后绑定关系与状态保持', async () => {
  const { service, dbPath } = tempDbService();
  const { projectId, chairs } = await freshProject(service, { tableCap: 10, chairs: 2 });
  await addChild(service, projectId, '儿童甲', chairs[0].id);

  // 匿名儿童椅占位也必须绑定具体资源
  const anon = await service.createSeat(projectId, { tableId: 't1', anonymous: true, chairId: chairs[1].id, tableCardLabel: '加位-1' });

  // 重新构建服务（模拟刷新 / 进程重启）
  const reloaded = new SeatService({ dbPath });
  const state = await reloaded.getProjectState(projectId);
  const active = state.reservations.filter((r) => r.status === 'active');
  assert.equal(active.length, 2);
  const byChair = Object.fromEntries(active.map((r) => [r.chairId, r]));
  assert.ok(byChair[chairs[0].id]);
  assert.ok(byChair[chairs[1].id]);
  const c0 = state.chairs.find((c) => c.id === chairs[0].id);
  const c1 = state.chairs.find((c) => c.id === chairs[1].id);
  assert.equal(c0.status, 'reserved');
  assert.equal(c1.status, 'reserved');
  const anonSeat = state.seats.find((s) => s.id === anon.seat.id);
  assert.equal(anonSeat.anonymous, true);
  assert.equal(byChair[chairs[1].id].seatId, anonSeat.id);
});

// ---------- 验收 2：最后一把椅被重复 / 并发争抢时仅一个成功 ----------

test('AC2 顺序重复预留同一把椅，仅首次成功（不超卖）', async () => {
  const service = memoryService();
  const { projectId, chairs } = await freshProject(service, { tableCap: 10, chairs: 1 });
  await addChild(service, projectId, '儿童甲', chairs[0].id);
  const kid2 = await service.addGuest(projectId, { name: '儿童乙', type: 'child' });
  await expectError(
    service.createSeat(projectId, { tableId: 't1', guestId: kid2.id, chairId: chairs[0].id }),
    'CHAIR_NOT_AVAILABLE'
  );
  // 不指定椅子自动分配时：无可用椅，拒绝建立抽象占位
  const kid3 = await service.addGuest(projectId, { name: '儿童丙', type: 'child' });
  await expectError(
    service.createSeat(projectId, { tableId: 't1', guestId: kid3.id }),
    'NO_CHAIR_AVAILABLE'
  );
  const state = await service.getProjectState(projectId);
  assert.equal(state.reservations.filter((r) => r.status === 'active').length, 1);
  assert.equal(state.inventory.reserved, 1);
  assert.equal(state.inventory.available, 0);
});

test('AC2b 并发争抢最后一把椅，恰好一个成功，其余失败且状态一致', async () => {
  const service = memoryService();
  const { projectId, chairs } = await freshProject(service, { tableCap: 10, chairs: 1 });
  const kids = [];
  for (let i = 0; i < 5; i += 1) {
        kids.push(await service.addGuest(projectId, { name: `并发儿童${i}`, type: 'child' }));
  }
  const results = await Promise.allSettled(
    kids.map((k) => service.createSeat(projectId, { tableId: 't1', guestId: k.id, chairId: chairs[0].id }))
  );
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 4);
  for (const r of rejected) assert.equal(r.reason.code, 'CHAIR_NOT_AVAILABLE');

  const state = await service.getProjectState(projectId);
  const active = state.reservations.filter((r) => r.status === 'active');
  assert.equal(active.length, 1);
  assert.equal(active[0].chairId, chairs[0].id);
});

test('AC2c 幂等：同一幂等键重复提交同一预留，两次得到同一结果且只占一把椅', async () => {
  const service = memoryService();
  const { projectId, chairs } = await freshProject(service, { tableCap: 10, chairs: 1 });
  const kid = await service.addGuest(projectId, { name: '幂等儿童', type: 'child' });
  const key = 'idem-reserve-001';
  const body = { tableId: 't1', guestId: kid.id, chairId: chairs[0].id };
  const r1 = await service.createSeat(projectId, body, { idempotencyKey: key, actor: 'u1' });
  const r2 = await service.createSeat(projectId, body, { idempotencyKey: key, actor: 'u1' });
  assert.equal(r1.reservation.id, r2.reservation.id);
  const state = await service.getProjectState(projectId);
  assert.equal(state.reservations.filter((r) => r.status === 'active').length, 1);
  // 同键不同体 -> 冲突
  await expectError(
    service.createSeat(projectId, { tableId: 't1', guestId: kid.id, chairId: 'OTHER' }, { idempotencyKey: key, actor: 'u1' }),
    'IDEMPOTENCY_KEY_REUSED'
  );
});

// ---------- 验收 3：换桌目标无可用椅时，原预约完整保留 ----------

test('AC3 换桌目标桌无可用实体椅：整体回滚，原席位/预约/椅子状态不变', async () => {
  const service = memoryService();
  const { projectId, chairs } = await freshProject(service, { tableCap: 10, chairs: 1 });
  const { seatId, reservationId } = await addChild(service, projectId, '儿童甲', chairs[0].id);
  await service.addTable(projectId, { id: 't2', name: '目标桌', capacity: 10 });
  // t2 没有任何可用椅（唯一一把已在原席），且未提供 targetChairId
  await expectError(
    service.transferSeat(seatId, { targetTableId: 't2' }),
    'NO_CHAIR_AVAILABLE'
  );
  const state = await service.getProjectState(projectId);
  const seat = state.seats.find((s) => s.id === seatId);
  assert.equal(seat.tableId, 't1');
  const res = state.reservations.find((r) => r.id === reservationId);
  assert.equal(res.status, 'active');
  assert.equal(res.chairId, chairs[0].id);
  assert.equal(state.chairs.find((c) => c.id === chairs[0].id).status, 'reserved');
});

test('AC3b 换桌成功时旧椅归还、新椅预留；桌容量不足/关系冲突时同样回滚', async () => {
  const service = memoryService();
  const { projectId, chairs } = await freshProject(service, { tableCap: 2, chairs: 2 });
  const { seatId } = await addChild(service, projectId, '儿童甲', chairs[0].id);
  await service.addTable(projectId, { id: 't2', name: '目标桌', capacity: 2 });

  // 容量：t2 先坐满
  const a = await service.addGuest(projectId, { name: '成人X', type: 'adult' });
  const b = await service.addGuest(projectId, { name: '成人Y', type: 'adult' });
  await service.createSeat(projectId, { tableId: 't2', guestId: a.id });
  await service.createSeat(projectId, { tableId: 't2', guestId: b.id });
  await expectError(service.transferSeat(seatId, { targetTableId: 't2' }), 'TABLE_CAPACITY_EXCEEDED');

  // 释放 t2 后换桌成功
  const seats = (await service.getProjectState(projectId)).seats;
  await service.releaseSeat(seats.find((s) => s.guestId === b.id).id);
  const result = await service.transferSeat(seatId, { targetTableId: 't2' });
  assert.equal(result.seat.tableId, 't2');
  assert.equal(result.newChairId, chairs[1].id);
  const state = await service.getProjectState(projectId);
  assert.equal(state.chairs.find((c) => c.id === chairs[0].id).status, 'returned');
  assert.equal(state.chairs.find((c) => c.id === chairs[1].id).status, 'reserved');
  // 清点旧椅回库
  await service.checkinChair(chairs[0].id);
  assert.equal((await service.listChairs(projectId)).find((c) => c.id === chairs[0].id).status, 'available');
});

test('AC3c 关系约束：avoid 冲突阻止同桌，together 要求同伴同桌', async () => {
  const service = memoryService();
  const { projectId, chairs } = await freshProject(service, { tableCap: 10, chairs: 2 });
  await service.addTable(projectId, { id: 't2', name: '二号桌', capacity: 10 });
  const kid = await service.addGuest(projectId, { name: '儿童', type: 'child' });
  const foe = await service.addGuest(projectId, { name: '不合的人', type: 'adult' });
  await service.setRelation(projectId, kid.id, foe.id, 'avoid');
  await service.createSeat(projectId, { tableId: 't2', guestId: foe.id });
  await expectError(
    service.createSeat(projectId, { tableId: 't2', guestId: kid.id, chairId: chairs[0].id }),
    'RELATION_VIOLATION'
  );
  // together：同伴在 t1 时，儿童去 t2 会冲突
  const mom = await service.addGuest(projectId, { name: '妈妈', type: 'adult' });
  await service.setRelation(projectId, kid.id, mom.id, 'together');
  await service.createSeat(projectId, { tableId: 't1', guestId: mom.id });
  await expectError(
    service.createSeat(projectId, { tableId: 't2', guestId: kid.id, chairId: chairs[0].id }),
    'RELATION_VIOLATION'
  );
});

// ---------- 验收 4：已布置 / 已锁定资源故障后仅进入待处理，不挪动 ----------

test('AC4 已布置椅子故障：席位与锁定不动，生成 open 方案，替换/保留可解决', async () => {
  const service = memoryService();
  const { projectId, chairs } = await freshProject(service, { tableCap: 10, chairs: 3 });
  const { seatId } = await addChild(service, projectId, '儿童甲', chairs[0].id);
  await service.deployChair(seatId);
  await service.setSeatLock(seatId, true);

  const fault = await service.setChairStatus(chairs[0].id, 'faulty', { comment: '椅腿断裂' });
  assert.ok(fault.issue);
  assert.equal(fault.issue.status, 'open');
  assert.equal(fault.issue.seatLocked, true);
  assert.equal(fault.issue.chairWasDeployed, true);

  // 席位、桌卡、锁定与预约全部保持
  let state = await service.getProjectState(projectId);
  const seat = state.seats.find((s) => s.id === seatId);
  assert.equal(seat.locked, true);
  assert.equal(seat.tableId, 't1');
  const res = state.reservations.find((r) => r.seatId === seatId && r.status === 'active');
  assert.equal(res.chairId, chairs[0].id);
  assert.equal(res.deployed, true);
  // 自动排座 / 换座也不允许悄悄动锁定席
  await expectError(service.transferSeat(seatId, { targetTableId: 't1' }), 'SEAT_LOCKED');

  // 人工替换为另一把椅（锁定席允许替换，锁与部署状态延续）
  const resolved = await service.resolveIssue(fault.issue.id, { resolution: 'replace' });
  assert.equal(resolved.chair.id, chairs[1].id);
  state = await service.getProjectState(projectId);
  const newRes = state.reservations.find((r) => r.id === resolved.reservation.id);
  assert.equal(newRes.status, 'active');
  assert.equal(newRes.deployed, true);
  assert.equal(newRes.locked, true);
  assert.equal(state.chairs.find((c) => c.id === chairs[1].id).status, 'deployed');
  const issueState = state.issues.find((i) => i.id === fault.issue.id);
  assert.equal(issueState.status, 'resolved');
});

test('AC4b 已锁定席的撤回方案默认禁止 revoke，需 force；故障椅 keep 修复不动席位', async () => {
  const service = memoryService();
  const { projectId, chairs } = await freshProject(service, { tableCap: 10, chairs: 2 });
  const { seatId } = await addChild(service, projectId, '儿童甲', chairs[0].id);
  await service.setSeatLock(seatId, true);

  // 故障 -> keep 修复：席位完全不变
  let r = await service.setChairStatus(chairs[0].id, 'faulty', { comment: '松了一颗螺丝' });
  const issue = r.issue;
  await expectError(service.resolveIssue(issue.id, { resolution: 'revoke' }), 'SEAT_LOCKED');
  const kept = await service.resolveIssue(issue.id, { resolution: 'keep' });
  assert.equal(kept.reservation.id, (await service.getProjectState(projectId)).reservations.find((x) => x.seatId === seatId && x.status === 'active').id);

  // 撤回 -> 第二把椅也不用，只能 force revoke
  r = await service.setChairStatus(chairs[0].id, 'decommissioned', { comment: '批次召回' });
  assert.equal(r.issue.kind, 'chair_withdrawn');
  await expectError(service.resolveIssue(r.issue.id, { resolution: 'revoke' }), 'SEAT_LOCKED');
  await expectError(service.resolveIssue(r.issue.id, { resolution: 'keep' }), 'KEEP_UNSUPPORTED');
  const revoked = await service.resolveIssue(r.issue.id, { resolution: 'revoke', force: true });
  assert.equal(revoked.revokedSeatId, seatId);
  const state = await service.getProjectState(projectId);
  assert.equal(state.seats.find((s) => s.id === seatId), undefined);
  assert.equal(state.reservations.find((x) => x.seatId === seatId && x.status === 'active'), undefined);
});

test('AC4c 未绑定资源故障/停用不产生方案，仅状态变化', async () => {
  const service = memoryService();
  const { projectId, chairs } = await freshProject(service, { tableCap: 10, chairs: 2 });
  const f = await service.setChairStatus(chairs[1].id, 'faulty', { comment: '库存损坏' });
  assert.equal(f.issue, null);
  assert.equal(f.chair.status, 'faulty');
  const issues = await service.issues(projectId, { status: 'open' });
  assert.equal(issues.length, 0);
});

// ---------- 验收 5：旧项目占位迁移为待核验资源，保留容量/锁定/桌卡 ----------

const LEGACY = {
  version: 1,
  project: { id: 'legacy-ac5', name: '旧年会', date: '2025-12-24' },
  tables: [
    { id: 'L1', name: '旧桌一', capacity: 8 },
    { id: 'L2', name: '旧桌二', capacity: 6 }
  ],
  guests: [
    { id: 'g1', name: '爸爸', type: 'adult', tableId: 'L1', seatLabel: 'A-01', locked: false },
    { id: 'g2', name: '孩子', type: 'child', tableId: 'L1', seatLabel: 'A-02', locked: true, requiresChair: true }
  ],
  childPlaceholders: [{ id: 'ph9', tableId: 'L2', seatLabel: '加位-K1', locked: false }]
};

test('AC5 v1 迁移：容量/锁定/桌卡保留，儿童席绑定待核验资源，幂等', async () => {
  const service = memoryService();
  const summary = await service.importLegacy(LEGACY);
  assert.equal(summary.tables, 2);
  assert.equal(summary.childSeats, 2);
  assert.equal(summary.chairs, 2);
  assert.equal(summary.reservations, 2);

  const state = await service.getProjectState('legacy-ac5');
  const t1 = state.tables.find((t) => t.id === 'L1');
  assert.equal(t1.capacity, 8);

  // 桌卡与锁定行为保留
  const childSeat = state.seats.find((s) => s.guestId === 'g2');
  assert.equal(childSeat.tableCardLabel, 'A-02');
  assert.equal(childSeat.locked, true);
  assert.equal(childSeat.tableId, 'L1');

  // 绑定具体资源，且为待核验
  const res = state.reservations.find((r) => r.seatId === childSeat.id);
  assert.equal(res.status, 'active');
  const chair = state.chairs.find((c) => c.id === res.chairId);
  assert.equal(chair.verification, 'pending');
  assert.equal(chair.status, 'reserved');

  // 匿名占位同样绑定
  const anonSeat = state.seats.find((s) => s.anonymous);
  assert.equal(anonSeat.tableCardLabel, '加位-K1');
  const anonRes = state.reservations.find((r) => r.seatId === anonSeat.id);
  assert.ok(anonRes);
  assert.equal(state.chairs.find((c) => c.id === anonRes.chairId).verification, 'pending');

  // 桌位可视化中可见迁移椅与待核验状态
  const view = await service.tableView('legacy-ac5');
  const vL1 = view.find((v) => v.tableId === 'L1');
  assert.equal(vL1.capacity, 8);
  assert.equal(vL1.used, 2);
  const card = vL1.seats.find((s) => s.tableCardLabel === 'A-02');
  assert.equal(card.chair.verification, 'pending');
  assert.equal(card.locked, true);

  // 待核验椅不能直接布置，核验后可以
  await expectError(service.deployChair(childSeat.id), 'CHAIR_UNVERIFIED');
  await service.verifyChair(chair.id);
  await service.deployChair(childSeat.id);
  assert.equal((await service.listChairs('legacy-ac5')).find((c) => c.id === chair.id).status, 'deployed');

  // 迁移幂等：重复导入同一旧项目被拒绝（项目已存在），数据不重复
  await expectError(service.importLegacy(LEGACY), 'LEGACY_PROJECT_EXISTS');
  const again = await service.getProjectState('legacy-ac5');
  assert.equal(again.chairs.length, 2);

  // 迁移留有审计
  const history = await service.auditHistory({ projectId: 'legacy-ac5', action: 'migration.legacy-import' });
  assert.equal(history.items.length, 1);
});

test('AC5b 迁移来的待核验椅故障同样只进待处理，且不自动移动锁定席', async () => {
  const service = memoryService();
  await service.importLegacy(LEGACY);
  const state = await service.getProjectState('legacy-ac5');
  const lockedSeat = state.seats.find((s) => s.guestId === 'g2');
  const res = state.reservations.find((r) => r.seatId === lockedSeat.id);
  const chair = state.chairs.find((c) => c.id === res.chairId);

  // 待核验阶段发现损坏 -> 故障 -> 待处理，锁定席不动
  const f = await service.setChairStatus(chair.id, 'faulty', { comment: '核验发现开裂' });
  assert.equal(f.issue.status, 'open');
  assert.equal(f.issue.seatLocked, true);
  const after = await service.getProjectState('legacy-ac5');
  assert.ok(after.seats.find((s) => s.id === lockedSeat.id && s.locked === true));
  assert.equal(after.reservations.find((r) => r.id === res.id).status, 'active');
});

// ---------- 其余系统保证：容量、自动排座诊断、审计/回滚、导入导出 ----------

test('桌容量硬约束：超容量直接拒绝', async () => {
  const service = memoryService();
  const { projectId } = await freshProject(service, { tableCap: 1, chairs: 0 });
  const a = await service.addGuest(projectId, { name: '甲', type: 'adult' });
  await service.createSeat(projectId, { tableId: 't1', guestId: a.id });
  const b = await service.addGuest(projectId, { name: '乙', type: 'adult' });
  await expectError(service.createSeat(projectId, { tableId: 't1', guestId: b.id }), 'TABLE_CAPACITY_EXCEEDED');
});

test('自动排座：资源不足时整体回滚并给诊断；补齐资源后成功', async () => {
  const service = memoryService();
  const { projectId } = await freshProject(service, { tableCap: 10, chairs: 1 });
  await service.addTable(projectId, { id: 't2', name: '二桌', capacity: 10 });
  await service.addGuest(projectId, { name: '成人', type: 'adult' });
  await service.addGuest(projectId, { name: '儿童1', type: 'child' });
  await service.addGuest(projectId, { name: '儿童2', type: 'child' });

  const diag = await service.diagnoseAutoSeating(projectId);
  assert.equal(diag.feasible, false);
  assert.equal(diag.unresolved.some((u) => u.reason === 'NO_AVAILABLE_CHAIR'), true);

  await expectError(service.autoSeat(projectId), 'AUTOSEAT_HAS_UNRESOLVED');
  let state = await service.getProjectState(projectId);
  assert.equal(state.seats.length, 0); // 整体回滚

  await service.addChair(projectId, { code: 'CH-0002' });
  const result = await service.autoSeat(projectId);
  assert.equal(result.seated, 3);
  state = await service.getProjectState(projectId);
  assert.equal(state.seats.length, 3);
  assert.equal(state.reservations.filter((r) => r.status === 'active').length, 2);
});

test('失败操作回滚领域变更但保留失败审计；所有预留/转移/释放都可审计', async () => {
  const service = memoryService();
  const { projectId, chairs } = await freshProject(service, { tableCap: 10, chairs: 1 });
  const kid = await service.addGuest(projectId, { name: '儿童', type: 'child' });
  // 无可用椅的失败尝试
  await service.addGuest(projectId, { name: '另一儿童', type: 'child' });
  const kid2 = (await service.getProjectState(projectId)).guests.find((g) => g.name === '另一儿童');

  await service.createSeat(projectId, { tableId: 't1', guestId: kid.id, chairId: chairs[0].id });
  await expectError(service.createSeat(projectId, { tableId: 't1', guestId: kid2.id }), 'NO_CHAIR_AVAILABLE');

  const failed = await service.auditHistory({ projectId, result: 'failed' });
  assert.ok(failed.items.some((a) => a.reason === 'NO_CHAIR_AVAILABLE'));

  // 完整生命周期审计
  const seat = (await service.getProjectState(projectId)).seats.find((s) => s.guestId === kid.id);
  await service.deployChair(seat.id);
  await service.undeployChair(seat.id);
  await service.releaseSeat(seat.id, { reason: '离席' });
  const history = await service.auditHistory({ projectId });
  const actions = history.items.map((a) => a.action);
  for (const expected of ['chair.reserve', 'chair.deploy', 'chair.undeploy', 'chair.release', 'seat.release']) {
    assert.ok(actions.includes(expected), `缺少审计动作 ${expected}`);
  }
});

test('CSV 批量导入导出行往返一致，坏行整批回滚', async () => {
  const service = memoryService();
  const { projectId } = await freshProject(service, { tableCap: 10, chairs: 0 });
  const csv = 'code,label,status,verification\nC-1,小椅A,available,verified\nC-2,小椅B,available,verified\n';
  const { parseChairsCsv } = require('../src/csv');
  const imported = await service.importChairs(projectId, parseChairsCsv(csv));
  assert.equal(imported.imported, 2);

  // 重复 code 整批回滚
  const bad = 'code,label\nC-1,重复\nC-99,新\n';
  await expectError(service.importChairs(projectId, parseChairsCsv(bad)), 'IMPORT_CODE_EXISTS');
  const inv = await service.chairInventory(projectId);
  assert.equal(inv.total, 2);

  // 禁止直接导入非 available 状态
  await expectError(
    service.importChairs(projectId, [{ code: 'C-3', status: 'deployed' }]),
    'IMPORT_INVALID'
  );

  const rows = await service.exportChairs(projectId);
  const codes = rows.map((r) => r.code).sort();
  assert.deepEqual(codes, ['C-1', 'C-2']);
  const { chairsToCsv } = require('../src/csv');
  const out = chairsToCsv(rows);
  assert.ok(out.includes('C-1') && out.includes('available'));
});

test('故障资源不占用可用库存：被预约椅故障后不会被再次超卖', async () => {
  const service = memoryService();
  const { projectId, chairs } = await freshProject(service, { tableCap: 10, chairs: 1 });
  const { seatId } = await addChild(service, projectId, '儿童甲', chairs[0].id);
  await service.setChairStatus(chairs[0].id, 'faulty');
  // 故障椅（仍绑定 active 预约）不能被第二个席抢用
  const kid2 = await service.addGuest(projectId, { name: '儿童乙', type: 'child' });
  await expectError(service.createSeat(projectId, { tableId: 't1', guestId: kid2.id }), 'NO_CHAIR_AVAILABLE');
  // 原席仍在，方案 open
  const issues = await service.issues(projectId, { status: 'open' });
  assert.equal(issues.length, 1);
  const state = await service.getProjectState(projectId);
  assert.ok(state.seats.find((s) => s.id === seatId));
});

test('幂等失败重放返回相同错误，且不重复落审计、不产生副作用', async () => {
  const service = memoryService();
  const { projectId, chairs } = await freshProject(service, { tableCap: 10, chairs: 1 });
  const kid = await service.addGuest(projectId, { name: '儿童甲', type: 'child' });
  await service.createSeat(projectId, { tableId: 't1', guestId: kid.id, chairId: chairs[0].id });
  const kid2 = await service.addGuest(projectId, { name: '儿童乙', type: 'child' });
  const key = 'idem-fail-1';
  const body = { tableId: 't1', guestId: kid2.id };

  // 首次失败：无可用椅
  await expectError(service.createSeat(projectId, body, { idempotencyKey: key }), 'NO_CHAIR_AVAILABLE');

  // 即便后来补了椅子，同键同体重放仍返回首次失败，不产生预约
  await service.addChair(projectId, { code: 'CH-0002' });
  await expectError(service.createSeat(projectId, body, { idempotencyKey: key }), 'NO_CHAIR_AVAILABLE');

  const state = await service.getProjectState(projectId);
  assert.equal(state.reservations.filter((r) => r.status === 'active').length, 1);
  // 失败审计只记录一次（重放不重复落盘）
  const failed = await service.auditHistory({ projectId, result: 'failed' });
  assert.equal(failed.items.filter((a) => a.idempotencyKey === key).length, 1);
});

test('待核验资源不参与自动排座/手工预留，仅核验后可用', async () => {
  const service = memoryService();
  const { projectId } = await freshProject(service, { tableCap: 10, chairs: 0 });
  await service.importChairs(projectId, [{ code: 'P1', label: '待核验椅', verification: 'pending' }]);
  await service.addGuest(projectId, { name: '儿童待核', type: 'child' });

  const diag = await service.diagnoseAutoSeating(projectId);
  assert.equal(diag.freeChairsForRun, 0);
  assert.equal(diag.unresolved[0].reason, 'NO_AVAILABLE_CHAIR');
  await expectError(service.autoSeat(projectId), 'AUTOSEAT_HAS_UNRESOLVED');

  const chair = (await service.listChairs(projectId))[0];
  await expectError(
    service.createSeat(projectId, { tableId: 't1', guestId: (await service.getProjectState(projectId)).guests[0].id, chairId: chair.id }),
    'CHAIR_UNVERIFIED'
  );

  await service.verifyChair(chair.id);
  const after = await service.autoSeat(projectId);
  assert.equal(after.seated, 1);
  assert.equal(after.decisions[0].chairId, chair.id);
});
