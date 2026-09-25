// 通用持久层契约：内存实现（Node 测试/兜底）与 IndexedDB 实现（浏览器）
// 所有引擎操作都通过 db.withTx 完成，保证“事务内成功才提交，失败整体回滚”。

export const STORE_NAMES = [
  'projects',
  'tables',
  'guests',
  'chairs',
  'reservations',
  'assignments',
  'operations',
  'audits',
  'issues',
  'migrations',
];

export function nowIso() {
  return new Date().toISOString();
}

let idCounter = 0;
export function genId(prefix = 'id') {
  idCounter += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}_${rand}`;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function assertName(name) {
  if (!STORE_NAMES.includes(name)) throw new Error(`未知数据表: ${name}`);
}

class MemoryRepo {
  constructor(db, name) {
    this.db = db;
    this.name = name;
  }
  _map() {
    return this.db._stores[this.name];
  }
  async get(id) {
    return clone(this._map().get(id));
  }
  async put(record) {
    if (!record || record.id == null) throw new Error(`写入 ${this.name} 缺少 id`);
    this._map().set(record.id, clone(record));
    return clone(record);
  }
  async delete(id) {
    this._map().delete(id);
  }
  async all() {
    return [...this._map().values()].map(clone);
  }
  async find(predicate) {
    return (await this.all()).filter(predicate);
  }
  async findOne(predicate) {
    return (await this.all()).find(predicate) ?? null;
  }
  async count(predicate = () => true) {
    return (await this.all()).filter(predicate).length;
  }
}

export class MemoryDb {
  constructor() {
    this._stores = Object.fromEntries(STORE_NAMES.map((name) => [name, new Map()]));
    // 串行化队列：让内存实现具备与 IndexedDB 一致的“读写事务串行”语义，
    // 并发争抢同一资源时后者必定读到前者已提交的状态。
    this._queue = Promise.resolve();
  }

  repo(name) {
    assertName(name);
    return new MemoryRepo(this, name);
  }

  /**
   * 内存事务：进入时快照全部表，回调抛错即整体恢复（回滚）。
   * 通过注入故障（failAt）可模拟提交失败并验证回滚。
   */
  async withTx(_mode, fn) {
    const run = this._queue.then(async () => {
      const snapshot = new Map(
        Object.entries(this._stores).map(([name, map]) => [name, new Map(map)]),
      );
      try {
        return await fn(this);
      } catch (err) {
        for (const [name, map] of snapshot) this._stores[name] = map;
        throw err;
      }
    });
    this._queue = run.catch(() => {});
    return run;
  }

  async dump() {
    const out = {};
    for (const name of STORE_NAMES) out[name] = await this.repo(name).all();
    return out;
  }

  async load(dump) {
    for (const name of STORE_NAMES) {
      this._stores[name] = new Map((dump?.[name] ?? []).map((r) => [r.id, clone(r)]));
    }
  }
}

class IdbRepo {
  constructor(getStore, name) {
    this.getStore = getStore;
    this.name = name;
  }
  _store() {
    return this.getStore(this.name);
  }
  _req(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error(`IndexedDB 请求失败: ${this.name}`));
    });
  }
  async get(id) {
    const result = await this._req(this._store().get(id));
    return result === undefined ? undefined : clone(result);
  }
  async put(record) {
    if (!record || record.id == null) throw new Error(`写入 ${this.name} 缺少 id`);
    await this._req(this._store().put(clone(record)));
    return clone(record);
  }
  async delete(id) {
    await this._req(this._store().delete(id));
  }
  async all() {
    const result = await this._req(this._store().getAll());
    return (result ?? []).map(clone);
  }
  async find(predicate) {
    return (await this.all()).filter(predicate);
  }
  async findOne(predicate) {
    return (await this.all()).find(predicate) ?? null;
  }
  async count(predicate = () => true) {
    return (await this.all()).filter(predicate).length;
  }
}

export class IdbDb {
  constructor(idb, name = 'tracked-child-chair-seating') {
    if (!idb) throw new Error('当前环境不支持 IndexedDB');
    this.idb = idb;
    this.name = name;
    this._dbPromise = null;
  }

  _open() {
    if (this._dbPromise) return this._dbPromise;
    this._dbPromise = new Promise((resolve, reject) => {
      const request = this.idb.open(this.name, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const name of STORE_NAMES) {
          if (!db.objectStoreNames.contains(name)) {
            db.createObjectStore(name, { keyPath: 'id' });
          }
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB 打开失败'));
    });
    return this._dbPromise;
  }

  async _tx(mode, fn) {
    const db = await this._open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAMES, mode);
      let result;
      let settled = false;
      const getStore = (name) => {
        assertName(name);
        return tx.objectStore(name);
      };
      const txDb = {
        repo: (name) => new IdbRepo(getStore, name),
        // 导出等只读场景允许直接访问底层连接
        _raw: db,
      };
      tx.oncomplete = () => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };
      tx.onabort = () => {
        if (!settled) {
          settled = true;
          reject(tx.error ?? new Error('IndexedDB 事务已中止（回滚）'));
        }
      };
      tx.onerror = () => {
        if (!settled) {
          settled = true;
          reject(tx.error ?? new Error('IndexedDB 事务失败（回滚）'));
        }
      };
      Promise.resolve()
        .then(() => fn(txDb))
        .then((value) => {
          result = value;
        })
        .catch((err) => {
          if (!settled) {
            settled = true;
            try {
              tx.abort();
            } catch {
              // 忽略中止异常
            }
            reject(err);
          }
        });
    });
  }

  async withTx(mode, fn) {
    return this._tx(mode, fn);
  }

  async dump() {
    return this.withTx('readonly', async (txDb) => {
      const out = {};
      for (const name of STORE_NAMES) out[name] = await txDb.repo(name).all();
      return out;
    });
  }

  async load(dump) {
    return this.withTx('readwrite', async (txDb) => {
      for (const name of STORE_NAMES) {
        const repo = txDb.repo(name);
        for (const record of dump?.[name] ?? []) await repo.put(record);
      }
    });
  }
}

export function createDb() {
  if (typeof indexedDB !== 'undefined') return new IdbDb(indexedDB);
  return new MemoryDb();
}
