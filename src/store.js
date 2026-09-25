'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { stableHash } = require('./ids');
const { IdempotencyConflictError } = require('./errors');
const { SCHEMA_VERSION } = require('./constants');

/**
 * 单文件 JSON 存储。
 *
 * 一致性保证：
 *  - 进程内用 FIFO 异步互斥锁串行化所有事务；
 *  - 每个写事务基于最新快照的深拷贝执行，成功后原子 rename 落盘（写临时文件 -> rename）；
 *  - 事务内抛错则领域变更整体丢弃（回滚），但事务中追加的“失败审计”会单独补录；
 *  - 幂等键重放：同 key + 同请求体直接返回首次结果（失败也重放）；
 *    同 key + 不同请求体报 IDEMPOTENCY_KEY_REUSED；失败响应同样占用幂等键，
 *    使重复提交永远不会第二次生效。
 */
class FileStore {
  constructor(filePath, { save = true } = {}) {
    this.filePath = filePath;
    this.saveToDisk = save;
    this._queue = Promise.resolve();
    this._data = null;
  }

  emptyState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      projects: {},
      tables: {},
      guests: {},
      seats: {},
      chairs: {},
      reservations: {},
      issues: {},
      audit: [],
      idempotency: {}
    };
  }

  async load() {
    if (this._data) return this._data;
    if (!this.saveToDisk) {
      this._data = this.emptyState();
      return this._data;
    }
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(this.filePath)) {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      this._data = raw.trim() ? JSON.parse(raw) : this.emptyState();
    } else {
      this._data = this.emptyState();
      await this._persist(this._data);
    }
    return this._data;
  }

  async read() {
    return this.load();
  }

  async _persist(data) {
    if (!this.saveToDisk) return;
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, this.filePath);
  }

  /**
   * 只读快照视图（深拷贝，防止外部改动）
   */
  async snapshot() {
    const data = await this.load();
    return structuredClone(data);
  }

  /**
   * 带幂等键的写事务（服务层统一入口）。
   * @param {string|null} idempotencyKey
   * @param {object} requestBody 参与幂等体哈希的请求体
   * @param {function(draft):Promise<*>|*} fn 领域变更函数；向 draft.audit 追加审计
   */
  async runWithKey(idempotencyKey, requestBody, fn) {
    const release = await this._acquire();
    const bodyHash = stableHash(requestBody || {});
    try {
      const data = await this.load();

      if (idempotencyKey) {
        const stored = data.idempotency[idempotencyKey];
        if (stored) {
          if (stored.requestHash !== bodyHash) throw new IdempotencyConflictError(stored.requestHash);
          if (!stored.ok) throw deserializeError(stored.result);
          return structuredClone(stored.result);
        }
      }

      const draft = structuredClone(data);
      let result;
      try {
        result = await fn(draft);
      } catch (err) {
        await this._rollback(draft, idempotencyKey, bodyHash, err);
        throw err;
      }

      if (idempotencyKey) {
        draft.idempotency[idempotencyKey] = {
          requestHash: bodyHash,
          result: structuredClone(result),
          ok: true,
          createdAt: new Date().toISOString()
        };
      }
      this._data = draft;
      await this._persist(draft);
      return result === undefined ? undefined : structuredClone(result);
    } finally {
      release();
    }
  }

  /**
   * 失败回滚：领域变更全部丢弃；
   * 但把事务中追加的失败审计条目补录进最新状态（仅审计，不含任何领域对象）。
   */
  async _rollback(failedDraft, idempotencyKey, bodyHash, err) {
    const live = await this.load();
    const existingAudit = new Set(live.audit.map((a) => a.id));
    for (const entry of failedDraft.audit) {
      if (!existingAudit.has(entry.id)) live.audit.push(entry);
    }
    if (idempotencyKey) {
      live.idempotency[idempotencyKey] = {
        requestHash: bodyHash,
        result: serializeError(err),
        ok: false,
        createdAt: new Date().toISOString()
      };
    }
    this._data = live;
    await this._persist(live);
  }

  // FIFO 互斥：调用方排队等待前一个事务完成
  _acquire() {
    const prev = this._queue;
    let release;
    this._queue = new Promise((resolve) => {
      release = resolve;
    });
    return prev.then(() => release);
  }
}

function serializeError(err) {
  return {
    __error: true,
    name: err.name,
    code: err.code,
    message: err.message,
    details: err.details || {},
    status: err.status
  };
}

function deserializeError(ser) {
  if (ser && ser.__error) {
    const e = new Error(ser.message);
    e.name = ser.name || 'Error';
    e.code = ser.code;
    e.details = ser.details;
    e.status = ser.status;
    return e;
  }
  return ser;
}

module.exports = { FileStore };
