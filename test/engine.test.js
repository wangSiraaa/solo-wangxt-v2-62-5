import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDb } from '../core/store.js';
import * as engine from '../core/engine.js';
import { OpError } from '../core/engine.js';

let seq = 0;
const key = (prefix) => {
  seq += 1;
  return `${prefix}-${seq}`;
};

async function seedProject(db, { tables = [], guests = [], chairs = [] } = {}) {
  const project = await engine.saveProject(db, { name: `验收项目 ${seq}` });
  for (const t of tables) {
    await engine.createTable(db, { projectId: project.id, idempotencyKey: key('tbl'), ...t });
  }
  const state = await engine.getBoardState(db, project.id);
  for (const g of guests) {
    await engine.createGuest(db, { projectId: project.id, idempotencyKey: key('gst'), ...g });
  }
  const chairs2 = [];
  for (const c of chairs) {
    const res = await engine.importChairs(db, {
      projectId: project.id,
      chairs: [{ label: c.label, tableId: c.tableId ?? null }],
      idempotencyKey: key('import'),
    });
    const board = await engine.getBoardState(db, project.id);
    chairs2.push(board.chairs.find((x) => x.label === c.label));
  }
  const board = await engine.getBoardState(db, project.id);
  return { project, tables: board.tables, guests: board.guests, chairs: chairs2 };
}

test('两把实体椅分别预留后，刷新（重新读取）状态仍保持', async () => {
  const db = new MemoryDb();
  const { project, tables, guests } = await seedProject(db, {
    tables: [{ name: 'A 桌', capacity: 6 }],
    guests: [{ name: '小宝', type: 'child' }, { name: '小贝', type: 'child' }],
    chairs: [{ label: '椅一' }, { label: '椅二' }],
  });
  const board0 = await engine.getBoardState(db, project.id);
  const table = board0.tables[0];
  const chair1 = board0.chairs[0];
  const chair2 = board0.chairs[1];
  const [c1, c2] = board0.guests;

  const r1 = await engine.reserveChildChair(db, {
    projectId: project.id, guestId: c1.id, chairId: chair1.id, tableId: table.id, idempotencyKey: key('rsv'),
  });
  const r2 = await engine.reserveChildChair(db, {
    projectId: project.id, guestId: c2.id, chairId: chair2.id, tableId: table.id, idempotencyKey: key('rsv'),
  });
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);

  // “刷新页面”：丢掉内存引用，重新从库里读
  const board = await engine.getBoardState(db, project.id);
  const rsv = board.reservations;
  assert.equal(rsv.length, 2);
  assert.deepEqual(rsv.filter((r) => r.status === 'reserved').map((r) => r.chairId).sort(), [chair1.id, chair2.id].sort());
  assert.deepEqual([...board.chairs].map((c) => c.status).sort(), ['reserved', 'reserved']);
  assert.equal(board.reservations.every((r) => r.tableId === table.id), true);
});

test('最后一把椅子被并发争抢时仅一个预留成功；重复幂等键重放不产生第二单', async () => {
  const db = new MemoryDb();
  const { project, guests, chairs } = await seedProject(db, {
    tables: [{ name: '主桌', capacity: 4 }],
    guests: [{ name: '儿童甲', type: 'child' }, { name: '儿童乙', type: 'child' }],
    chairs: [{ label: '唯一儿童椅' }],
  });
  const table = (await engine.getBoardState(db, project.id)).tables[0];
  const only = chairs[0];
  const [g1, g2] = guests;

  const results = await Promise.allSettled([
    engine.reserveChildChair(db, { projectId: project.id, guestId: g1.id, chairId: only.id, tableId: table.id, idempotencyKey: 'race-key-1' }),
    engine.reserveChildChair(db, { projectId: project.id, guestId: g2.id, chairId: only.id, tableId: table.id, idempotencyKey: 'race-key-2' }),
  ]);
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, 'CHAIR_NOT_AVAILABLE');

  // 同一幂等键重放：返回原结果，不新增预约
  const replay = await engine.reserveChildChair(db, {
    projectId: project.id, guestId: g1.id, chairId: only.id, tableId: table.id, idempotencyKey: 'race-key-1',
  });
  assert.equal(replay.idempotentReplay, true);
  const board = await engine.getBoardState(db, project.id);
  assert.equal(board.reservations.length, 1);
  assert.equal(board.chairs[0].status, 'reserved');

  // 幂等键被不同请求占用必须拒绝
  await assert.rejects(
    engine.reserveChildChair(db, { projectId: project.id, guestId: g2.id, chairId: only.id, tableId: table.id, idempotencyKey: 'race-key-1' }),
    (e) => e instanceof OpError && e.code === 'IDEMPOTENCY_CONFLICT',
  );
});

