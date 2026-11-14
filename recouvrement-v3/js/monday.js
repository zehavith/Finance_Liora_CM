/* ==========================================================
   Liora — Suivi Recouvrement
   monday.js — Client API Monday.com (GraphQL v2)

   Le jeton reste dans le navigateur (IndexedDB). Les appels partent
   directement du poste vers https://api.monday.com/v2.

   VERSION 3 — UN SECOND CHEMIN, LE CONNECTEUR.
   Une page publiée n'a pas le droit d'appeler api.monday.com, mais elle
   peut passer par le connecteur monday.com de claude.ai, avec le compte
   de la personne qui regarde. Quand le « jeton » vaut CONNECTEUR, les
   quatre fonctions ci-dessous empruntent ce chemin : mêmes signatures,
   mêmes réponses, de sorte que l'application ne voit aucune différence.
   La lecture se fait groupe par groupe, sans les groupes de service,
   comme dans « Suivi recouvrement version 2 ».
   ========================================================== */

(function (global) {
    'use strict';

    const ENDPOINT = 'https://api.monday.com/v2';
    const API_VERSION = '2024-10';
    const PAGE_SIZE = 100;          // items par page (limite de complexité Monday)
    const RETRY_MAX = 4;

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    // ══════════════════════════════════════════════
    //  Le connecteur monday.com de claude.ai
    // ══════════════════════════════════════════════

    const CONNECTEUR = 'connecteur:monday.com';
    const SERVEUR = 'monday.com';
    const OUTIL = 'all_monday_api';

    // Les neuf tableaux du circuit, par leur identifiant Monday.
    const TABLEAUX_CONNECTEUR = [
        '1842356810',   // 0.1. ALL - Factures payées
        '1818713092',   // 1.0. Entreprise - Tampon
        '1817877566',   // 1.1. Entreprise - ADV
        '1840539926',   // 1.2. Entreprise - Recouvrement
        '5099882263',   // 1.3. Entreprise - OPCO
        '1909949610',   // 2.1. Financement Personnel
        '1912012437',   // 2.2. Financement CPF
        '1912012068',   // 2.3. Financement pôle emploi : AIF / POEI
        '1912012597',   // 2.4. Financement complexe : REGION / TRANSITION / AGEFIPH
    ];

    // Le canal s'ouvre une fois. null : la page est ouverte hors de
    // claude.ai, ou les connecteurs ne sont pas servis dans cette vue.
    let canalOuvert = null;
    function canal() {
        if (!canalOuvert) {
            canalOuvert = (global.claude && typeof global.claude.use === 'function')
                ? global.claude.use('mcp').then(c => c || null, () => null)
                : Promise.resolve(null);
        }
        return canalOuvert;
    }
    function connecteurDisponible() { return canal().then(c => !!c); }

    /** Ce que la lectrice doit lire, selon ce que le connecteur a répondu. */
    function erreurConnecteur(e) {
        const code = e && e.code;
        const textes = {
            server_not_connected: 'Le connecteur monday.com n’est pas ajouté à votre compte : '
                + 'ajoutez-le dans claude.ai, Réglages → Connecteurs, puis relancez l’actualisation.',
            server_not_found: 'Le connecteur monday.com n’existe plus sur votre compte : '
                + 'ajoutez-le de nouveau dans claude.ai, Réglages → Connecteurs.',
            needs_reauth: 'La connexion monday.com a expiré : reconnectez-la dans claude.ai, '
                + 'Réglages → Connecteurs, puis relancez l’actualisation.',
            not_in_manifest: 'L’accès à monday.com n’a pas été autorisé pour cette page. '
                + 'Relancez l’actualisation et acceptez la demande.',
            approval_required: 'L’accès à monday.com n’a pas été autorisé pour cette page. '
                + 'Relancez l’actualisation et acceptez la demande.',
            consent_required: 'L’accès à monday.com n’a pas été autorisé pour cette page. '
                + 'Relancez l’actualisation et acceptez la demande.',
            blocked_by_policy: 'Votre organisation bloque cet outil monday.com pour votre compte.',
            selection_required: 'Plusieurs connecteurs monday.com existent sur votre compte : '
                + 'choisissez-en un dans la fenêtre proposée par claude.ai, puis relancez.',
            server_unavailable: 'monday.com ne répond pas pour le moment. Réessayez dans quelques minutes.',
            not_granted: 'Les connecteurs ne sont pas disponibles dans cette vue.',
            capability_disabled: 'Les connecteurs ne sont pas disponibles dans cette vue.',
            capability_removed: 'Les connecteurs ne sont pas disponibles dans cette vue.',
        };
        const err = new Error(Object.prototype.hasOwnProperty.call(textes, code)
            ? textes[code]
            : 'Monday : ' + ((e && e.message) || String(e)));
        err.code = code || 'upstream_error';
        return err;
    }

    // Monday limite le débit par « budget de complexité » : il le dit dans
    // le message, avec le nombre de secondes à attendre.
    function pauseDemandee(texte) {
        const t = String(texte || '');
        if (!/complexity|budget|rate limit|too many requests|minute limit/i.test(t)) return 0;
        const m = /(\d+)\s*seconds?/i.exec(t);
        return Math.min(60, Math.max(2, m ? parseInt(m[1], 10) + 1 : 10));
    }

    /**
     * Une requête GraphQL par le connecteur. Les variables sont écrites dans
     * la requête : c'est la forme éprouvée par la version 2.
     */
    async function gqlConnecteur(query, onLog) {
        const mcp = await canal();
        if (!mcp) throw erreurConnecteur({ code: 'capability_disabled' });
        let pauses = 0, repris = false;
        for (;;) {
            let res;
            try {
                res = await mcp.callTool(SERVEUR, OUTIL, { query, variables: '{}' }, { cache: false });
            } catch (e) {
                const attente = pauseDemandee(e && e.message);
                if (attente && pauses < RETRY_MAX) {
                    pauses++;
                    if (onLog) onLog(`Limite de débit atteinte — nouvelle tentative dans ${attente}s…`);
                    await sleep(attente * 1000);
                    continue;
                }
                // Une lecture marquée « à retenter » se retente une fois, pas plus.
                if (e && e.retryable && !repris) {
                    repris = true;
                    await sleep((e.retryAfterMs || 1500) + Math.random() * 800);
                    continue;
                }
                throw erreurConnecteur(e);
            }
            let p = res && res.payload;
            if (typeof p === 'string') {
                const attente = pauseDemandee(p);
                if (attente && pauses < RETRY_MAX) {
                    pauses++;
                    if (onLog) onLog(`Limite de débit atteinte — nouvelle tentative dans ${attente}s…`);
                    await sleep(attente * 1000);
                    continue;
                }
                try { p = JSON.parse(p); }
                catch { throw new Error('Réponse Monday illisible : ' + p.slice(0, 200)); }
            }
            if (p && p.errors && p.errors.length) {
                const msg = p.errors.map(x => x.message).join(' · ');
                const attente = pauseDemandee(msg);
                if (attente && pauses < RETRY_MAX) {
                    pauses++;
                    if (onLog) onLog(`Limite de débit atteinte — nouvelle tentative dans ${attente}s…`);
                    await sleep(attente * 1000);
                    continue;
                }
                throw new Error('Monday : ' + msg);
            }
            if (p && p.error_message) throw new Error('Monday : ' + p.error_message);
            if (p && p.data) p = p.data;
            if (!p || typeof p !== 'object') throw new Error('Réponse Monday vide.');
            return p;
        }
    }

    const idsEnClair = ids => ids.map(i => String(i).replace(/[^0-9]/g, '')).filter(Boolean).join(', ');

    // ══════════════════════════════════════════════
    //  NE RELIRE QUE CE QUI A BOUGÉ
    // ══════════════════════════════════════════════
    //
    // « Au lieu de recharger tout à chaque fois, tu ne charges que les
    // mouvements, pour que ça prenne moins de temps. » Une lecture complète
    // des neuf tableaux demande plusieurs minutes ; d'une lecture à l'autre,
    // quelques dizaines de lignes seulement ont changé.
    //
    // Après une lecture complète, les lignes de chaque tableau sont gardées
    // dans ce navigateur avec l'heure de la lecture. La fois suivante, on
    // demande à Monday son JOURNAL depuis cette heure : il nomme chaque
    // facture créée, modifiée, déplacée ou supprimée. Seules ces factures-là
    // sont relues, puis reposées sur la copie gardée.
    //
    // Ce que le journal ne voit pas : une colonne « miroir », dont la valeur
    // vient d'un autre tableau, peut changer sans que la ligne soit touchée.
    // C'est pourquoi la lecture complète reste proposée, et qu'elle s'impose
    // d'elle-même quand la copie manque ou que trop de lignes ont bougé.
    let modeConnecteur = 'rapide';
    function definirModeConnecteur(m) { modeConnecteur = m === 'complet' ? 'complet' : 'rapide'; }
    const cleCopie = id => 'rec_v3_items_' + id;
    // Une ligne gardée ne porte que ses colonnes renseignées : la copie des
    // neuf tableaux tient ainsi dans le stockage du navigateur.
    const alleger = it => ({ id: it.id, name: it.name, group: it.group,
        column_values: (it.column_values || []).filter(cv =>
            (cv.text != null && cv.text !== '') || (cv.display_value != null && cv.display_value !== '')
            || (cv.value != null && cv.value !== '' && cv.value !== 'null')) });

    async function copieConnecteur() {
        const S = global.LioraStore;
        if (!S) return null;
        let plusAncienne = null, nb = 0;
        for (const id of TABLEAUX_CONNECTEUR) {
            const c = await S.get(cleCopie(id), null);
            if (!c || !c.lu || !Array.isArray(c.items)) return null;
            nb += c.items.length;
            if (!plusAncienne || c.lu < plusAncienne) plusAncienne = c.lu;
        }
        return { lu: plusAncienne, nb };
    }

    /** La lecture rapide d'un tableau. Rend null quand il faut tout relire. */
    async function lireChangements(id, onLog, onProgres) {
        const S = global.LioraStore;
        const copie = S ? await S.get(cleCopie(id), null) : null;
        if (!copie || !copie.lu || !Array.isArray(copie.items)) return null;
        const R = global.LioraRules;
        const technique = t => !!(R && R.estGroupeTechnique && R.estGroupeTechnique(t));

        const maintenant = new Date();
        // Dix minutes de recouvrement : une ligne modifiée pendant la lecture
        // précédente ne doit pas passer entre les deux.
        const depuis = new Date(new Date(copie.lu).getTime() - 10 * 60000).toISOString();
        const jusqua = new Date(maintenant.getTime() + 86400000).toISOString();
        const touchees = new Set();
        let curseur = null, pages = 0, nom = copie.nom || '';
        do {
            const d = await gqlConnecteur(`query { boards(ids: [${id}]) { id name activity_logs(`
                + `from: "${depuis}", to: "${jusqua}", limit: 1000`
                + (curseur ? ', cursor: ' + JSON.stringify(curseur) : '') + ') { cursor logs { data } } } }', onLog);
            const b = (d.boards && d.boards[0]) || null;
            if (!b) return null;
            nom = b.name || nom;
            const page = b.activity_logs || {};
            for (const l of (page.logs || [])) {
                let x; try { x = JSON.parse(l.data); } catch { continue; }
                const pid = x && (x.pulse_id || (x.pulse && x.pulse.id) || x.item_id);
                if (pid) touchees.add(String(pid));
            }
            curseur = page.cursor || null;
            pages++;
            // Un journal aussi long veut dire que presque tout a bougé :
            // relire le tableau en entier coûte alors moins cher.
            if (curseur && pages >= 15) return null;
        } while (curseur);
        if (touchees.size > Math.max(400, copie.items.length * 0.4)) return null;

        const parId = new Map(copie.items.map(it => [String(it.id), it]));
        const ids = [...touchees];
        let relues = 0;
        for (let i = 0; i < ids.length; i += 100) {
            const lot = ids.slice(i, i + 100);
            const d = await gqlConnecteur(`query { items(ids: [${idsEnClair(lot)}], limit: 100) `
                + `{ id name state board { id } group { id title } ${COLUMN_VALUES_FULL} } }`, onLog);
            const vues = new Map(((d && d.items) || []).map(it => [String(it.id), it]));
            for (const pid of lot) {
                const it = vues.get(pid);
                // Supprimée, archivée, partie sur un autre tableau ou rangée
                // dans un groupe de service : elle quitte la copie.
                const garde = it && it.state === 'active' && it.board && String(it.board.id) === String(id)
                    && it.group && !technique(it.group.title);
                if (garde) parId.set(pid, alleger(it)); else parId.delete(pid);
            }
            relues += lot.length;
            if (onProgres) onProgres({ recus: relues });
        }
        const items = [...parId.values()];
        if (S) await S.set(cleCopie(id), { lu: maintenant.toISOString(), nom, items });
        if (onLog) onLog(`   lecture rapide : ${touchees.size} ligne(s) modifiée(s) depuis le `
            + new Date(copie.lu).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }));
        return { board: { id: String(id), name: nom, itemsCount: items.length },
                 items, tronque: false, simplifiee: false, rapide: true, modifiees: touchees.size };
    }

    async function fetchBoardItemsConnecteur(boardId, onLog, onProgres) {
        const id = idsEnClair([boardId]);
        if (modeConnecteur === 'rapide') {
            try {
                const r = await lireChangements(id, onLog, onProgres);
                if (r) return r;
                if (onLog) onLog('   pas de copie utilisable de ce tableau — lecture complète');
            } catch (e) {
                // Une erreur du connecteur (accès refusé, connexion expirée)
                // n'est pas une raison de tout relire : elle remonte telle quelle.
                if (e && e.code && e.code !== 'upstream_error') throw e;
                if (onLog) onLog('   lecture rapide impossible (' + (e && e.message || e) + ') — lecture complète');
            }
        }
        const debutLecture = new Date();
        const d = await gqlConnecteur(
            `query { boards(ids: [${id}]) { id name items_count groups { id title } } }`, onLog);
        const board = (d.boards && d.boards[0]) || null;
        if (!board) return { board: null, items: [] };

        // Les groupes de service — Technique, Archive — ne sont pas lus : ils
        // portent plusieurs milliers de lignes closes que l'application
        // écarterait de toute façon. C'est la règle de l'application
        // elle-même qui les désigne, pas une liste écrite ici.
        const R = global.LioraRules;
        const technique = t => !!(R && R.estGroupeTechnique && R.estGroupeTechnique(t));
        const groupes = (board.groups || []).filter(g => !technique(g.title));
        const ecartes = (board.groups || []).length - groupes.length;
        if (ecartes && onLog) onLog(`   ${ecartes} groupe(s) de service non lu(s) (Technique, Archive…)`);

        let recus = 0;
        const tracer = m => {
            if (onLog) onLog(m);
            const attente = /nouvelle tentative dans (\d+)s/.exec(m);
            if (attente && onProgres) onProgres({ recus, attente: +attente[1] });
        };

        async function lireGroupe(g, limite) {
            const sel = `cursor items { id name ${COLUMN_VALUES_FULL} }`;
            const items = [];
            const prendre = page => {
                for (const it of ((page && page.items) || [])) {
                    it.group = { id: g.id, title: g.title };
                    items.push(it);
                }
                recus += ((page && page.items) || []).length;
                if (onProgres) onProgres({ recus });
                return page && page.cursor;
            };
            const d1 = await gqlConnecteur(
                `query { boards(ids: [${id}]) { groups(ids: [${JSON.stringify(String(g.id))}]) `
                + `{ items_page(limit: ${limite}) { ${sel} } } } }`, tracer);
            const gr = (((d1.boards || [])[0] || {}).groups || [])[0];
            let curseur = prendre(gr && gr.items_page);
            let garde = 0;
            while (curseur && garde < 200) {
                garde++;
                const d2 = await gqlConnecteur(
                    `query { next_items_page(cursor: ${JSON.stringify(curseur)}, limit: ${limite}) { ${sel} } }`,
                    tracer);
                curseur = prendre(d2.next_items_page);
            }
            return { items, tronque: !!curseur };
        }

        const parGroupe = new Array(groupes.length);
        let suivant = 0, tronque = false;
        async function ouvrier() {
            while (suivant < groupes.length) {
                const i = suivant++;
                const g = groupes[i];
                const avant = recus;
                let lu;
                try {
                    lu = await lireGroupe(g, 250);
                } catch (e) {
                    // Une page trop lourde pour Monday : on la redemande plus petite.
                    if (!/complexity/i.test(e.message || '')) throw e;
                    recus = avant;
                    lu = await lireGroupe(g, 100);
                }
                parGroupe[i] = lu.items;
                if (lu.tronque) tronque = true;
                if (onLog) onLog(`   ${g.title} : ${lu.items.length} éléments`);
            }
        }
        await Promise.all([ouvrier(), ouvrier(), ouvrier()]);

        const items = [].concat(...parGroupe.filter(Boolean));
        // La copie de ce tableau, pour que la prochaine lecture n'ait à
        // demander que les changements.
        try {
            const S = global.LioraStore;
            if (S && !tronque) await S.set(cleCopie(id), { lu: debutLecture.toISOString(), nom: board.name,
                                                           items: items.map(alleger) });
        } catch (e) { /* sans copie, la prochaine lecture sera complète */ }
        // Le décompte annoncé est celui des groupes lus : celui de Monday
        // compte aussi les groupes de service, et ferait passer pour
        // manquantes des lignes qu'on a choisi de ne pas lire.
        return { board: { id: String(board.id), name: board.name, itemsCount: items.length },
                 items, tronque, simplifiee: false, groupesEcartes: ecartes };
    }

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
                        : "Cette page publiée ne peut pas appeler l'API Monday : seuls "
                          + "quelques hôtes lui sont ouverts, et api.monday.com n'en fait "
                          + "pas partie. Ce n'est ni votre connexion ni votre jeton. "
                          + "Importez les exports Excel / CSV de vos tableaux, ou ouvrez "
                          + "l'application sur votre poste pour la connexion directe."
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
        if (token === CONNECTEUR) {
            return (await gqlConnecteur('query { me { id name account { id name slug } } }')).me;
        }
        const data = await gql(token, `query { me { id name email account { id name slug } } }`);
        return data.me;
    }

    /** Liste les tableaux accessibles (paginé). */
    async function listBoards(token, onLog) {
        if (token === CONNECTEUR) {
            const d = await gqlConnecteur(
                `query { boards(ids: [${idsEnClair(TABLEAUX_CONNECTEUR)}]) `
                + '{ id name state items_count workspace { id name } } }', onLog);
            return (d && d.boards) || [];
        }
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
        if (token === CONNECTEUR) {
            const d = await gqlConnecteur(
                `query { boards(ids: [${idsEnClair([boardId])}]) `
                + '{ id name columns { id title type } groups { id title } } }');
            return (d.boards && d.boards[0]) || null;
        }
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
                       id name items_count
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
    async function fetchBoardItems(token, boardId, onLog, onProgres) {
        if (token === CONNECTEUR) return fetchBoardItemsConnecteur(boardId, onLog, onProgres);
        let fragment = COLUMN_VALUES_FULL;
        let data;
        // Un gros tableau se pagine en plusieurs dizaines d'appels et peut
        // demander plusieurs minutes. Sans nouvelle à chaque page, l'écran
        // reste figé sur le même pourcentage et rien ne dit si ça avance
        // encore ou si c'est bloqué. On rend donc compte page par page, et
        // l'on signale aussi les attentes imposées par Monday.
        let recus = 0;
        // Quand Monday refuse la requête complète, les colonnes miroir et
        // formule reviennent vides. Une colonne au bon nom paraît alors
        // entièrement vide et se fait écarter — sans que rien ne dise que
        // c'est la requête, et non le tableau, qui est en cause.
        let simplifiee = false;
        const tracer = m => {
            if (onLog) onLog(m);
            const attente = /nouvelle tentative dans (\d+)s/.exec(m);
            if (attente && onProgres) onProgres({ recus, attente: +attente[1] });
        };
        try {
            data = await gql(token, itemsQuery(fragment, false), { ids: [String(boardId)], limit: PAGE_SIZE }, tracer);
        } catch (e) {
            if (/on (Mirror|Formula|BoardRelation|Dependency)Value|Fragment|Unknown type/i.test(e.message)) {
                if (onLog) onLog('Colonnes miroir non supportées — requête simplifiée.');
                simplifiee = true;
                fragment = COLUMN_VALUES_BASIC;
                data = await gql(token, itemsQuery(fragment, false), { ids: [String(boardId)], limit: PAGE_SIZE }, tracer);
            } else throw e;
        }

        const board = (data.boards && data.boards[0]) || null;
        if (!board) return { board: null, items: [] };

        const items = [...(board.items_page.items || [])];
        recus = items.length;
        if (onProgres) onProgres({ recus });
        let cursor = board.items_page.cursor;
        let guard = 0;

        // Le garde-fou existe pour qu'une pagination qui boucle n'immobilise
        // pas l'application. Mais s'il se déclenche, il manque des lignes : le
        // dire est indispensable — un tableau tronqué en silence donne une
        // balance fausse sans que rien ne l'indique.
        const MAX_PAGES = 500;
        // Le curseur de pagination expire.
        //
        // Sur un gros tableau, la récupération dure plusieurs minutes et Monday
        // finit par refuser le curseur : « CursorExpiredError ». Le chargement
        // échouait alors entièrement, et le tableau des factures payées — près
        // de sept mille lignes — revenait vide après dix minutes d'attente.
        //
        // Le curseur ne se renouvelle pas : il faut reprendre la pagination
        // depuis la première page. On le fait une fois, automatiquement, plutôt
        // que de rendre la main sur une erreur technique. Deux tentatives
        // perdues valent mieux qu'un tableau manquant.
        let reprises = 0;
        while (cursor && guard < MAX_PAGES) {
            guard++;
            let next;
            try {
                next = await gql(token, itemsQuery(fragment, true), { cursor, limit: PAGE_SIZE }, tracer);
            } catch (e) {
                if (!/cursor.*expire|expired.*cursor/i.test(e.message) || reprises >= 1) throw e;
                reprises++;
                if (onLog) onLog(`${board.name} : le curseur de pagination a expiré — `
                    + 'reprise depuis le début du tableau.');
                if (onProgres) onProgres({ recus: 0, reprise: true });
                const relance = await gql(token, itemsQuery(fragment, false),
                    { ids: [String(boardId)], limit: PAGE_SIZE }, tracer);
                const nb = (relance.boards && relance.boards[0]) || null;
                if (!nb) throw e;
                items.length = 0;
                items.push(...(nb.items_page.items || []));
                recus = items.length;
                cursor = nb.items_page.cursor;
                guard = 0;
                if (onProgres) onProgres({ recus });
                continue;
            }
            const page = next.next_items_page;
            if (!page) break;
            items.push(...(page.items || []));
            recus = items.length;
            cursor = page.cursor;
            if (onLog) onLog(`${board.name} : ${items.length} éléments…`);
            if (onProgres) onProgres({ recus });
        }
        const tronque = !!cursor;
        if (tronque && onLog) {
            onLog(`⚠ ${board.name} : arrêt après ${items.length} éléments — `
                + `le tableau en contient davantage. Chargez-le seul, ou découpez-le.`);
        }

        // Le nombre annoncé par Monday est relu au moment du chargement, et
        // non repris de la liste des tableaux : celle-ci date du dernier
        // « Rafraîchir la liste », et un décompte vieux de trois semaines
        // faisait apparaître des factures « chargées en trop » ou
        // « manquantes » qui n'étaient qu'un écart de date.
        return { board: { id: board.id, name: board.name, itemsCount: board.items_count },
                 items, tronque, simplifiee };
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

    global.LioraMonday = { gql, me, listBoards, boardColumns, fetchBoardItems, columnValue, ENDPOINT, API_VERSION,
                           CONNECTEUR, TABLEAUX_CONNECTEUR, connecteurDisponible,
                           requeteConnecteur: gqlConnecteur, definirModeConnecteur, copieConnecteur };
})(window);
