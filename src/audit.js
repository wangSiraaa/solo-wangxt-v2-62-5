'use strict';

const { id } = require('./ids');

/**
 * 追加审计条目。成功与失败的操作都必须留痕。
 * 失败条目 result=failed 会在事务回滚时由存储层单独补录，
 * 因此失败路径下也应先 append 再 throw。
 */
function audit(draft, { action, projectId = null, entityType = null, entityId = null, detail = {}, result = 'ok', reason = null, actor = 'system', idempotencyKey = null }) {
  const entry = {
    id: id('aud'),
    at: new Date().toISOString(),
    actor,
    action, // 例如 chair.reserve / seat.transfer / chair.fault / issue.resolve / autoseat / migration
    projectId,
    entityType,
    entityId,
    detail,
    result, // ok | failed
    reason,
    idempotencyKey
  };
  draft.audit.push(entry);
  return entry;
}

module.exports = { audit };