test('换桌目标桌无可用儿童椅时，原预约完整保留', async () => {
  const db = new MemoryDb();
  const { project, tables, guests, chairs } = await seedProject(db, {
    tables: [{ name: 'A 桌', capacity: 4 }, { name: 'B 桌', capacity: 4 }],
    guests: [{ name: '朵朵', type: 'child' }],
    chairs: [{ label: 'A 桌椅', tableId: null }],
  });
  const [tableA, tableB] = tables;
  const guest = guests[0];
  const chair = chairs[0];
  await engine.reserveChildChair(db, {
    projectId: project.id, guestId: guest.id, chairId: chair.id, tableId: tableA.id, idempotencyKey: key('rsv'),
  });

  await assert.rejects(
    engine.moveGuestToTable(db, { projectId: project.id, guestId: guest.id, toTableId: tableB.id, idempotencyKey: key('move') }),
    (e) => e instanceof OpError && e.code === 'CHAIR_EXHAUSTED',
  );

  const board = await engine.getBoardState(db, project.id);
  assert.equal(board.reservations.length, 1);
  const r = board.reservations[0];
  assert.equal(r.tableId, tableA.id);
  assert.equal(r.chairId, chair.id);
  assert.equal(r.status, 'reserved');
  assert.equal(board.chairs[0].status, 'reserved');
});

test('失败操作在业务事务回滚后仍留下失败审计', async () => {
  const db = new MemoryDb();
  const { project, tables, guests, chairs } = await seedProject(db, {
    tables: [{ name: 'X 桌', capacity: 4, locked: true }],
    guests: [{ name: '童童', type: 'child' }],
    chairs: [{ label: '椅' }],
  });
  await assert.rejects(engine.audited(
    db, project.id, 'reservation.reserve', 'tester',
    () => engine.reserveChildChair(db, { projectId: project.id, guestId: guests[0].id, chairId: chairs[0].id, tableId: tables[0].id, idempotencyKey: key('r') }),
  ), (e) => e.code === 'TABLE_LOCKED');
  const board = await engine.getBoardState(db, project.id);
  assert.equal(board.reservations.length, 0);
  assert.equal(board.chairs[0].status, 'available');
  const audits = await engine.listAudits(db, { projectId: project.id });
  const failed = audits.filter((a) => a.ok === false);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].errorCode, 'TABLE_LOCKED');
});

