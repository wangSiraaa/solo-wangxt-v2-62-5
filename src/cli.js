#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { SeatService } = require('./service');
const { parseChairsCsv, chairsToCsv } = require('./csv');

function parseFlags(args) {
  const flags = { _: [] };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else {
        flags[key] = next;
        i += 1;
      }
    } else {
      flags._.push(a);
    }
  }
  return flags;
}

async function seed(service) {
  const project = await service.createProject({ id: 'demo-wedding', name: '示例婚礼 2026-10-01', eventDate: '2026-10-01' }, { actor: 'seed' });
  const t1 = await service.addTable(project.id, { id: 'tbl-a', name: 'A 桌', capacity: 4 }, { actor: 'seed' });
  const t2 = await service.addTable(project.id, { id: 'tbl-b', name: 'B 桌', capacity: 4 }, { actor: 'seed' });
  await service.importChairs(project.id, [
    { code: 'CH-0001', label: '实体椅一号' },
    { code: 'CH-0002', label: '实体椅二号' },
    { code: 'CH-0003', label: '实体椅三号' }
  ], { actor: 'seed' });
  const dad = await service.addGuest(project.id, { id: 'gst-dad', name: '王爸爸', type: 'adult' }, { actor: 'seed' });
  const kid = await service.addGuest(project.id, { id: 'gst-kid', name: '王小娃', type: 'child' }, { actor: 'seed' });
  await service.setRelation(project.id, dad.id, kid.id, 'together', { actor: 'seed' });
  await service.createSeat(project.id, { tableId: t1.id, guestId: dad.id }, { actor: 'seed' });
  await service.createSeat(project.id, { tableId: t1.id, guestId: kid.id }, { actor: 'seed' });

  // 一份旧项目示例文件（用于演示迁移）
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync('data/legacy-example.json', JSON.stringify({
    version: 1,
    project: { id: 'legacy-oldie', name: '旧项目（抽象占位时代）', date: '2025-12-24' },
    tables: [
      { id: 'lt1', name: '旧 1 桌', capacity: 6 },
      { id: 'lt2', name: '旧 2 桌', capacity: 6 }
    ],
    guests: [
      { id: 'lg1', name: '张家爸爸', type: 'adult', tableId: 'lt1', seatLabel: 'A1', locked: false },
      { id: 'lg2', name: '张家小孩', type: 'child', tableId: 'lt1', seatLabel: 'A2', locked: true, requiresChair: true }
    ],
    childPlaceholders: [
      { id: 'ph1', tableId: 'lt2', seatLabel: '儿童加位 X1', locked: false }
    ]
  }, null, 2));

  console.log('种子数据完成：');
  console.log(' - 项目 demo-wedding（2 桌 / 3 把实体椅 / 已坐 1 成人 + 1 儿童）');
  console.log(' - 旧项目样例 data/legacy-example.json，可用 migrate-legacy 迁移');
}

