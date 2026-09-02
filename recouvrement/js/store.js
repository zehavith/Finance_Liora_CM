/* ==========================================================
   Liora — Suivi Recouvrement
   store.js — Persistance locale (IndexedDB)
   Rien ne sort du navigateur, hormis les appels à l'API Monday.
   ========================================================== */

(function (global) {
    'use strict';

    const IDB_NAME = 'liora_recouvrement';
    const IDB_STORE = 'kv';
    const IDB_VERSION = 1;

    const KEYS = {
        factures:   'rec_factures',      // factures normalisées
        boards:     'rec_boards',        // configuration des tableaux (rôle, actif)
        mappings:   'rec_mappings',      // mapping colonnes par tableau
        rules:      'rec_rules',         // règles d'échéance personnalisées
        settings:   'rec_settings',      // préférences (token, options)
        imports:    'rec_imports',       // historique des imports
        grandLivre: 'rec_grand_livre',   // extrait de grand livre lettré
        gocardless: 'rec_gocardless',    // exports GoCardless (prélèvements)
        finManuels: 'rec_fin_manuels',   // financements corrigés à la main
        sellsy:     'rec_sellsy',        // export Sellsy pour le contrôle d'exhaustivité
    };

    function openDB() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(IDB_NAME, IDB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    async function set(key, value) {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            tx.objectStore(IDB_STORE).put(value, key);
            tx.oncomplete = () => { db.close(); resolve(true); };
            tx.onerror = () => { db.close(); reject(tx.error); };
        });
    }

    async function get(key, fallback) {
        try {
            const db = await openDB();
            return await new Promise((resolve, reject) => {
                const tx = db.transaction(IDB_STORE, 'readonly');
                const req = tx.objectStore(IDB_STORE).get(key);
                req.onsuccess = () => { db.close(); resolve(req.result === undefined ? fallback : req.result); };
                req.onerror = () => { db.close(); reject(req.error); };
            });
        } catch (e) {
            console.warn('[Recouvrement] Lecture IndexedDB impossible', e);
            return fallback;
        }
    }

    async function del(key) {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            tx.objectStore(IDB_STORE).delete(key);
            tx.oncomplete = () => { db.close(); resolve(true); };
            tx.onerror = () => { db.close(); reject(tx.error); };
        });
    }

    async function clearAll() {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            tx.objectStore(IDB_STORE).clear();
            tx.oncomplete = () => { db.close(); resolve(true); };
            tx.onerror = () => { db.close(); reject(tx.error); };
        });
    }

    /** Estimation de l'espace occupé (best effort). */
    async function usage() {
        if (navigator.storage && navigator.storage.estimate) {
            try {
                const e = await navigator.storage.estimate();
                return { used: e.usage || 0, quota: e.quota || 0 };
            } catch { /* ignore */ }
        }
        return { used: 0, quota: 0 };
    }

    // Demande un stockage persistant pour éviter l'éviction par le navigateur
    if (navigator.storage && navigator.storage.persist) {
        navigator.storage.persist().catch(() => {});
    }

    global.LioraStore = { KEYS, set, get, del, clearAll, usage };
})(window);
