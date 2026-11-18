import { createHash } from 'node:crypto';

import { asIsoString, recordFingerprint, recordKey } from './identity.mjs';

const ISSUABLE_STATES = new Set(['active', 'confirmed']);

function credentialId(record) {
  const seed = JSON.stringify([recordKey(record), record.revision, record.fingerprint]);
  return `gp_${createHash('sha256').update(seed).digest('hex').slice(0, 16)}`;
}

/**
 * 生成入场凭证。凭证把预约身份、修订、业务内容指纹和车辆安排绑定在一起，
 * 任何一项变化都会让旧凭证失效，而不是被当成“仍显示有效”。
 *
 * 只有已确认（confirmed）的预约才能出证；待确认的旧预约一律拒绝。
 */
export class GatePassError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GatePassError';
    this.code = code;
  }
}

export function issueGatePass(record, { now = new Date() } = {}) {
  if (!record) {
    throw new GatePassError('MALFORMED', '缺少预约记录');
  }
  if (record.status !== 'confirmed') {
    throw new GatePassError(
      'UNCONFIRMED',
      `预约 ${recordKey(record)} 处于待确认状态，不能生成入场凭证`,
    );
  }
  if (!ISSUABLE_STATES.has(record.state)) {
    throw new GatePassError(
      'STATE_NOT_ISSUABLE',
      `预约 ${recordKey(record)} 的业务状态为 ${record.state}，不能生成入场凭证`,
    );
  }
  if (!record.vehicle?.plate) {
    throw new GatePassError(
      'MISSING_VEHICLE',
      `预约 ${recordKey(record)} 没有车辆安排，不能生成入场凭证`,
    );
  }
  if (!record.windowStart || !record.windowEnd) {
    throw new GatePassError(
      'MISSING_WINDOW',
      `预约 ${recordKey(record)} 缺少提箱时间窗，不能生成入场凭证`,
    );
  }

  return {
    credentialId: credentialId(record),
    source: record.source,
    appointmentId: record.id,
    revision: record.revision,
    fingerprint: record.fingerprint,
    berth: record.berth,
    windowStart: record.windowStart,
    windowEnd: record.windowEnd,
    vehicle: {
      id: record.vehicle.id,
      plate: record.vehicle.plate,
      revision: record.vehicle.revision,
    },
    issuedAt: asIsoString(now),
  };
}

/**
 * 用记录库中的最新预约校验凭证。验票必须查当前状态，
 * 不能只信任凭证上的字段，否则泊位改期后旧凭证仍会通过。
 */
export function verifyGatePass(pass, store) {
  if (!pass?.source || !pass?.appointmentId || !pass?.fingerprint) {
    return { valid: false, reason: 'MALFORMED', detail: '凭证字段不完整' };
  }
  if (pass.revision === undefined || pass.vehicle?.plate === undefined) {
    return { valid: false, reason: 'MALFORMED', detail: '凭证缺少修订或车辆信息' };
  }
  const current = store.get(pass.source, pass.appointmentId);
  if (!current) {
    return { valid: false, reason: 'UNKNOWN_APPOINTMENT', detail: '预约不存在' };
  }
  if (current.status !== 'confirmed') {
    return {
      valid: false,
      reason: 'UNCONFIRMED',
      detail: current.unconfirmedReason ?? '预约待确认',
      current,
    };
  }
  if (!ISSUABLE_STATES.has(current.state)) {
    return {
      valid: false,
      reason: 'STATE_NOT_ISSUABLE',
      detail: `预约业务状态为 ${current.state}`,
      current,
    };
  }
  if (pass.credentialId !== credentialId(current)) {
    return {
      valid: false,
      reason: 'SUPERSEDED',
      detail: '预约或车辆安排已变更，请换取新凭证',
      current,
    };
  }
  if (current.fingerprint !== recordFingerprint(current)) {
    return { valid: false, reason: 'INTEGRITY', detail: '当前记录内容校验失败', current };
  }
  return { valid: true, reason: 'OK', current };
}

export { credentialId };
