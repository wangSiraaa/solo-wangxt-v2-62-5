'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const { SeatService } = require('./service');
const { parseChairsCsv, chairsToCsv } = require('./csv');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function createServer(service = new SeatService()) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      if (url.pathname.startsWith('/api/')) {
        await handleApi(service, req, res, url);
      } else {
        serveStatic(url.pathname, res);
      }
    } catch (err) {
      sendError(res, err);
    }
  });
  return server;
}

async function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 5 * 1024 * 1024) reject(new Error('BODY_TOO_LARGE'));
    });
    req.on('end', () => {
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(Object.assign(new Error(`JSON_INVALID: ${e.message}`), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const payload = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

function sendError(res, err) {
  const status = err.status || (err.code ? 409 : 500);
  sendJson(res, status, {
    error: err.code || 'INTERNAL',
    message: err.message,
    details: err.details || {}
  });
}

const meta = (req, body) => ({
  idempotencyKey: req.headers['idempotency-key'] || body.idempotencyKey || null,
  actor: body.actor || req.headers['x-actor'] || 'anonymous'
});

async function handleApi(service, req, res, url) {
  const p = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const method = req.method;
  const body = method === 'GET' || method === 'HEAD' ? {} : await readJson(req);

  // ---- 项目 ----
  if (method === 'POST' && p[1] === 'projects' && p.length === 2) {
    return sendJson(res, 201, await service.createProject(body, meta(req, body)));
  }
  if (method === 'GET' && p[1] === 'projects' && p[2] === undefined) {
    const state = await service._read();
    return sendJson(res, 200, Object.values(state.projects));
  }
  if (method === 'GET' && p[1] === 'projects' && p[2] && p.length === 3) {
    return sendJson(res, 200, await service.getProjectState(p[2]));
  }

  const projectId = p[1] === 'projects' ? p[2] : null;
  const resource = p[3];

  if (projectId) {
    // ---- 桌 ----
    if (method === 'POST' && resource === 'tables' && p.length === 4) {
      return sendJson(res, 201, await service.addTable(projectId, body, meta(req, body)));
    }
    // ---- 宾客 ----
    if (method === 'POST' && resource === 'guests' && p.length === 4) {
      return sendJson(res, 201, await service.addGuest(projectId, body, meta(req, body)));
    }
    if (method === 'POST' && resource === 'relations' && p.length === 4) {
      return sendJson(res, 200, await service.setRelation(projectId, body.guestAId, body.guestBId, body.type, meta(req, body)));
    }
    // ---- 椅子 ----
    if (method === 'POST' && resource === 'chairs' && p.length === 4) {
      return sendJson(res, 201, await service.addChair(projectId, body, meta(req, body)));
    }
    if (method === 'GET' && resource === 'chairs' && p.length === 4) {
      if (p[4] === undefined && url.searchParams.get('format') === 'csv') {
        const rows = await service.exportChairs(projectId, meta(req, body));
        res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="chairs-${projectId}.csv"` });
        return res.end(chairsToCsv(rows));
      }
      return sendJson(res, 200, await service.listChairs(projectId));
    }
    if (method === 'POST' && resource === 'chairs-import' && p.length === 4) {
      let rows;
      if (typeof body.csv === 'string') rows = parseChairsCsv(body.csv);
      else if (Array.isArray(body.rows)) rows = body.rows;
      else throw Object.assign(new Error('需要 csv 文本或 rows 数组'), { status: 400 });
      return sendJson(res, 201, await service.importChairs(projectId, rows, meta(req, body)));
    }
    // ---- 席位 / 预约 ----
    if (method === 'POST' && resource === 'seats' && p.length === 4) {
      return sendJson(res, 201, await service.createSeat(projectId, body, meta(req, body)));
    }
    // ---- 自动排座 ----
    if (method === 'POST' && resource === 'auto-seat' && p[4] === 'diagnose' && p.length === 5) {
      return sendJson(res, 200, await service.diagnoseAutoSeating(projectId, body));
    }
    if (method === 'POST' && resource === 'auto-seat' && p.length === 4) {
      return sendJson(res, 200, await service.autoSeat(projectId, body, meta(req, body)));
    }
    // ---- 可视化 ----
    if (method === 'GET' && resource === 'table-view' && p.length === 4) {
      return sendJson(res, 200, await service.tableView(projectId));
    }
    // ---- 待处理 ----
    if (method === 'GET' && resource === 'issues' && p.length === 4) {
      return sendJson(res, 200, await service.issues(projectId, { status: url.searchParams.get('status') || undefined }));
    }
    // ---- 迁移 ----
    if (method === 'POST' && resource === 'import-legacy' && p.length === 4) {
      return sendJson(res, 200, await service.importLegacy(body.legacy || body, meta(req, body)));
    }
    // ---- 审计 / 历史 ----
    if (method === 'GET' && resource === 'audit' && p.length === 4) {
      return sendJson(res, 200, await service.auditHistory({
        projectId,
        action: url.searchParams.get('action') || undefined,
        result: url.searchParams.get('result') || undefined,
        limit: url.searchParams.get('limit') || undefined
      }));
    }
  }

  // ---- 席位级操作 /api/seats/:id/... ----
  if (p[1] === 'seats' && p[2] && p.length >= 3) {
    const seatId = p[2];
    if (method === 'POST' && p[3] === 'reserve') return sendJson(res, 200, await service.reserveChair(body.projectId || null, seatId, body, meta(req, body)));
    if (method === 'POST' && p[3] === 'release') return sendJson(res, 200, await service.releaseSeat(seatId, body, meta(req, body)));
    if (method === 'POST' && p[3] === 'deploy') return sendJson(res, 200, await service.deployChair(seatId, body, meta(req, body)));
    if (method === 'POST' && p[3] === 'undeploy') return sendJson(res, 200, await service.undeployChair(seatId, body, meta(req, body)));
    if (method === 'POST' && p[3] === 'transfer') return sendJson(res, 200, await service.transferSeat(seatId, body, meta(req, body)));
    if (method === 'POST' && p[3] === 'swap-chair') return sendJson(res, 200, await service.swapChair(seatId, body, meta(req, body)));
    if (method === 'POST' && p[3] === 'lock') return sendJson(res, 200, await service.setSeatLock(seatId, true, body, meta(req, body)));
    if (method === 'POST' && p[3] === 'unlock') return sendJson(res, 200, await service.setSeatLock(seatId, false, body, meta(req, body)));
  }

  // ---- 椅子级操作 /api/chairs/:id/... ----
  if (p[1] === 'chairs' && p[2] && p.length >= 3) {
    const chairId = p[2];
    if (method === 'POST' && p[3] === 'fault') return sendJson(res, 200, await service.setChairStatus(chairId, 'faulty', body, meta(req, body)));
    if (method === 'POST' && p[3] === 'withdraw') return sendJson(res, 200, await service.setChairStatus(chairId, 'decommissioned', body, meta(req, body)));
    if (method === 'POST' && p[3] === 'repair') return sendJson(res, 200, await service.setChairStatus(chairId, 'available', { ...body, keepReservation: true }, meta(req, body)));
    if (method === 'POST' && p[3] === 'checkin') return sendJson(res, 200, await service.checkinChair(chairId, body, meta(req, body)));
    if (method === 'POST' && p[3] === 'verify') return sendJson(res, 200, await service.verifyChair(chairId, body, meta(req, body)));
  }

  // ---- 待处理方案 ----
  if (p[1] === 'issues' && p[2] && method === 'POST' && p[3] === 'resolve') {
    return sendJson(res, 200, await service.resolveIssue(p[2], body, meta(req, body)));
  }
  if (p[1] === 'issues' && method === 'GET' && p.length === 2) {
    return sendJson(res, 200, await service.issues(null, { status: url.searchParams.get('status') || undefined }));
  }

  // ---- 全局历史 ----
  if (p[1] === 'audit' && method === 'GET' && p.length === 2) {
    return sendJson(res, 200, await service.auditHistory({
      projectId: url.searchParams.get('projectId') || undefined,
      entityType: url.searchParams.get('entityType') || undefined,
      entityId: url.searchParams.get('entityId') || undefined,
      action: url.searchParams.get('action') || undefined,
      result: url.searchParams.get('result') || undefined,
      limit: url.searchParams.get('limit') || undefined
    }));
  }

  sendJson(res, 404, { error: 'NOT_FOUND', message: `未知路由 ${method} ${url.pathname}` });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  fs.readFile(filePath, (err, content) => {
    if (err) {
      // SPA 回退
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, idx) => {
        if (e2) {
          res.writeHead(404);
          res.end('not found');
        } else {
          res.writeHead(200, { 'content-type': MIME['.html'] });
          res.end(idx);
        }
      });
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(content);
  });
}

if (require.main === module) {
  const server = createServer();
  server.listen(PORT, () => {
    console.log(`儿童椅排座服务已启动: http://localhost:${PORT}`);
  });
}

module.exports = { createServer };
