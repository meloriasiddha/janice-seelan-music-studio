// Local storage on the phone (IndexedDB): projects, recordings and custom instruments.
const DB = "humstudio", VER = 1;
let dbp = null;
function db() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB, VER);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains("projects")) d.createObjectStore("projects", { keyPath: "id" });
      if (!d.objectStoreNames.contains("blobs")) d.createObjectStore("blobs");
      if (!d.objectStoreNames.contains("instruments")) d.createObjectStore("instruments", { keyPath: "id" });
      if (!d.objectStoreNames.contains("kv")) d.createObjectStore("kv");
    };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  return dbp;
}
function tx(store, mode, fn) {
  return db().then(d => new Promise((res, rej) => {
    const t = d.transaction(store, mode), s = t.objectStore(store); let out;
    const r = fn(s); if (r) r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
  }));
}
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

export const saveProject = p => { p.updatedAt = Date.now(); return tx("projects", "readwrite", s => s.put(structuredClone(p))); };
export const getProject = id => tx("projects", "readonly", s => s.get(id));
export const listProjects = () => tx("projects", "readonly", s => s.getAll()).then(a => (a || []).sort((x, y) => y.updatedAt - x.updatedAt));
export const deleteProject = id => tx("projects", "readwrite", s => s.delete(id));

export const putBlob = (id, blob) => tx("blobs", "readwrite", s => s.put(blob, id));
export const getBlob = id => tx("blobs", "readonly", s => s.get(id));
export const deleteBlob = id => tx("blobs", "readwrite", s => s.delete(id));

export const saveInstrument = i => tx("instruments", "readwrite", s => s.put(i));
export const listInstruments = () => tx("instruments", "readonly", s => s.getAll()).then(a => a || []);
export const deleteInstrument = id => tx("instruments", "readwrite", s => s.delete(id));

export const kvGet = k => tx("kv", "readonly", s => s.get(k));
export const kvSet = (k, v) => tx("kv", "readwrite", s => s.put(v, k));

export async function requestPersist() { try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) { } }
