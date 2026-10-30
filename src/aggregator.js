export class UsageAggregator {
  #sessions = new Map();

  #state(sessionId) {
    if (!this.#sessions.has(sessionId)) {
      this.#sessions.set(sessionId, {
        seen: new Set(),
        observed: new Map(),
        all: [],
        taskIds: new Set(),
        startedAt: null,
        completedAt: null
      });
    }
    return this.#sessions.get(sessionId);
  }

  addRecords(sessionId, records) {
    const st = this.#state(sessionId);
    for (const record of records) {
      if (record?.requestId) st.observed.set(record.requestId, record);
      if (!record?.billable || !record.requestId || st.seen.has(record.requestId)) continue;
      if (typeof record.credits !== 'number' || !Number.isFinite(record.credits)) continue;
      st.seen.add(record.requestId);
      st.all.push(record);
      if (
        st.startedAt &&
        record.timestamp >= st.startedAt &&
        (!st.completedAt || record.timestamp <= st.completedAt)
      ) {
        st.taskIds.add(record.requestId);
      }
    }
  }

  forget(sessionId) {
    this.#sessions.delete(sessionId);
  }

  records(sessionId) {
    return [...(this.#sessions.get(sessionId)?.all ?? [])];
  }

  observedRequests(sessionId) {
    return [...(this.#sessions.get(sessionId)?.observed.values() ?? [])];
  }

  startTask(sessionId, at) {
    const st = this.#state(sessionId);
    st.startedAt = at;
    st.completedAt = null;
    st.taskIds = new Set();
    for (const record of st.all) {
      if (record.timestamp >= at) st.taskIds.add(record.requestId);
    }
  }

  stopTask(sessionId, at) {
    const st = this.#state(sessionId);
    st.completedAt = at;
    // startTask claims every record at or after its timestamp, which over-counts
    // when a replay has already ingested the turns that came later.
    st.taskIds = new Set();
    for (const record of st.all) {
      if (record.timestamp >= st.startedAt && record.timestamp <= at) {
        st.taskIds.add(record.requestId);
      }
    }
  }

  sumBetween(sessionId, from, to) {
    const st = this.#sessions.get(sessionId);
    if (!st) return 0;
    return st.all.reduce(
      (total, record) => (record.timestamp > from && record.timestamp <= to ? total + record.credits : total),
      0
    );
  }

  // state.json 的总账按模型分桶，所以记录侧也必须带上模型名才能对上账。
  sumByModelUpTo(sessionId, timestamp) {
    const st = this.#sessions.get(sessionId);
    const totals = {};
    if (!st) return totals;
    for (const record of st.all) {
      if (record.timestamp > timestamp) continue;
      totals[record.model] = (totals[record.model] ?? 0) + record.credits;
    }
    return totals;
  }

  // 总账里记着最后一次落盘的 request_id，照它切一刀就知道总账算到了哪一条记录。
  sumByModelThrough(sessionId, requestId, fallbackTimestamp) {
    const st = this.#sessions.get(sessionId);
    const totals = {};
    if (!st) return totals;
    const cut = requestId ? st.all.findIndex((record) => record.requestId === requestId) : -1;
    if (cut < 0) return this.sumByModelUpTo(sessionId, fallbackTimestamp);
    for (let index = 0; index <= cut; index += 1) {
      const record = st.all[index];
      totals[record.model] = (totals[record.model] ?? 0) + record.credits;
    }
    return totals;
  }

  snapshot(sessionId) {
    const st = this.#state(sessionId);
    const sum = (items) => items.reduce((total, record) => total + record.credits, 0);
    const byModel = (items) => {
      const totals = {};
      for (const record of items) {
        totals[record.model] = (totals[record.model] ?? 0) + record.credits;
      }
      return totals;
    };
    const taskRecords = st.all.filter((record) => st.taskIds.has(record.requestId));
    return {
      taskCredits: sum(taskRecords),
      taskByModel: byModel(taskRecords),
      conversationCredits: sum(st.all),
      conversationByModel: byModel(st.all),
      status: st.completedAt ? 'completed' : st.startedAt ? 'running' : 'waiting',
      startedAt: st.startedAt,
      completedAt: st.completedAt
    };
  }
}
