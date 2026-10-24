// ---------------------------------------------------------------- storage: IndexedDB on this device
// Stores: projects (one record per schedule) and kv (screen preferences). Nothing leaves the device.
const DB_NAME = "cpm-scheduler";
const STORES = ["projects", "kv"];
// A browser that never answers the open (seen with pages opened from a file in some browsers) must
// not hold the start-up: after IDB_WAIT_MS the schedule opens without storage and the status says so.
const IDB_WAIT_MS = 5000;
function idbOpen() {
  return new Promise((resolve, reject) => {
    let req, done = false;
    const timer = setTimeout(() => { done = true; reject(new Error("Storage did not answer.")); }, IDB_WAIT_MS);
    const finish = (fn, v) => { if (done) { if (fn === resolve && v && v.close) v.close(); return; } done = true; clearTimeout(timer); fn(v); };
    try { req = indexedDB.open(DB_NAME, 1); } catch (e) { finish(reject, e); return; }
    req.onupgradeneeded = () => { for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s); };
    req.onsuccess = () => finish(resolve, req.result);
    req.onerror = () => finish(reject, req.error);
    req.onblocked = () => finish(reject, new Error("Another tab is upgrading the stored schedules. Close it and reload."));
  });
}
function idb(store, mode, fn) {
  return new Promise((resolve, reject) => {
    if (!APP.db) { resolve(undefined); return; }
    let tx;
    try { tx = APP.db.transaction(store, mode); } catch (e) { reject(e); return; }
    const r = fn(tx.objectStore(store));
    let out;
    if (r && "onsuccess" in r) r.onsuccess = () => { out = r.result; };
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("Storage refused the write (the device may be full)."));
  });
}
const dbGet = (s, k) => idb(s, "readonly", (st) => st.get(k));
const dbPut = (s, k, v) => idb(s, "readwrite", (st) => st.put(v, k));
const dbDel = (s, k) => idb(s, "readwrite", (st) => st.delete(k));
const dbClear = (s) => idb(s, "readwrite", (st) => st.clear());
async function kvGet(k, d) { try { const v = await dbGet("kv", k); return v === undefined ? d : v; } catch (e) { return d; } }
async function kvSet(k, v) { try { await dbPut("kv", k, v); } catch (e) { /* preferences are a convenience */ } }
