import { createHash } from 'node:crypto';

export function recordKey(record) {
  return `${record.source}:${record.id}`;
}

/**
 * 业务内容指纹。只包含会影响“这张凭证是否仍然成立”的字段，
 * 不包括观察时间、确认状态等采集元数据。
 */
export function recordFingerprint(record) {
  const vehicle = record.vehicle
    ? {
        id: record.vehicle.id ?? null,
        plate: record.vehicle.plate ?? null,
        revision: Number(record.vehicle.revision ?? 0),
      }
    : null;
  const canonical = JSON.stringify([
    record.source,
    record.id,
    record.name ?? null,
    Number(record.revision ?? 0),
    record.state,
    record.berth ?? null,
    record.windowStart ?? null,
    record.windowEnd ?? null,
    vehicle,
  ]);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 24);
}

export function observationTime(record) {
  if (record?.observedAt == null) return null;
  const time = Date.parse(record.observedAt);
  return Number.isFinite(time) ? time : null;
}

/**
 * 以修订号为主、观察时间为辅比较两条记录。
 * 返回 1 表示 incoming 更新，0 表示同一观察，-1 表示 incoming 更旧。
 */
export function compareRecords(incoming, previous) {
  if (Number(incoming.revision) !== Number(previous.revision)) {
    return Number(incoming.revision) > Number(previous.revision) ? 1 : -1;
  }
  const incomingTime = observationTime(incoming);
  const previousTime = observationTime(previous);
  if (incomingTime === null && previousTime === null) return 0;
  if (incomingTime === null) return -1;
  if (previousTime === null) return 1;
  if (incomingTime === previousTime) return 0;
  return incomingTime > previousTime ? 1 : -1;
}

export function asIsoString(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError('时间值无效');
  }
  return date.toISOString();
}