function print(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const flags = parseFlags(rest);
  const service = new SeatService();

  switch (cmd) {
    case 'seed':
      return seed(service);

    case 'create-project':
      return print(await service.createProject({ id: flags.id, name: flags.name, eventDate: flags.date }, { actor: flags.actor }));

    case 'add-table':
      return print(await service.addTable(flags.project, { id: flags.id, name: flags.name, capacity: Number(flags.capacity) }, { actor: flags.actor }));

    case 'add-guest':
      return print(await service.addGuest(flags.project, { id: flags.id, name: flags.name, type: flags.type || 'adult' }, { idempotencyKey: flags['idem-key'], actor: flags.actor }));

    case 'import-chairs': {
      const text = fs.readFileSync(flags.file, 'utf8');
      const rows = parseChairsCsv(text);
      return print(await service.importChairs(flags.project, rows, { idempotencyKey: flags['idem-key'], actor: flags.actor }));
    }

    case 'export-chairs': {
      const rows = await service.exportChairs(flags.project);
      const csv = chairsToCsv(rows);
      if (flags.out) fs.writeFileSync(flags.out, csv);
      else process.stdout.write(csv);
      return undefined;
    }

    case 'seat': {
      const payload = { tableId: flags.table, guestId: flags.guest, anonymous: !!flags.anonymous, chairId: flags.chair, tableCardLabel: flags.label, locked: !!flags.locked };
      return print(await service.createSeat(flags.project, payload, { idempotencyKey: flags['idem-key'], actor: flags.actor }));
    }

    case 'reserve':
      return print(await service.reserveChair(flags.project || null, flags.seat, { chairId: flags.chair }, { idempotencyKey: flags['idem-key'], actor: flags.actor }));

    case 'deploy':
      return print(await service.deployChair(flags.seat, { comment: flags.comment }, { idempotencyKey: flags['idem-key'], actor: flags.actor }));

    case 'undeploy':
      return print(await service.undeployChair(flags.seat, {}, { idempotencyKey: flags['idem-key'], actor: flags.actor }));

    case 'release':
      return print(await service.releaseSeat(flags.seat, { force: !!flags.force, allowUndeploy: !!flags['allow-undeploy'], reason: flags.reason }, { idempotencyKey: flags['idem-key'], actor: flags.actor }));

    case 'transfer':
      return print(await service.transferSeat(flags.seat, { targetTableId: flags['to-table'], targetChairId: flags['to-chair'], keepChair: !!flags['keep-chair'], force: !!flags.force }, { idempotencyKey: flags['idem-key'], actor: flags.actor }));

    case 'lock':
      return print(await service.setSeatLock(flags.seat, true, {}, { actor: flags.actor }));

    case 'fault':
      return print(await service.setChairStatus(flags.chair, 'faulty', { comment: flags.comment }, { idempotencyKey: flags['idem-key'], actor: flags.actor }));

    case 'withdraw':
      return print(await service.setChairStatus(flags.chair, 'decommissioned', { comment: flags.comment }, { idempotencyKey: flags['idem-key'], actor: flags.actor }));

    case 'resolve-issue':
      return print(await service.resolveIssue(flags.issue, { resolution: flags.resolution, replacementChairId: flags['replace-with'], force: !!flags.force }, { idempotencyKey: flags['idem-key'], actor: flags.actor }));

    case 'diagnose':
      return print(await service.diagnoseAutoSeating(flags.project, { guestIds: flags.guests ? String(flags.guests).split(',') : undefined }));

    case 'auto-seat':
      return print(await service.autoSeat(flags.project, { guestIds: flags.guests ? String(flags.guests).split(',') : undefined, allowPartial: !!flags.partial }, { idempotencyKey: flags['idem-key'], actor: flags.actor }));

    case 'table-view':
      return print(await service.tableView(flags.project));

    case 'chairs':
      return print(await service.listChairs(flags.project || null));

    case 'issues':
      return print(await service.issues(flags.project || null, { status: flags.status }));

    case 'audit':
      return print(await service.auditHistory({ projectId: flags.project, action: flags.action, result: flags.result, entityType: flags['entity-type'], entityId: flags.entity, limit: flags.limit ? Number(flags.limit) : undefined }));

    case 'migrate-legacy': {
      const raw = JSON.parse(fs.readFileSync(flags.file, 'utf8'));
      return print(await service.importLegacy(raw, { idempotencyKey: flags['idem-key'], actor: flags.actor }));
    }

    default:
      console.log(`用法: node src/cli.js <command> [flags]
  seed                            生成演示数据
  create-project --id --name [--date]
  add-table --project --id --name --capacity
  add-guest --project [--id] --name [--type child|adult]
  import-chairs --project --file chairs.csv
  export-chairs --project [--out chairs.csv]
  seat --project --table [--guest] [--anonymous] [--chair] [--label] [--locked]
  reserve [--project] --seat [--chair]
  deploy --seat | undeploy --seat | release --seat [--force] [--allow-undeploy]
  transfer --seat --to-table [--to-chair] [--keep-chair] [--force]
  lock --seat
  fault --chair [--comment] | withdraw --chair [--comment]
  resolve-issue --issue --resolution replace|revoke|keep [--replace-with CH..] [--force]
  diagnose --project [--guests a,b]
  auto-seat --project [--guests a,b] [--partial]
  table-view --project | chairs [--project] | issues [--project] [--status open]
  audit [--project] [--action ..] [--result failed] [--entity-type ..] [--entity ..] [--limit N]
  migrate-legacy --file old.json
所有写命令支持 --idem-key <key> --actor <who>`);
  }
}

main().catch((err) => {
  console.error(`错误 [${err.code || 'ERROR'}]: ${err.message}`);
  if (err.details) console.error(JSON.stringify(err.details, null, 2));
  process.exit(1);
});
