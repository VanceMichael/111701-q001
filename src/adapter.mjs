const STATES = new Set(['active', 'pending', 'confirmed', 'unconfirmed', 'stale', 'cancelled']);

function stringOrNull(value, field) {
  if (value == null) return null;
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error(`${field} 必须是字符串`);
  }
  const text = String(value).trim();
  return text === '' ? null : text;
}

function timeOrNull(value, field) {
  if (value == null) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) {
    throw new Error(`${field} 不是有效时间`);
  }
  return new Date(time).toISOString();
}

function normalizeVehicle(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'object') {
    throw new Error('车辆安排必须是对象');
  }
  const plate = stringOrNull(raw.plate, 'vehicle.plate');
  const id = stringOrNull(raw.id, 'vehicle.id');
  if (!plate && !id) {
    throw new Error('车辆安排缺少 plate 或 id');
  }
  const revision = Number(raw.revision ?? 0);
  if (!Number.isInteger(revision) || revision < 0) {
    throw new Error('vehicle.revision 必须是非负整数');
  }
  return {
    id,
    plate,
    revision,
    driver: stringOrNull(raw.driver, 'vehicle.driver'),
    slotStart: timeOrNull(raw.slotStart, 'vehicle.slotStart'),
    slotEnd: timeOrNull(raw.slotEnd, 'vehicle.slotEnd'),
  };
}

/**
 * 把来源页规整为预约记录。id 是预约身份，车辆安排只作为关联字段，
 * 不允许用车辆信息覆盖或替代预约身份。
 */
export function normalizePage(page) {
  if (!page || typeof page !== 'object') {
    throw new Error('来源页必须是对象');
  }
  if (!page.source) {
    throw new Error('来源页缺少 source');
  }
  if (!Array.isArray(page.items)) {
    throw new Error('来源页缺少 items');
  }
  const pageObservedAt = timeOrNull(page.observedAt, 'observedAt');

  return page.items.map((item) => {
    if (!item || typeof item !== 'object') {
      throw new Error('来源记录必须是对象');
    }
    if (!item.id || !item.label || !item.state) {
      throw new Error('来源记录缺少 id、label 或 state');
    }
    const state = String(item.state).trim();
    if (!STATES.has(state)) {
      throw new Error(`来源记录 state 不受支持: ${state}`);
    }
    const revision = Number(item.revision ?? 0);
    if (!Number.isInteger(revision) || revision < 0) {
      throw new Error('来源记录 revision 必须是非负整数');
    }
    const windowStart = timeOrNull(item.windowStart ?? item.pickupFrom, 'windowStart');
    const windowEnd = timeOrNull(item.windowEnd ?? item.pickupTo, 'windowEnd');
    if (windowStart && windowEnd && Date.parse(windowStart) > Date.parse(windowEnd)) {
      throw new Error('提箱时间窗起止顺序不正确');
    }

    return {
      source: page.source,
      id: String(item.id),
      name: String(item.label).trim(),
      state,
      revision,
      berth: stringOrNull(item.berth, 'berth'),
      windowStart,
      windowEnd,
      vehicle: normalizeVehicle(item.vehicle),
      observedAt: timeOrNull(item.observedAt, 'observedAt') ?? pageObservedAt,
    };
  });
}
