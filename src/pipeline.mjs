import { normalizePage } from './adapter.mjs';
import { issueGatePass, GatePassError } from './credentials.mjs';
import { asIsoString } from './identity.mjs';
import { readSource } from './source.mjs';
import { RecordStore } from './store.mjs';

/**
 * 采集一页预约。
 *
 * 采集成功：页内记录确认入库，车辆安排随预约一起归档，并生成对应凭证。
 * 采集失败：不写入任何新内容，把该来源已有记录降级为待确认并记录原因；
 *   此时不会产出凭证，旧预约也不能继续当作最新凭证发给司机。
 */
export async function collect({
  source = readSource,
  store = new RecordStore(),
  now = () => new Date(),
  issueCredentials = true,
  sourceId = null,
} = {}) {
  const attemptedAt = asIsoString(now());
  const knownSources = () => [...new Set(store.list().map((record) => record.source))];

  const failClosed = (reason) => {
    // 采集失败或来源页不可信时无法确认任何内容：把已知来源全部降级，
    // 不能让旧预约继续以“已确认”状态流出。
    const affectedSources = sourceId ? [sourceId] : knownSources();
    let affected = 0;
    for (const id of affectedSources) {
      affected += store.markUnconfirmed(id, reason, attemptedAt);
    }
    return {
      ok: false,
      source: sourceId,
      affectedSources,
      error: reason,
      attemptedAt,
      affected,
      records: [],
      credentials: [],
      withheld: [],
      store,
    };
  };

  let page;
  try {
    page = await source();
  } catch (cause) {
    return failClosed(`采集失败：${cause?.message ?? '来源不可用'}`);
  }

  let normalized;
  try {
    normalized = normalizePage(page);
  } catch (cause) {
    // 页面读到但结构不可信，等同于没有拿到可确认的最新内容。
    return failClosed(`来源页校验失败：${cause?.message ?? '结构不合法'}`);
  }
  if (sourceId && page.source && page.source !== sourceId) {
    return failClosed(`来源页标识不符：期望 ${sourceId}，实际 ${page.source}`);
  }

  const saved = normalized.map((record) => store.save(record));
  store.reconcilePage(page.source, normalized, {
    at: attemptedAt,
    complete: page.complete !== false,
  });

  const credentials = [];
  const withheld = [];
  if (issueCredentials) {
    for (const record of saved) {
      try {
        credentials.push(issueGatePass(record, { now: attemptedAt }));
      } catch (error) {
        if (!(error instanceof GatePassError)) throw error;
        withheld.push({ record, reason: error.code, detail: error.message });
      }
    }
  }

  return {
    ok: true,
    source: page.source,
    observedAt: page.observedAt ?? null,
    attemptedAt,
    records: saved,
    credentials,
    withheld,
    store,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await collect();
  console.log(
    JSON.stringify(
      {
        ok: result.ok,
        source: result.source ?? null,
        count: result.records.length,
        credentials: result.credentials.length,
        error: result.error ?? null,
      },
      null,
      2,
    ),
  );
  if (!result.ok) process.exitCode = 1;
}
