'use strict';

// 椅子实体生命周期状态
const CHAIR_STATUS = {
  AVAILABLE: 'available',     // 可用
  RESERVED: 'reserved',       // 已预留
  DEPLOYED: 'deployed',       // 已布置（到场就桌）
  RETURNED: 'returned',       // 已归还（待清点回库）
  FAULTY: 'faulty',           // 故障
  DECOMMISSIONED: 'decommissioned' // 停用/撤回
};

const CHAIR_STATUSES = Object.values(CHAIR_STATUS);

// 可被新预约使用的状态
const CHAIR_FREE_STATUSES = new Set([CHAIR_STATUS.AVAILABLE]);

// 预约状态
const RESERVATION_STATUS = {
  ACTIVE: 'active',           // 生效中（预留/布置）
  RELEASED: 'released',       // 已释放
  TRANSFERRED: 'transferred', // 换座转移到新椅
  REPLACED: 'replaced',       // 故障/撤回后被替换
  REVOKED: 'revoked'          // 随人工撤销而终止
};

// 资源核验状态（旧项目占位迁移后为 pending）
const VERIFICATION = {
  PENDING: 'pending',
  VERIFIED: 'verified'
};

// 待处理方案（资源故障/撤回时生成，绝不自动挪动已锁定席）
const ISSUE_STATUS = { OPEN: 'open', RESOLVED: 'resolved' };
const ISSUE_KIND = { FAULT: 'chair_fault', WITHDRAWN: 'chair_withdrawn' };
const ISSUE_RESOLUTION = {
  REPLACE: 'replace', // 人工替换为另一实体椅
  REVOKE: 'revoke',   // 人工撤销该儿童席
  KEEP: 'keep'        // 原椅修复后继续沿用
};

const GUEST_TYPE = { ADULT: 'adult', CHILD: 'child' };
const RELATION = { TOGETHER: 'together', AVOID: 'avoid' };

const SEAT_LOCK = { LOCKED: true, UNLOCKED: false };

const SCHEMA_VERSION = 2;

module.exports = {
  CHAIR_STATUS,
  CHAIR_STATUSES,
  CHAIR_FREE_STATUSES,
  RESERVATION_STATUS,
  VERIFICATION,
  ISSUE_STATUS,
  ISSUE_KIND,
  ISSUE_RESOLUTION,
  GUEST_TYPE,
  RELATION,
  SEAT_LOCK,
  SCHEMA_VERSION
};
