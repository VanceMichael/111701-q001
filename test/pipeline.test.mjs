import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePage } from '../src/adapter.mjs';
import { collect } from '../src/pipeline.mjs';
import { RecordStore } from '../src/store.mjs';
import { issueGatePass, verifyGatePass } from '../src/credentials.mjs';

const T0 = '2026-11-18T08:00:00.000Z';
const T1 = '2026-11-18T08:30:00.000Z';

function appointment(overrides = {}) {
  return {
    id: 'A-100',
    label: '提箱预约甲',
    state: 'active',
    revision: 1,
    berth: 'B-01',
    windowStart: '2026-11-18T09:00:00.000Z',
    windowEnd: '2026-11-18T10:00:00.000Z',
    vehicle: { id: 'truck-1', plate: '沪A·00001', revision: 1 },
    ...overrides,
  };
}

function page(items, overrides = {}) {
  return { source: 'carrier-portal', observedAt: T0, items, ...overrides };
}

function fixedNow(value) {
  return () => new Date(value);
}

test('采集链保留来源、记录身份、车辆安排和观察时间', async () => {
  const store = new RecordStore({ now: fixedNow(T0) });
  const result = await collect({
    source: async () => ({
      source: 'local',
      observedAt: T0,
      items: [{ ...appointment({ id: 'a', label: '样例记录' }) }],
    }),
    store,
    now: fixedNow(T0),
  });
  assert.equal(result.ok, true);
  const [record] = result.records;
  assert.equal(record.source, 'local');
  assert.equal(record.id, 'a');
  assert.equal(record.observedAt, T0);
  assert.equal(record.vehicle.plate, '沪A·00001');
  assert.equal(store.list().length, 1);
  assert.equal(result.credentials.length, 1);
  assert.equal(verifyGatePass(result.credentials[0], store).valid, true);
});

test('采集失败时旧预约降级为待确认且不再出具凭证', async () => {
  const store = new RecordStore({ now: fixedNow(T0) });
  const first = await collect({
    source: async () => page([appointment()]),
    store,
    now: fixedNow(T0),
  });
  assert.equal(first.credentials.length, 1);

  const failed = await collect({
    source: async () => {
      throw new Error('承运商门户连接超时');
    },
    sourceId: 'carrier-portal',
    store,
    now: fixedNow(T1),
  });

  assert.equal(failed.ok, false);
  assert.match(failed.error, /连接超时/);
  assert.equal(failed.affected, 1);
  assert.deepEqual(failed.credentials, []);

  const current = store.get('carrier-portal', 'A-100');
  assert.equal(current.status, 'unconfirmed');
  assert.match(current.unconfirmedReason, /连接超时/);

  // 旧凭证在失联期间必须被拒绝，即使凭证字段本身没变。
  const verdict = verifyGatePass(first.credentials[0], store);
  assert.equal(verdict.valid, false);
  assert.equal(verdict.reason, 'UNCONFIRMED');

  assert.throws(
    () => issueGatePass(current, { now: new Date(T1) }),
    (error) => error.code === 'UNCONFIRMED',
  );
});

test('未指定来源的采集失败会把已知来源一并降级', async () => {
  const store = new RecordStore({ now: fixedNow(T0) });
  await collect({
    source: async () => page([appointment()]),
    store,
    now: fixedNow(T0),
  });
  const failed = await collect({
    source: async () => {
      throw new Error('采集端离线');
    },
    store,
    now: fixedNow(T1),
  });
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.affectedSources, ['carrier-portal']);
  assert.equal(store.get('carrier-portal', 'A-100').status, 'unconfirmed');
});

test('来源页结构损坏时同样降级为待确认', async () => {
  const store = new RecordStore({ now: fixedNow(T0) });
  await collect({
    source: async () => page([appointment()]),
    store,
    now: fixedNow(T0),
  });
  const failed = await collect({
    source: async () => ({ source: 'carrier-portal', items: 'broken' }),
    store,
    now: fixedNow(T1),
  });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /来源页校验失败/);
  assert.deepEqual(failed.credentials, []);
  assert.equal(store.get('carrier-portal', 'A-100').status, 'unconfirmed');
});

test('来源页标识与预期不符时拒绝确认', async () => {
  const store = new RecordStore({ now: fixedNow(T0) });
  await collect({
    source: async () => page([appointment()]),
    store,
    now: fixedNow(T0),
  });
  const failed = await collect({
    source: async () => page([appointment({ revision: 5 })], { source: 'other-portal' }),
    sourceId: 'carrier-portal',
    store,
    now: fixedNow(T1),
  });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /来源页标识不符/);
  assert.equal(store.get('carrier-portal', 'A-100').revision, 1);
  assert.equal(store.get('other-portal', 'A-100'), null);
});

test('泊位改期后旧凭证失效，新凭证对应新时间窗', async () => {
  const store = new RecordStore({ now: fixedNow(T0) });
  const first = await collect({
    source: async () => page([appointment()]),
    store,
    now: fixedNow(T0),
  });

  const second = await collect({
    source: async () =>
      page(
        [
          appointment({
            revision: 2,
            berth: 'B-09',
            windowStart: '2026-11-18T13:00:00.000Z',
            windowEnd: '2026-11-18T14:00:00.000Z',
            vehicle: { id: 'truck-1', plate: '沪A·00001', revision: 1 },
          }),
        ],
        { observedAt: T1 },
      ),
    store,
    now: fixedNow(T1),
  });

  assert.equal(second.records[0].revision, 2);
  assert.equal(second.records[0].berth, 'B-09');
  assert.notEqual(
    second.credentials[0].credentialId,
    first.credentials[0].credentialId,
  );

  const stale = verifyGatePass(first.credentials[0], store);
  assert.equal(stale.valid, false);
  assert.equal(stale.reason, 'SUPERSEDED');
  assert.equal(verifyGatePass(second.credentials[0], store).valid, true);
});

