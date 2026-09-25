'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SeatService } = require('../src/service');
const { FileStore } = require('../src/store');

function memoryService() {
  return new SeatService({ save: false });
}

function tempDbService() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seating-'));
  const dbPath = path.join(dir, 'db.json');
  return { service: new SeatService({ dbPath }), dbPath, dir };
}

async function freshProject(service, { tableCap = 10, chairs = 0 } = {}) {
  const project = await service.createProject({ id: undefined, name: '测试项目' });
  const table = await service.addTable(project.id, { id: 't1', name: '主桌', capacity: tableCap });
  const chairObjs = [];
  for (let i = 0; i < chairs; i += 1) {
    chairObjs.push(await service.addChair(project.id, { code: `CH-${String(i + 1).padStart(4, '0')}`, label: `椅 ${i + 1}` }));
  }
  return { projectId: project.id, tableId: table.id, chairs: chairObjs };
}

async function addChild(service, projectId, name, chairId) {
  const kid = await service.addGuest(projectId, { name, type: 'child' });
  const seat = await service.createSeat(projectId, { tableId: 't1', guestId: kid.id, chairId });
  return { kid, seatId: seat.seat.id, reservationId: seat.reservation.id };
}

module.exports = { memoryService, tempDbService, freshProject, addChild };
