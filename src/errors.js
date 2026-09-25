'use strict';

class DomainError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DomainError';
    this.code = code; // 机器可读错误码，例如 CHAIR_NOT_AVAILABLE
    this.details = details;
    this.status = details.status || 409;
  }
}

class IdempotencyConflictError extends DomainError {
  constructor(storedRequestHash) {
    super('IDEMPOTENCY_KEY_REUSED', '同一幂等键被用于不同请求体', {
      status: 409,
      storedRequestHash
    });
  }
}

module.exports = { DomainError, IdempotencyConflictError };
