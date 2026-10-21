import { openDB } from "idb";

const DB_NAME = "vetrix_erp_db";

/* ---------------- DB INIT ---------------- */

// Open the existing database at its current version. Explicitly requesting v1
// throws VersionError on browsers that already upgraded it to v2.
// New databases still start at v1 and run the upgrade initializer.
export const dbPromise = openDB(DB_NAME, undefined, {
  upgrade(db) {
    if (!db.objectStoreNames.contains("expenses")) {
      db.createObjectStore("expenses", { keyPath: "id" });
    }

    if (!db.objectStoreNames.contains("customers")) {
      db.createObjectStore("customers", { keyPath: "id" });
    }

    if (!db.objectStoreNames.contains("invoices")) {
      db.createObjectStore("invoices", { keyPath: "id" });
    }

    if (!db.objectStoreNames.contains("reports")) {
      db.createObjectStore("reports", { keyPath: "id" });
    }

    if (!db.objectStoreNames.contains("cache")) {
      db.createObjectStore("cache", { keyPath: "key" });
    }
  },
});

/* ---------------- GENERIC API ---------------- */

export async function setItem(store, value) {
  const db = await dbPromise;
  return db.put(store, value);
}

export async function getItem(store, id) {
  const db = await dbPromise;
  return db.get(store, id);
}

export async function getAll(store) {
  const db = await dbPromise;
  return db.getAll(store);
}

export async function deleteItem(store, id) {
  const db = await dbPromise;
  return db.delete(store, id);
}

export async function clearStore(store) {
  const db = await dbPromise;
  return db.clear(store);
}

/* ---------------- CACHE SYSTEM ---------------- */

export async function setCache(key, value) {
  const db = await dbPromise;
  return db.put("cache", {
    key,
    value,
    updatedAt: Date.now(),
  });
}

export async function getCache(key) {
  const db = await dbPromise;
  const res = await db.get("cache", key);
  return res?.value || null;
}