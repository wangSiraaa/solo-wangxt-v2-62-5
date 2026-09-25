'use strict';

const crypto = require('node:crypto');

// 带人类可读前缀的确定性友好 ID（时间 + 随机），批量导入时可由调用方覆盖
function id(prefix) {
  const t = Date.now().toString(36);
  const r = crypto.randomBytes(5).toString('hex');
  return `${prefix}_${t}${r}`;
}

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

// 对请求体做稳定哈希，用于识别“同键不同体”的幂等误用
function stableHash(obj) {
  const json = JSON.stringify(obj, (key, value) => {
    if (key === 'idempotencyKey') return undefined;
    return value;
  });
  return hash(json);
}

module.exports = { id, hash, stableHash };
