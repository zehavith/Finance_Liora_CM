/* ==========================================================
   Liora — Suivi Recouvrement
   monday.js — Client API Monday.com (GraphQL v2)

   Le jeton reste dans le navigateur (IndexedDB). Les appels partent
   directement du poste vers https://api.monday.com/v2.
   ========================================================== */

(function (global) {
    'use strict';

    const ENDPOINT = 'https://api.monday.com/v2';
    const API_VERSION = '2024-10';
    const PAGE_SIZE = 100;          // items par page (limite de complexité Monday)
    const RETRY_MAX = 4;

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    /**
     * Exécute une requête GraphQL.
     * Gère les 429 (limite de débit) avec back-off exponentiel.
     */
    async function gql(token, query, variables, onLog) {
        let attempt = 0;
        for (;;) {
            let res;
            try {
                res = await fetch(ENDPOINT, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': token,
                        'API-Version': API_VERSION,
                    },
                    body: JSON.stringify({ query, variables: variables || {} }),
                });
            } catch (netErr) {
                const local = location.protocol === 'file:';
                throw new Error(
                    local
                        ? "L'API Monday n'est pas joignable parce que la page a été ouverte "
                          + "directement depuis un fichier. Fermez cet onglet et lancez "
                          + "« Lancer Suivi Recouvrement » (le fichier .bat sous Windows, "
                          + ".command sur Mac) : la connexion Monday fonctionnera. "
                          + "L'import des exports Excel / CSV, lui, marche déjà ici."
                        : "Impossible de joindre l'API Monday. Vérifiez la connexion Internet "
                          + "et le jeton. Détail : " + netErr.message
                );
            }

            if (res.status === 429 || res.status === 503) {
                attempt++;
                if (attempt > RETRY_MAX) throw new Error('Limite de débit Monday atteinte (429) après plusieurs tentatives.');
                const wait = Math.pow(2, attempt) * 1000;
                if (onLog) onLog(`Limite de débit atteinte — nouvelle tentative dans ${wait / 1000}s…`);
                await sleep(wait);
                continue;
            }

            if (res.status === 401 || res.status === 403) {
                throw new Error('Jeton Monday refusé (HTTP ' + res.status + '). Vérifiez le jeton API dans l\'onglet Données.');
            }

            const text = await res.text();
            let json;
            try { json = JSON.parse(text); }
            catch { throw new Error('Réponse Monday illisible (HTTP ' + res.status + ') : ' + text.slice(0, 200)); }

            if (json.errors && json.errors.length) {
                const msg = json.errors.map(e => e.message).join(' · ');
                const err = new Error('Monday : ' + msg);
                err.graphQLErrors = json.errors;
                throw err;
            }
            if (json.error_message) throw new Error('Monday : ' + json.error_message);
            return json.data;
        }
    }

    /** Vérifie le jeton et retourne le compte connecté. */
    async function me(token) {
        const data = await gql(token, `query { me { id name email account { id name slug } } }`);
        return data.me;
    }

    /** Liste les tableaux accessibles (paginé). */
    async function listBoards(token, onLog) {
        const boards = [];
        let page = 1;
        for (;;) {
            const data = await gql(token, `
                query ($page: Int!, $limit: Int!) {
                    boards (limit: $limit, page: $page, state: active, order_by: used_at) {
                        id
                        name
                        state
                        items_count
                        workspace { id name }
                    }
                }`, { page, limit: 50 }, onLog);
            const batch = (data && data.boards) || [];
            boards.push(...batch);
            if (onLog) onLog(`Tableaux découverts : ${boards.length}`);
            if (batch.length < 50) break;
            page++;
            if (page > 20) break; // garde-fou
        }
        return boards;
    }

    /** Colonnes d'un tableau (id, titre, type). */
    async function boardColumns(token, boardId) {
        const data = await gql(token, `
            query ($ids: [ID!]) {
                boards (ids: $ids) {
                    id name
                    columns { id title type }
                    groups { id title }
                }
            }`, { ids: [String(boardId)] });
        return (data.boards && data.boards[0]) || null;
    }

    // Fragments pour récupérer la valeur affichée des colonnes miroir / formule / liaison.
    const COLUMN_VALUES_FULL = `
        column_values {
            id
            type
            text
            value
            ... on MirrorValue { display_value }
            ... on BoardRelationValue { display_value }
            ... on DependencyValue { display_value }
            ... on FormulaValue { display_value }
        }`;
    const COLUMN_VALUES_BASIC = `column_values { id type text value }`;

    function itemsQuery(colFragment, useCursor) {
        return useCursor
            ? `query ($cursor: String!, $limit: Int!) {
                   next_items_page (cursor: $cursor, limit: $limit) {
                       cursor
                       items { id name group { id title } ${colFragment} }
                   }
               }`
            : `query ($ids: [ID!], $limit: Int!) {
                   boards (ids: $ids) {
                       id name
                       items_page (limit: $limit) {
                           cursor
                           items { id name group { id title } ${colFragment} }
                       }
                   }
               }`;
    }

    /**
     * Récupère tous les items d'un tableau, en gérant la pagination par curseur.
     * Bascule automatiquement sur une requête simplifiée si les fragments
     * miroir/formule ne sont pas supportés par la version d'API du compte.
     */
    async function fetchBoardItems(token, boardId, onLog) {
        let fragment = COLUMN_VALUES_FULL;
        let data;
        try {
            data = await gql(token, itemsQuery(fragment, false), { ids: [String(boardId)], limit: PAGE_SIZE }, onLog);
        } catch (e) {
            if (/on (Mirror|Formula|BoardRelation|Dependency)Value|Fragment|Unknown type/i.test(e.message)) {
                if (onLog) onLog('Colonnes miroir non supportées — requête simplifiée.');
                fragment = COLUMN_VALUES_BASIC;
                data = await gql(token, itemsQuery(fragment, false), { ids: [String(boardId)], limit: PAGE_SIZE }, onLog);
            } else throw e;
        }

        const board = (data.boards && data.boards[0]) || null;
        if (!board) return { board: null, items: [] };

        const items = [...(board.items_page.items || [])];
        let cursor = board.items_page.cursor;
        let guard = 0;

        while (cursor && guard < 500) {
            guard++;
            const next = await gql(token, itemsQuery(fragment, true), { cursor, limit: PAGE_SIZE }, onLog);
            const page = next.next_items_page;
            if (!page) break;
            items.push(...(page.items || []));
            cursor = page.cursor;
            if (onLog) onLog(`${board.name} : ${items.length} éléments…`);
        }

        return { board: { id: board.id, name: board.name }, items };
    }

    /**
     * Valeur exploitable d'une colonne : display_value (miroir/formule) sinon text,
     * sinon extraction depuis le JSON brut (dates, montants).
     */
    function columnValue(cv) {
        if (!cv) return '';
        if (cv.display_value != null && String(cv.display_value).trim() !== '') return String(cv.display_value).trim();
        if (cv.text != null && String(cv.text).trim() !== '') return String(cv.text).trim();
        if (cv.value) {
            try {
                const v = JSON.parse(cv.value);
                if (v == null) return '';
                if (typeof v === 'string' || typeof v === 'number') return String(v);
                if (v.date) return v.time ? `${v.date} ${v.time}` : v.date;
                if (v.text != null) return String(v.text);
                if (v.label != null) return String(v.label);
                if (v.index != null && cv.type === 'status') return '';
                if (Array.isArray(v.linkedPulseIds)) return '';
            } catch { /* ignore */ }
        }
        return '';
    }

    global.LioraMonday = { gql, me, listBoards, boardColumns, fetchBoardItems, columnValue, ENDPOINT, API_VERSION };
})(window);