test('已布置资源故障：不移动席，进入方案待处理，人工替换后恢复', async () => {
  const db = new MemoryDb();
  const { project, tables, guests, chairs } = await seedProject(db, {
    tables: [{ name: '大厅 A', capacity: 6 }],
    guests: [{ name: '安安', type: 'child' }],
    chairs: [{ label: '在用椅' }, { label: '备用椅', tableId: null }],
  });
  const table = tables[0];
  const guest = guests[0];
  const [inUse, spare] = chairs;
  const rsv = await engine.reserveChildChair(db, {
    projectId: project.id, guestId: guest.id, chairId: inUse.id, tableId: table.id, idempotencyKey: key('rsv'),
  });
  await engine.deployReservation(db, { projectId: project.id, reservationId: rsv.reservation.id, idempotencyKey: key('deploy') });

  const fault = await engine.markChairFault(db, { projectId: project.id, chairId: inUse.id, reason: '椅腿断裂', idempotencyKey: key('fault') });
  assert.equal(fault.impactedReservation.status, 'deployed');
  assert.equal(fault.impactedReservation.tableId, table.id);
  assert.equal(fault.chair.status, 'fault');

  let board = await engine.getBoardState(db, project.id);
  assert.equal(board.project.status, 'pending');
  assert.equal(board.issues.length, 1);
  assert.equal(board.issues[0].blocking, true);
  assert.equal(board.reservations[0].status, 'deployed'); // 席次纹丝不动

  // 有待处理问题时，自动排座拒绝运行（不得悄悄挪动）
  const diag = await engine.diagnoseSeating(db, project.id);
  assert.equal(diag.ok, false);
  assert.ok(diag.errors.some((e) => e.type === 'PLAN_PENDING'));
  await assert.rejects(
    engine.autoArrange(db, { projectId: project.id, idempotencyKey: key('auto') }),
    (e) => e.code === 'PLAN_INVALID',
  );

  // 人工用同桌备用椅替换：新椅直接进入已布置，问题关闭
  const replaced = await engine.replaceChair(db, {
    projectId: project.id, reservationId: rsv.reservation.id, newChairId: spare.id, reason: '故障替换', idempotencyKey: key('replace'),
  });
  assert.equal(replaced.chair.id, spare.id);
  assert.equal(replaced.chair.status, 'deployed');
  assert.equal(replaced.reservation.tableId, table.id);
  board = await engine.getBoardState(db, project.id);
  assert.equal(board.project.status, 'open');
  assert.equal(board.issues[0].status, 'resolved');
  assert.equal(board.chairs.find((c) => c.id === inUse.id).status, 'fault');
});

test('已锁定预约的椅子故障后仍保持锁定，只能人工替换，撤销需先解锁', async () => {
  const db = new MemoryDb();
  const { project, tables, guests, chairs } = await seedProject(db, {
    tables: [{ name: '锁定家庭桌', capacity: 6 }],
    guests: [{ name: '宁宁', type: 'child' }],
    chairs: [{ label: '锁定椅' }, { label: '替换椅' }],
  });
  const table = tables[0];
  const guest = guests[0];
  const [locked, spare] = chairs;
  const rsv = await engine.reserveChildChair(db, {
    projectId: project.id, guestId: guest.id, chairId: locked.id, tableId: table.id, locked: true, idempotencyKey: key('rsv'),
  });

  await engine.markChairFault(db, { projectId: project.id, chairId: locked.id, reason: '损坏', idempotencyKey: key('fault') });
  const board = await engine.getBoardState(db, project.id);
  assert.equal(board.reservations[0].locked, true);
  assert.equal(board.reservations[0].chairId, locked.id);

  await assert.rejects(
    engine.releaseReservation(db, { projectId: project.id, reservationId: rsv.reservation.id, idempotencyKey: key('rel') }),
    (e) => e.code === 'RESERVATION_LOCKED',
  );
  // 人工替换即使锁定也允许（同桌换资源，不移动席次）
  const ok = await engine.replaceChair(db, { projectId: project.id, reservationId: rsv.reservation.id, newChairId: spare.id, idempotencyKey: key('rep') });
  assert.equal(ok.reservation.chairId, spare.id);
  assert.equal(ok.reservation.locked, true);
});