test('车辆安排变化也会使旧凭证失效', async () => {
  const store = new RecordStore({ now: fixedNow(T0) });
  const first = await collect({
    source: async () => page([appointment()]),
    store,
    now: fixedNow(T0),
  });
  const second = await collect({
    source: async () =>
      page([appointment({ revision: 2, vehicle: {
        id: 'truck-2',
        plate: '沪A·00002',
        revision: 1,
      } })], { observedAt: T1 }),
    store,
    now: fixedNow(T1),
  });

  assert.equal(second.credentials[0].vehicle.plate, '沪A·00002');
  const stale = verifyGatePass(first.credentials[0], store);
  assert.equal(stale.valid, false);
  assert.equal(stale.reason, 'SUPERSEDED');
});

test('乱序到达的旧修订被拒绝，不回滚已确认内容', async () => {
  const store = new RecordStore({ now: fixedNow(T1) });
  store.save({ ...normalizePage(page([appointment({ revision: 3, berth: 'B-09' })], { observedAt: T1 }))[0] });
  const replayed = normalizePage(
    page([appointment({ revision: 1, berth: 'B-01' })], { observedAt: T0 }),
  )[0];
  const saved = store.save(replayed);
  assert.equal(saved.revision, 3);
  assert.equal(saved.berth, 'B-09');
  assert.equal(store.events().some((e) => e.type === 'rejected-older'), true);
});

test('同一修订但内容矛盾时标记冲突，不静默覆盖', () => {
  const store = new RecordStore({ now: fixedNow(T1) });
  store.save(normalizePage(page([appointment({ berth: 'B-01' })]))[0]);
  const conflicting = normalizePage(
    page([appointment({ berth: 'B-05' })], { observedAt: T0 }),
  )[0];
  const saved = store.save(conflicting);
  assert.equal(saved.berth, 'B-01');
  assert.equal(saved.conflict, true);
  assert.equal(store.events().some((e) => e.type === 'conflict'), true);
});

test('修订号未变但内容变化时采用新内容并留痕', async () => {
  const store = new RecordStore({ now: fixedNow(T1) });
  await collect({
    source: async () => page([appointment({ berth: 'B-01' })]),
    store,
    now: fixedNow(T0),
  });
  const result = await collect({
    source: async () =>
      page([appointment({ berth: 'B-05' })], { observedAt: T1 }),
    store,
    now: fixedNow(T1),
  });
  assert.equal(result.records[0].berth, 'B-05');
  assert.equal(result.records[0].anomaly, 'CONTENT_CHANGED_WITHOUT_REVISION');
  assert.equal(result.records[0].status, 'confirmed');
});

test('最新来源页未包含的预约降级为待确认', async () => {
  const store = new RecordStore({ now: fixedNow(T0) });
  await collect({
    source: async () =>
      page([appointment({ id: 'A-100' }), appointment({ id: 'A-200' })]),
    store,
    now: fixedNow(T0),
  });
  assert.equal(store.list({ status: 'confirmed' }).length, 2);

  await collect({
    source: async () => page([appointment({ id: 'A-100' })], { observedAt: T1 }),
    store,
    now: fixedNow(T1),
  });
  assert.equal(store.get('carrier-portal', 'A-200').status, 'unconfirmed');
  assert.equal(store.get('carrier-portal', 'A-100').status, 'confirmed');
});

test('分页不完整的来源页不会把未出现记录判为失效', async () => {
  const store = new RecordStore({ now: fixedNow(T0) });
  await collect({
    source: async () =>
      page([appointment({ id: 'A-100' }), appointment({ id: 'A-200' })]),
    store,
    now: fixedNow(T0),
  });
  await collect({
    source: async () =>
      page([appointment({ id: 'A-100' })], { observedAt: T1, complete: false }),
    store,
    now: fixedNow(T1),
  });
  assert.equal(store.get('carrier-portal', 'A-200').status, 'confirmed');
});

test('待确认或未生效的预约不能出证', async () => {
  const store = new RecordStore({ now: fixedNow(T0) });
  const result = await collect({
    source: async () =>
      page([
        appointment({ id: 'A-100', state: 'pending' }),
        appointment({ id: 'A-200', state: 'cancelled' }),
        appointment({ id: 'A-300', vehicle: null }),
      ]),
    store,
    now: fixedNow(T0),
  });
  assert.deepEqual(result.credentials, []);
  assert.equal(result.records.length, 3);
  assert.deepEqual(
    result.withheld.map((item) => item.reason).sort(),
    ['MISSING_VEHICLE', 'STATE_NOT_ISSUABLE', 'STATE_NOT_ISSUABLE'],
  );
});

test('不完整来源记录被拒绝', () => {
  assert.throws(() => normalizePage({ source: 'local', items: [{ id: 'a' }] }));
  assert.throws(() => normalizePage({ items: [] }));
  assert.throws(() => normalizePage({ source: 'local', items: [] , observedAt: 'not-a-date' }));
});

test('时间窗顺序和车辆信息被校验', () => {
  assert.throws(() =>
    normalizePage(
      page([
        appointment({
          windowStart: '2026-11-18T10:00:00.000Z',
          windowEnd: '2026-11-18T09:00:00.000Z',
        }),
      ]),
    ),
  );
  assert.throws(() =>
    normalizePage(page([appointment({ vehicle: { driver: '只有司机' } })])),
  );
});
