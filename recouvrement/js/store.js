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
        dossiers:   'rec_dossiers',      // fichier du financeur (Filiz…) : dates de formation
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

    // QUAND LE NAVIGATEUR REFUSE D'ÉCRIRE.
    //
    // Les trois écritures — poser, retirer, tout effacer — rejetaient, et
    // trente et un sites d'appel sur quarante ne traitaient pas ce rejet :
    // la moitié s'arrêtaient au milieu de leur travail, l'écran ne reflétait
    // plus l'état, et rien ne le disait. Un navigateur en navigation privée,
    // un quota atteint, un stockage bloqué par le site : ce sont des cas
    // ordinaires, pas des pannes.
    //
    // L'écriture rend donc toujours la main. Elle rend true quand elle a
    // tenu, false sinon, et le dit UNE SEULE FOIS à l'écran — répéter le
    // message à chaque touche noierait l'information. L'application va au
    // bout de son rendu : ce qu'elle montre est juste pour cette session,
    // même si rien n'en sera conservé.
    let refusSignale = false;
    function refuse(e, quoi) {
        console.warn('[Recouvrement] ' + quoi + ' impossible', e);
        if (refusSignale) return false;
        refusSignale = true;
        const U = global.LioraUI;
        if (U && U.toast) U.toast('Ce navigateur refuse d’enregistrer : votre travail '
            + 'reste affiché, mais il ne sera pas conservé à la prochaine ouverture.',
            'error', 15000);
        return false;
    }

    async function ecrire(quoi, action) {
        try {
            const db = await openDB();
            return await new Promise((resolve, reject) => {
                const tx = db.transaction(IDB_STORE, 'readwrite');
                action(tx.objectStore(IDB_STORE));
                tx.oncomplete = () => { db.close(); resolve(true); };
                tx.onerror = () => { db.close(); reject(tx.error); };
            });
        } catch (e) {
            return refuse(e, quoi);
        }
    }

    async function set(key, value) {
        return ecrire('Enregistrement', o => o.put(value, key));
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
        return ecrire('Suppression', o => o.delete(key));
    }

    async function clearAll() {
        return ecrire('Effacement', o => o.clear());
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

    // LE MAGASIN EST PUBLIÉ AVANT TOUT LE RESTE.
    //
    // La demande de stockage persistant se faisait avant cette ligne. Un jet
    // synchrone à cet endroit — un navigateur qui refuse l'API, une fenêtre
    // privée — laissait window.LioraStore indéfini pour toute l'application,
    // et plus rien ne se chargeait. L'ordre est inversé et la demande est
    // protégée : elle est un confort, pas une condition.
    global.LioraStore = { KEYS, set, get, del, clearAll, usage };

    // Demande un stockage persistant pour éviter l'éviction par le navigateur
    try {
        if (navigator.storage && navigator.storage.persist) {
            navigator.storage.persist().catch(() => {});
        }
    } catch { /* le navigateur refuse l'API : on s'en passe */ }
})(window);