test('旧项目儿童椅占位迁移为待核验资源，保留容量、锁定与原桌卡', async () => {
  const db = new MemoryDb();
  const legacy = {
    project: { id: 2025, name: '旧客户婚礼', eventDate: '2025-10-01' },
    tables: [
      { id: 1, name: '家庭主桌', capacity: 4, locked: true },
      { id: 2, name: '朋友桌', capacity: 8, locked: false },
    ],
    childChairs: [{ id: 9, label: '旧项目实体椅', tableId: 2 }],
    guests: [
      { id: 1, name: '爸爸', type: 'adult', tableId: 1 },
      { id: 2, name: '小宝', type: 'child', tableId: 1, childChairPlaceholder: 1 },
      { id: 3, type: 'child', tableId: 2, childChairPlaceholder: 1 }, // 匿名儿童
    ],
  };
  const migrated = await engine.migrateLegacyProject(db, legacy, { idempotencyKey: 'legacy-2025' });
  assert.equal(migrated.ok, true);

  let board = await engine.getBoardState(db, migrated.projectId);
  const mainTable = board.tables.find((t) => t.legacyRef?.tableId === 1);
  assert.equal(mainTable.capacity, 4);
  assert.equal(mainTable.locked, true);

  const namedChild = board.guests.find((g) => g.legacyRef?.guestId === 2);
  const anonChild = board.guests.find((g) => g.legacyRef?.guestId === 3);
  assert.equal(namedChild.name, '小宝');
  assert.equal(anonChild.anonymous, true);

  const rsv = board.reservations.find((r) => r.guestId === namedChild.id);
  assert.equal(rsv.status, 'reserved');
  assert.equal(rsv.tableId, mainTable.id);
  assert.equal(rsv.locked, true); // 继承原锁定桌行为
  const placeholderChair = board.chairs.find((c) => c.id === rsv.chairId);
  assert.equal(placeholderChair.status, 'pending_verification');
  assert.equal(placeholderChair.legacyPlaceholder, true);
  assert.equal(placeholderChair.tableId, mainTable.id); // 原桌卡

  // 容量仍被该儿童席计入（2 人 + 1 儿童椅席 ≤ 4）
  const occupancy = board.reservations.filter((r) => r.tableId === mainTable.id).length
    + board.assignments.filter((a) => a.tableId === mainTable.id).length;
  assert.equal(occupancy, 2);
  assert.ok(occupancy <= mainTable.capacity);

  // 已存在的旧实体椅迁移为可用
  assert.ok(board.chairs.some((c) => c.status === 'available' && c.legacyRef?.physical));
  // 核验问题为非阻断提示
  assert.ok(board.issues.some((i) => i.type === 'verification_needed' && i.blocking === false));
  assert.equal(board.project.status, 'open');

  // 幂等重跑：不产生重复资源/预约
  const replay = await engine.migrateLegacyProject(db, legacy, { idempotencyKey: 'legacy-2025' });
  assert.equal(replay.idempotentReplay, true);
  board = await engine.getBoardState(db, migrated.projectId);
  assert.equal(board.reservations.length, 2);
  assert.equal(board.chairs.length, 3);

  // 现场核验后进入可用池
  await engine.verifyChair(db, { projectId: migrated.projectId, chairId: placeholderChair.id, idempotencyKey: key('verify') });
  board = await engine.getBoardState(db, migrated.projectId);
  assert.equal(board.chairs.find((c) => c.id === placeholderChair.id).status, 'reserved');

  const audits = await engine.listAudits(db, { projectId: migrated.projectId });
  assert.ok(audits.some((a) => a.action === 'legacy.migrate'));

  const exported = await engine.exportProject(db, migrated.projectId);
  assert.equal(exported.format, 'tracked-child-chair-seating/v1');
  assert.equal(exported.tables.length, 2);
});

