import fs from 'node:fs';
import path from 'node:path';

// Keep the previous complete JSON visible throughout bounded sharing retries.
export async function atomicWriteJson(file, value, { fsImpl = fs, delay = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fsImpl.writeFileSync(temporary, JSON.stringify(value, null, 2));
    const waits = [20, 50, 100];
    for (let attempt = 0; ; attempt++) {
      try { fsImpl.renameSync(temporary, file); return; }
      catch (error) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt === waits.length) throw error;
        await delay(waits[attempt]);
      }
    }
  } finally {
    try { fsImpl.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
