/* ============================
   Liora Scoring Entreprises
   Couche données — API publiques gratuites
   v1.0.0

   Sources (toutes gratuites, sans clé d'API, sans inscription) :
   • API Recherche d’Entreprises (DINUM / data.gouv.fr)
     https://recherche-entreprises.api.gouv.fr
     Données SIRENE + comptes annuels + labels. Licence ouverte.
   • BODACC — annonces commerciales (DILA, via Opendatasoft)
     https://bodacc-datadila.opendatasoft.com
     Détection des procédures collectives.

   Le module normalise les réponses (les champs de l'API évoluent : tout est lu
   de façon défensive) et met en cache les fiches dans IndexedDB.
   ============================ */

(function (root, factory) {
    'use strict';
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.LioraApi = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const RECHERCHE_URL = 'https://recherche-entreprises.api.gouv.fr/search';
    const BODACC_URL = 'https://bodacc-datadila.opendatasoft.com/api/explore/v2.1/catalog/datasets/annonces-commerciales/records';

    const IDB_NAME = 'liora_scoring';
    const IDB_STORE = 'kv';
    const IDB_VERSION = 1;

    // Durée de vie du cache : les données SIRENE bougent peu, les comptes encore moins.
    const CACHE_TTL_MS = 7 * 24 * 3600 * 1000;

    /* ── IndexedDB (base distincte de celle du Cash Flow Analyzer) ── */

    function openDB() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(IDB_NAME, IDB_VERSION);
            req.onupgradeneeded = () => { req.result.createObjectStore(IDB_STORE); };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    async function idbSet(key, value) {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            tx.objectStore(IDB_STORE).put(value, key);
            tx.oncomplete = () => { db.close(); resolve(true); };
            tx.onerror = () => { db.close(); reject(tx.error); };
        });
    }

    async function idbGet(key) {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readonly');
            const req = tx.objectStore(IDB_STORE).get(key);
            req.onsuccess = () => { db.close(); resolve(req.result); };
            req.onerror = () => { db.close(); reject(req.error); };
        });
    }

    async function idbDelete(key) {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            tx.objectStore(IDB_STORE).delete(key);
            tx.oncomplete = () => { db.close(); resolve(); };
            tx.onerror = () => { db.close(); reject(tx.error); };
        });
    }

    async function idbKeys() {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readonly');
            const req = tx.objectStore(IDB_STORE).getAllKeys();
            req.onsuccess = () => { db.close(); resolve(req.result || []); };
            req.onerror = () => { db.close(); reject(req.error); };
        });
    }

    /* ── Utilitaires ── */

    /** Retire tout ce qui n'est pas un chiffre (espaces, points, tirets). */
    function chiffres(s) { return String(s || '').replace(/\D/g, ''); }

    /** Un SIREN valide fait 9 chiffres et vérifie la clé de Luhn. */
    function sirenValide(siren) {
        const s = chiffres(siren);
        if (s.length !== 9) return false;
        let somme = 0;
        for (let i = 0; i < 9; i++) {
            let d = parseInt(s[i], 10);
            // Position paire (index impair) : on double, puis on réduit au-delà de 9.
            if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
            somme += d;
        }
        return somme % 10 === 0;
    }

    /** Accepte un SIREN (9) ou un SIRET (14) et renvoie le SIREN. */
    function extraireSiren(entree) {
        const s = chiffres(entree);
        if (s.length === 14) return s.slice(0, 9);
        if (s.length === 9) return s;
        return null;
    }

    function toNumber(v) {
        if (v === null || v === undefined || v === '') return null;
        const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/\s/g, '').replace(',', '.'));
        return Number.isFinite(n) ? n : null;
    }

    /** fetch avec délai maximal — évite qu'un onglet reste bloqué sur une API lente. */
    async function fetchJson(url, timeoutMs) {
        const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs || 15000) : null;
        try {
            const res = await fetch(url, {
                signal: ctrl ? ctrl.signal : undefined,
                headers: { 'Accept': 'application/json' }
            });
            if (!res.ok) {
                const err = new Error('HTTP ' + res.status);
                err.status = res.status;
                throw err;
            }
            return await res.json();
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    /* ── Normalisation d'un résultat de l'API Recherche d’Entreprises ── */

    /**
     * Convertit la réponse brute de l'API en fiche stable consommée par le moteur
     * de score. Tous les champs sont optionnels côté API : on ne suppose rien.
     */
    function normalise(r) {
        if (!r || typeof r !== 'object') return null;
        const siege = r.siege || {};
        const comp = r.complements || {};

        // Les comptes annuels sont exposés sous « finances » : { "2022": { ca, resultat_net } }
        const exercices = [];
        if (r.finances && typeof r.finances === 'object') {
            Object.keys(r.finances).forEach(annee => {
                const f = r.finances[annee] || {};
                const an = parseInt(annee, 10);
                if (!Number.isFinite(an)) return;
                exercices.push({
                    annee: an,
                    ca: toNumber(f.ca !== undefined ? f.ca : f.chiffre_d_affaires),
                    resultatNet: toNumber(f.resultat_net !== undefined ? f.resultat_net : f.resultat)
                });
            });
        }
        // Certaines fiches n'exposent qu'un bilan unique dans « complements ».
        if (!exercices.length && comp.bilan_financier && typeof comp.bilan_financier === 'object') {
            const b = comp.bilan_financier;
            const an = parseInt(b.annee || b.date_cloture_exercice, 10);
            if (Number.isFinite(an)) {
                exercices.push({
                    annee: an,
                    ca: toNumber(b.ca !== undefined ? b.ca : b.chiffre_d_affaires),
                    resultatNet: toNumber(b.resultat_net)
                });
            }
        }
        exercices.sort((a, b) => a.annee - b.annee);

        const adresse = siege.adresse
            || [siege.numero_voie, siege.type_voie, siege.libelle_voie].filter(Boolean).join(' ')
            || null;

        return {
            siren: r.siren || null,
            siret: siege.siret || null,
            nom: r.nom_complet || r.nom_raison_sociale || r.denomination || '(sans dénomination)',
            raisonSociale: r.nom_raison_sociale || null,
            sigle: r.sigle || null,
            dateCreation: r.date_creation || siege.date_creation || null,
            etatAdministratif: r.etat_administratif || siege.etat_administratif || null,
            natureJuridique: r.nature_juridique || null,
            activitePrincipale: r.activite_principale || siege.activite_principale || null,
            libelleActivite: r.libelle_activite_principale || siege.libelle_activite_principale || null,
            sectionNaf: r.section_activite_principale || null,
            trancheEffectif: r.tranche_effectif_salarie || null,
            anneeEffectif: r.annee_tranche_effectif_salarie || null,
            categorieEntreprise: r.categorie_entreprise || null,
            anneeCategorie: r.annee_categorie_entreprise || null,
            statutDiffusion: r.statut_diffusion || null,
            etablissementsTotal: toNumber(r.nombre_etablissements),
            etablissementsOuverts: toNumber(r.nombre_etablissements_ouverts),
            dateMiseAJour: r.date_mise_a_jour || null,
            siege: {
                siret: siege.siret || null,
                adresse,
                codePostal: siege.code_postal || null,
                commune: siege.libelle_commune || siege.commune || null,
                departement: siege.departement || null,
                region: siege.region || null,
                etatAdministratif: siege.etat_administratif || null
            },
            dirigeants: Array.isArray(r.dirigeants) ? r.dirigeants.map(d => ({
                nom: [d.prenoms, d.nom].filter(Boolean).join(' ').trim() || d.denomination || d.nom || '—',
                qualite: d.qualite || null,
                anneeNaissance: d.annee_de_naissance || null,
                type: d.type_dirigeant || null
            })) : [],
            exercices,
            conventionCollective: !!comp.convention_collective_renseignee,
            labels: {
                estEss: !!comp.est_ess,
                estRge: !!comp.est_rge,
                estQualiopi: !!comp.est_qualiopi,
                estBio: !!comp.est_bio,
                estServicePublic: !!comp.est_service_public,
                estSocieteMission: !!comp.est_societe_mission,
                estOrganismeFormation: !!comp.est_organisme_formation,
                estAssociation: !!comp.est_association,
                estEntrepreneurIndividuel: !!comp.est_entrepreneur_individuel
            },
            procedures: [],           // renseigné par enrichirProcedures()
            proceduresStatut: 'non-verifie', // non-verifie | ok | indisponible
            recupereLe: new Date().toISOString()
        };
    }

    /* ── API Recherche d’Entreprises ── */

    /**
     * Recherche plein texte (dénomination, dirigeant, adresse…) ou par SIREN/SIRET.
     * @returns {Promise<{results: Array, total: number}>}
     */
    async function rechercher(query, options) {
        options = options || {};
        const q = String(query || '').trim();
        if (!q) return { results: [], total: 0 };

        const params = new URLSearchParams();
        const siren = extraireSiren(q);
        // Un identifiant numérique est envoyé tel quel : l'API indexe SIREN et SIRET.
        params.set('q', siren || q);
        params.set('page', String(options.page || 1));
        params.set('per_page', String(Math.min(options.perPage || 10, 25)));
        if (options.departement) params.set('departement', options.departement);
        if (options.sectionNaf) params.set('section_activite_principale', options.sectionNaf);
        if (options.etat) params.set('etat_administratif', options.etat);

        const data = await fetchJson(RECHERCHE_URL + '?' + params.toString(), options.timeout);
        const results = Array.isArray(data && data.results) ? data.results : [];
        return {
            results: results.map(normalise).filter(Boolean),
            total: toNumber(data && data.total_results) || results.length,
            page: toNumber(data && data.page) || 1,
            totalPages: toNumber(data && data.total_pages) || 1
        };
    }

    /** Récupère une fiche unique par SIREN (9 chiffres) ou SIRET (14 chiffres). */
    async function parSiren(entree, options) {
        const siren = extraireSiren(entree);
        if (!siren) throw new Error('SIREN ou SIRET invalide : ' + entree);
        const res = await rechercher(siren, Object.assign({ perPage: 5 }, options || {}));
        const exact = res.results.find(r => r.siren === siren);
        if (!exact) throw new Error('Aucune entreprise trouvée pour le SIREN ' + siren);
        return exact;
    }

    /* ── BODACC : procédures collectives ── */

    /**
     * Interroge le BODACC pour les annonces de procédure collective d'un SIREN.
     * En cas d'échec (réseau, quota, changement de schéma) on ne fait pas échouer
     * le scoring : le statut passe à « indisponible » et l'UI le signale.
     */
    async function procedures(siren, options) {
        options = options || {};
        const s = chiffres(siren);
        if (s.length !== 9) return { statut: 'indisponible', annonces: [] };

        // Le SIREN apparaît dans le champ « registre » sous deux formes.
        const espace = s.slice(0, 3) + ' ' + s.slice(3, 6) + ' ' + s.slice(6);
        const where = `(registre like "${s}" or registre like "${espace}") and familleavis = "collective"`;
        const params = new URLSearchParams();
        params.set('where', where);
        params.set('limit', '20');
        params.set('order_by', 'dateparution desc');
        params.set('select', 'dateparution,jugement,familleavis_lib,tribunal,commercant,numeroannonce');

        try {
            const data = await fetchJson(BODACC_URL + '?' + params.toString(), options.timeout || 12000);
            const records = Array.isArray(data && data.results) ? data.results : [];
            const annonces = records.map(rec => {
                const j = parseJugement(rec.jugement);
                return {
                    date: rec.dateparution || null,
                    libelle: [j.famille, j.nature, j.complement].filter(Boolean).join(' — ')
                        || rec.familleavis_lib || 'Annonce de procédure collective',
                    tribunal: rec.tribunal || null,
                    famille: j.famille || null,
                    nature: j.nature || null
                };
            }).filter(a => a.date);
            return { statut: 'ok', annonces };
        } catch (e) {
            return { statut: 'indisponible', annonces: [], erreur: e.message };
        }
    }

    /** Le champ « jugement » du BODACC arrive tantôt en objet, tantôt en JSON encodé. */
    function parseJugement(raw) {
        if (!raw) return {};
        let j = raw;
        if (typeof raw === 'string') {
            try { j = JSON.parse(raw); }
            catch (e) { return { nature: raw }; }
        }
        if (!j || typeof j !== 'object') return {};
        return {
            famille: j.famille || null,
            nature: j.nature || null,
            complement: j.complementJugement || j.complement_jugement || null,
            date: j.date || null
        };
    }

    /** Complète une fiche avec ses procédures collectives (mutation en place). */
    async function enrichirProcedures(fiche, options) {
        if (!fiche || !fiche.siren) return fiche;
        const res = await procedures(fiche.siren, options);
        fiche.procedures = res.annonces;
        fiche.proceduresStatut = res.statut;
        if (res.erreur) fiche.proceduresErreur = res.erreur;
        return fiche;
    }

    /* ── Cache ── */

    function cleCache(siren) { return 'cache:' + chiffres(siren); }

    async function ficheEnCache(siren, ttlMs) {
        try {
            const entree = await idbGet(cleCache(siren));
            if (!entree || !entree.fiche) return null;
            const ttl = ttlMs === undefined ? CACHE_TTL_MS : ttlMs;
            if (ttl !== Infinity && Date.now() - (entree.ts || 0) > ttl) return null;
            return entree.fiche;
        } catch (e) {
            return null;
        }
    }

    async function mettreEnCache(fiche) {
        if (!fiche || !fiche.siren) return;
        try { await idbSet(cleCache(fiche.siren), { ts: Date.now(), fiche }); }
        catch (e) { /* quota atteint : le cache est un confort, pas une nécessité */ }
    }

    /**
     * Point d'entrée principal : renvoie une fiche complète (SIRENE + BODACC),
     * depuis le cache si possible, sinon depuis le réseau.
     * @returns {Promise<{fiche: object, origine: 'cache'|'reseau'}>}
     */
    async function obtenirFiche(entree, options) {
        options = options || {};
        const siren = extraireSiren(entree);
        if (!siren) throw new Error('SIREN ou SIRET invalide : ' + entree);

        if (!options.forcerRafraichissement) {
            const cache = await ficheEnCache(siren, options.ttl);
            if (cache) return { fiche: cache, origine: 'cache' };
        }

        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
            // Hors ligne : on se rabat sur le cache même périmé plutôt que d'échouer.
            const perime = await ficheEnCache(siren, Infinity);
            if (perime) return { fiche: perime, origine: 'cache-perime' };
            const err = new Error('Hors ligne et aucune donnée en cache pour le SIREN ' + siren);
            err.horsLigne = true;
            throw err;
        }

        const fiche = await parSiren(siren, options);
        await enrichirProcedures(fiche, options);
        await mettreEnCache(fiche);
        return { fiche, origine: 'reseau' };
    }

    async function viderCache() {
        const cles = await idbKeys();
        await Promise.all(
            cles.filter(k => typeof k === 'string' && k.startsWith('cache:')).map(k => idbDelete(k))
        );
        return cles.filter(k => typeof k === 'string' && k.startsWith('cache:')).length;
    }

    async function tailleCache() {
        const cles = await idbKeys();
        return cles.filter(k => typeof k === 'string' && k.startsWith('cache:')).length;
    }

    return {
        // Réseau
        rechercher, parSiren, procedures, enrichirProcedures, obtenirFiche,
        // Normalisation
        normalise, parseJugement,
        // Cache
        ficheEnCache, mettreEnCache, viderCache, tailleCache, CACHE_TTL_MS,
        // Stockage générique (portefeuille, réglages)
        idbGet, idbSet, idbDelete, idbKeys,
        // Utilitaires
        sirenValide, extraireSiren, chiffres, toNumber
    };
});