test('批量换座中途失败时整组事务回滚，原方案完整', async () => {
  const db = new MemoryDb();
  const { project, tables, guests, chairs } = await seedProject(db, {
    tables: [{ name: '源桌', capacity: 8 }, { name: '目标桌', capacity: 8 }],
    guests: [
      { name: '大宝', type: 'child', groupId: 'grp-1' },
      { name: '二宝', type: 'child', groupId: 'grp-1' },
    ],
    chairs: [{ label: '旧椅一' }, { label: '旧椅二' }, { label: '目标唯一椅' }],
  });
  const [src, dst] = tables;
  const [c1, c2, spare] = chairs;
  spare.tableId = dst.id; // 目标桌只有一把可用椅
  await engine.importChairs(db, { projectId: project.id, chairs: [{ id: spare.id, label: spare.label, tableId: dst.id, status: 'available' }], idempotencyKey: key('fixchair') });

  await engine.reserveChildChair(db, { projectId: project.id, guestId: guests[0].id, chairId: c1.id, tableId: src.id, idempotencyKey: key('r') });
  await engine.reserveChildChair(db, { projectId: project.id, guestId: guests[1].id, chairId: c2.id, tableId: src.id, idempotencyKey: key('r') });

  await assert.rejects(
    engine.moveGuestsToTable(db, { projectId: project.id, guestIds: [guests[0].id, guests[1].id], toTableId: dst.id, idempotencyKey: key('mv') }),
    (e) => e.code === 'CHAIR_EXHAUSTED',
  );

  const board = await engine.getBoardState(db, project.id);
  assert.equal(board.reservations.length, 2);
  for (const r of board.reservations) {
    assert.equal(r.tableId, src.id);
    assert.equal(r.version, 1);
  }
  assert.deepEqual(board.chairs.filter((c) => c.status === 'reserved').map((c) => c.id).sort(), [c1.id, c2.id].sort());
  assert.equal(board.chairs.find((c) => c.id === spare.id).status, 'available');
});

test('锁定桌不能新增预留，且容量不能超卖', async () => {
  const db = new MemoryDb();
  const { project, tables, guests, chairs } = await seedProject(db, {
    tables: [{ name: '锁定桌', capacity: 1, locked: true }],
    guests: [{ name: '童童', type: 'child' }],
    chairs: [{ label: '空椅' }],
  });
  await assert.rejects(
    engine.reserveChildChair(db, { projectId: project.id, guestId: guests[0].id, chairId: chairs[0].id, tableId: tables[0].id, idempotencyKey: key('r') }),
    (e) => e.code === 'TABLE_LOCKED',
  );
  await engine.setTableLocked(db, { projectId: project.id, tableId: tables[0].id, locked: false, idempotencyKey: key('unlock') });
  await engine.reserveChildChair(db, { projectId: project.id, guestId: guests[0].id, chairId: chairs[0].id, tableId: tables[0].id, idempotencyKey: key('r2') });
  const board = await engine.getBoardState(db, project.id);
  assert.equal(board.reservations.length, 1);
});

test('自动排座遵守容量、儿童椅资源与关系组约束；dryRun 不落库', async () => {
  const db = new MemoryDb();
  const { project } = await seedProject(db, {
    tables: [{ name: '一桌', capacity: 4 }, { name: '二桌', capacity: 4 }],
    guests: [
      { name: '妈妈', type: 'adult', groupId: 'fam' },
      { name: '娃', type: 'child', groupId: 'fam' },
    ],
    chairs: [{ label: '椅 A' }, { label: '椅 B' }],
  });
  const before = await engine.diagnoseSeating(db, project.id);
  assert.equal(before.ok, true);
  assert.equal(before.placements.length, 1);
  const dry = await engine.autoArrange(db, { projectId: project.id, dryRun: true });
  assert.equal(dry.ok, true);
  let board = await engine.getBoardState(db, project.id);
  assert.equal(board.reservations.length, 0); // 诊断不写库

  const arrangeKey = key('arrange');
  await engine.autoArrange(db, { projectId: project.id, idempotencyKey: arrangeKey });
  board = await engine.getBoardState(db, project.id);
  assert.equal(board.assignments.length, 1);
  assert.equal(board.reservations.length, 1);
  // 整组必须同桌
  assert.equal(board.reservations[0].tableId, board.assignments[0].tableId);
  // 幂等重放
  const replay = await engine.autoArrange(db, { projectId: project.id, idempotencyKey: arrangeKey });
  assert.equal(replay.idempotentReplay, true);
});
