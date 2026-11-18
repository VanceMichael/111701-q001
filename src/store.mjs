import {
  asIsoString,
  compareRecords,
  observationTime,
  recordFingerprint,
  recordKey,
} from './identity.mjs';

/**
 * 预约记录库。
 *
 * 每条记录带三类信息：
 * - 预约身份：source + id（提箱预约号）
 * - 业务内容：时间窗、泊位、车辆安排、修订号
 * - 凭证状态：confirmed（已与承运商核对）/ unconfirmed（待确认）/ superseded（已被新修订替代）
 *
 * 只有 confirmed 的记录才能生成发给司机的入场凭证。
 */
export class RecordStore {
  #records = new Map();
  #events = [];
  #now;

  constructor({ now = () => new Date() } = {}) {
    this.#now = now;
  }

  save(record, { confirmed = true } = {}) {
    if (!record?.source || !record?.id) {
      throw new Error('记录缺少 source 或 id');
    }
    const key = recordKey(record);
    const previous = this.#records.get(key);
    const fingerprint = recordFingerprint(record);
    const nowIso = asIsoString(this.#now());

    let comparison = null;
    if (previous) {
      comparison = compareRecords(record, previous);
      if (comparison < 0) {
        // 乱序到达的旧修订不能回滚已确认的内容。
        this.#log('rejected-older', key, {
          incomingRevision: record.revision,
          previousRevision: previous.revision,
        });
        return structuredClone(previous);
      }
      if (comparison === 0 && fingerprint !== previous.fingerprint) {
        // 同一修订、同一观察时间却内容不同：来源自相矛盾，不能静默采用。
        this.#log('conflict', key, { revision: record.revision });
        const kept = structuredClone(previous);
        kept.conflict = true;
        return kept;
      }
      if (comparison > 0) {
        this.#log(
          fingerprint === previous.fingerprint ? 'revision' : 'content-changed',
          key,
          { fromRevision: previous.revision, toRevision: record.revision },
        );
      }
    } else {
      this.#log('created', key);
    }

    const next = {
      ...record,
      fingerprint,
      status: confirmed ? 'confirmed' : 'unconfirmed',
      confirmedAt: confirmed ? nowIso : null,
      unconfirmedSince: confirmed ? null : nowIso,
      unconfirmedReason: confirmed ? null : record.unconfirmedReason ?? null,
      conflict: false,
      anomaly: null,
    };
    if (
      previous &&
      comparison > 0 &&
      fingerprint !== previous.fingerprint &&
      Number(record.revision) === Number(previous.revision)
    ) {
      // 修订号没变、内容却变了：采用较新的观察结果，但留痕供闸口核对。
      next.anomaly = 'CONTENT_CHANGED_WITHOUT_REVISION';
    }
    this.#records.set(key, structuredClone(next));
    return structuredClone(next);
  }

  get(source, id) {
    const entry = this.#records.get(`${source}:${id}`);
    return entry ? structuredClone(entry) : null;
  }

  list(filter = {}) {
    return [...this.#records.values()]
      .filter((record) => !filter.source || record.source === filter.source)
      .filter((record) => !filter.status || record.status === filter.status)
      .map((record) => structuredClone(record));
  }

  /**
   * 采集端失联：该来源下所有已确认记录降级为待确认。
   * 旧内容仍保留用于追溯，但不再具备凭证效力。
   */
  markUnconfirmed(source, reason, at = this.#now()) {
    const nowIso = asIsoString(at);
    let changed = 0;
    for (const [key, record] of this.#records) {
      if (record.source !== source) continue;
      if (record.status === 'confirmed') {
        record.status = 'unconfirmed';
        record.unconfirmedSince = nowIso;
        record.unconfirmedReason = reason;
        record.confirmedAt = null;
        changed += 1;
        this.#log('marked-unconfirmed', key, { reason, at: nowIso });
      } else if (record.status === 'unconfirmed' && record.unconfirmedReason !== reason) {
        record.unconfirmedReason = reason;
      }
    }
    return changed;
  }

  /**
   * 成功取得一页来源数据后调用：页内记录视为已确认。
   * 只有整页完整（complete !== false）时，才把该来源中未出现在本页的记录降级为待确认；
   * 分页/截断的页面不能据此判定预约消失。
   */
  reconcilePage(source, pageRecords, { at = this.#now(), complete = true } = {}) {
    if (!complete) return 0;
    const nowIso = asIsoString(at);
    const seen = new Set(pageRecords.map((record) => String(record.id)));
    let changed = 0;
    for (const [key, record] of this.#records) {
      if (record.source !== source) continue;
      if (seen.has(String(record.id))) continue;
      if (record.status === 'confirmed') {
        record.status = 'unconfirmed';
        record.unconfirmedSince = nowIso;
        record.unconfirmedReason = '最新来源页未包含该预约';
        record.confirmedAt = null;
        changed += 1;
        this.#log('marked-unconfirmed', key, {
          reason: record.unconfirmedReason,
          at: nowIso,
        });
      }
    }
    return changed;
  }

  events() {
    return this.#events.map((event) => structuredClone(event));
  }

  #log(type, key, { reason = null, at = null } = {}) {
    this.#events.push({
      type,
      key,
      reason,
      at: at ?? asIsoString(this.#now()),
    });
  }
}

export { recordKey, recordFingerprint, observationTime, compareRecords };
