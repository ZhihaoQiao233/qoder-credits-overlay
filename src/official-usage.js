const invalid = () => Object.assign(new Error('Invalid official billing snapshot'), { code: 'invalid-data' });
const text = v => typeof v === 'string' && v.length > 0 && v.length <= 200;
const key = (...parts) => JSON.stringify(parts);

export class OfficialUsageIndex {
  constructor(snapshot = null) {
    this.turns = new Map();
    this.snapshot = null;
    if (!snapshot) return;
    if (snapshot.version !== 1 || !Array.isArray(snapshot.rows) || snapshot.rows.length > 10000 ||
        typeof snapshot.updatedAt !== 'string' || !Number.isFinite(Date.parse(snapshot.updatedAt)) ||
        !Number.isSafeInteger(snapshot.from) || !Number.isSafeInteger(snapshot.to) || snapshot.from > snapshot.to) throw invalid();
    const unique = new Map();
    for (const input of snapshot.rows) {
      if (!input || !['session_id', 'business_id', 'model_category', 'source', 'operation'].every(k => text(input[k])) ||
          !['Charged', 'Not Charged'].includes(input.kind) || typeof input.credits !== 'number' ||
          !Number.isFinite(input.credits) || input.credits < 0 ||
          !Number.isSafeInteger(Math.round(input.credits * 100)) ||
          Math.abs(input.credits * 100 - Math.round(input.credits * 100)) > 0.000001 ||
          (input.kind === 'Not Charged' && input.credits !== 0) ||
          !Number.isSafeInteger(input.begin_at) || input.begin_at < 0 ||
          (input.finish_at !== null && (!Number.isSafeInteger(input.finish_at) || input.finish_at < 0))) throw invalid();
      const row = Object.fromEntries(['session_id', 'business_id', 'credits', 'kind', 'model_category',
        'source', 'operation', 'begin_at', 'finish_at'].map(k => [k, input[k]]));
      const id = key(row.session_id, row.business_id, row.source, row.operation, row.model_category);
      const prior = unique.get(id);
      if (prior && JSON.stringify(prior) !== JSON.stringify(row)) throw invalid();
      unique.set(id, row);
    }
    for (const row of unique.values()) {
      const id = key(row.session_id, row.business_id);
      let turn = this.turns.get(id);
      if (!turn) {
        turn = { cents: 0, models: new Map() };
        this.turns.set(id, turn);
      }
      const cents = Math.round(row.credits * 100);
      turn.cents += cents;
      if (!Number.isSafeInteger(turn.cents)) throw invalid();
      turn.models.set(row.model_category, (turn.models.get(row.model_category) ?? 0) + cents);
    }
    this.snapshot = { version: 1, updatedAt: snapshot.updatedAt, from: snapshot.from, to: snapshot.to, rows: [...unique.values()] };
  }

  get(sessionId, businessId) {
    if (!businessId) return null;
    const turn = this.turns.get(key(sessionId, businessId));
    return turn ? {
      credits: turn.cents / 100,
      byModel: Object.fromEntries([...turn.models].map(([model, cents]) => [model, { total: cents / 100 }])),
      updatedAt: this.snapshot.updatedAt
    } : null;
  }
}
