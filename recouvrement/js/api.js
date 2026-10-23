/**
 * ══════════════════════════════════════════════════════════════════════
 *  SELLSY ET PENNYLANE, SANS PASSER PAR UN FICHIER
 * ══════════════════════════════════════════════════════════════════════
 *
 * Jusqu'ici, la facturation et le grand livre entraient par un export :
 * aller dans Sellsy, exporter, aller dans Pennylane, exporter, déposer les
 * trois fichiers. Ce module va les chercher directement.
 *
 * CE QU'IL NE FAIT PAS, ET POURQUOI C'EST VOULU.
 *
 * Il ne traduit pas les réponses des deux services en champs de
 * l'application. Il ne connaît pas leurs noms de champs, et il n'essaie pas
 * de les connaître : il met chaque enregistrement à plat — un objet imbriqué
 * devient des colonnes « client.nom », « amounts.total » — et remet le
 * tableau obtenu aux lecteurs qui existent déjà, ceux-là mêmes qui lisent
 * vos exports. Ces lecteurs savent reconnaître une colonne à son contenu
 * autant qu'à son nom, et l'onglet Données montre le rapprochement qu'ils
 * ont fait, pour que vous puissiez le corriger.
 *
 * C'est le choix prudent : un service qui renomme un champ ou en ajoute un
 * ne casse rien, là où une table de correspondance écrite d'avance aurait
 * rendu des colonnes vides sans le dire. Et c'est le choix honnête : ces
 * deux API ne sont pas joignables depuis l'endroit où ce code a été écrit,
 * donc rien ici ne prétend avoir été vérifié contre elles. La première
 * exécution se fera chez vous — d'où le bouton « Tester », qui ne charge
 * rien et se contente de rapporter ce que le service a répondu.
 *
 * Les adresses de base sont modifiables dans l'écran : si un service change
 * de chemin, vous n'avez pas à attendre une nouvelle version.
 */
(function (global) {
    'use strict';

    const sommeil = ms => new Promise(r => setTimeout(r, ms));
    const RETRY_MAX = 4;

    // ──────────────────────────────────────────────
    //  Mettre un enregistrement à plat
    // ──────────────────────────────────────────────
    /**
     * Un objet imbriqué devient une ligne de tableau : { client: { nom: 'X' } }
     * donne la colonne « client.nom ». Les listes d'objets sont numérotées,
     * les listes de valeurs simples sont jointes — une facture qui porte trois
     * étiquettes tient dans une colonne plutôt que dans trois.
     *
     * La profondeur est bornée : une réponse qui se référencerait elle-même
     * ferait autrement tourner la page sans fin.
     */
    function aplatir(objet, prefixe, sortie, profondeur) {
        sortie = sortie || {};
        prefixe = prefixe || '';
        profondeur = profondeur || 0;
        if (profondeur > 6 || objet == null) return sortie;

        for (const [cle, val] of Object.entries(objet)) {
            const nom = prefixe ? prefixe + '.' + cle : cle;
            if (val == null) { sortie[nom] = ''; continue; }
            if (Array.isArray(val)) {
                if (!val.length) { sortie[nom] = ''; continue; }
                const simples = val.every(v => v == null || typeof v !== 'object');
                if (simples) { sortie[nom] = val.filter(v => v != null).join(' ; '); continue; }
                val.slice(0, 12).forEach((v, i) =>
                    aplatir(v, nom + '.' + (i + 1), sortie, profondeur + 1));
                continue;
            }
            if (typeof val === 'object') { aplatir(val, nom, sortie, profondeur + 1); continue; }
            sortie[nom] = val;
        }
        return sortie;
    }

    // ──────────────────────────────────────────────
    //  Reconnaître une réponse sans la connaître
    // ──────────────────────────────────────────────
    /**
     * Les deux services n'emballent pas leurs résultats de la même façon, et
     * chacun est en train de changer de méthode de pagination. Plutôt que de
     * figer une forme, on reconnaît celles qui existent :
     *
     *   { items: [...],  next_cursor, has_more }   Pennylane, par curseur
     *   { data:  [...],  pagination: { offset } }  Sellsy, par décalage
     *   { items: [...],  total_pages, current_page }   l'ancienne pagination
     *   [ ... ]                                    une liste nue
     *
     * Ce qui n'est reconnu nulle part remonte tel quel, et le bouton
     * « Tester » l'affiche : on saura quoi ajouter plutôt que d'échouer en
     * silence.
     */
    function lot(reponse) {
        if (Array.isArray(reponse)) return { lignes: reponse, suite: null, reste: false };
        if (!reponse || typeof reponse !== 'object') return { lignes: [], suite: null, reste: false };

        const lignes = [reponse.items, reponse.data, reponse.results, reponse.records]
            .find(Array.isArray) || [];
        const p = reponse.pagination || reponse.meta || reponse.metadata || {};

        // Un curseur : la page suivante se demande avec lui.
        const curseur = reponse.next_cursor || p.next_cursor || p.offset || reponse.offset || null;
        // Un numéro de page : il reste des pages tant qu'on n'est pas au bout.
        const page = Number(p.current_page || reponse.current_page || 0);
        const pages = Number(p.total_pages || reponse.total_pages || 0);

        let reste;
        if (typeof reponse.has_more === 'boolean') reste = reponse.has_more;
        else if (typeof p.has_more === 'boolean') reste = p.has_more;
        else if (pages) reste = page > 0 && page < pages;
        else reste = !!curseur && lignes.length > 0;

        return { lignes, suite: curseur, page, pages, reste, brut: reponse };
    }

    // ──────────────────────────────────────────────
    //  Un appel, avec ce qu'il faut de patience
    // ──────────────────────────────────────────────
    async function appeler(url, options, onLog) {
        let essai = 0;
        for (;;) {
            let res;
            try {
                res = await fetch(url, options);
            } catch (e) {
                // Le navigateur ne dit pas POURQUOI un appel inter-domaines
                // échoue. Les deux causes de loin les plus fréquentes sont
                // nommées, pour éviter de chercher du côté du jeton quand le
                // problème est ailleurs.
                throw new Error(
                    'Impossible de joindre ' + hote(url) + '. '
                    + (typeof global.claude !== 'undefined'
                        ? 'Cette page publiée n’a pas le droit d’appeler ce service : '
                          + 'ouvrez l’application depuis votre poste.'
                        : 'Vérifiez votre connexion. Si elle fonctionne, c’est que le '
                          + 'service refuse l’appel depuis un navigateur (CORS) : il faudra '
                          + 'alors passer par les exports de fichiers.')
                    + ' Détail : ' + (e && e.message || e));
            }

            if (res.status === 429 || res.status === 503) {
                essai++;
                if (essai > RETRY_MAX) throw new Error('Trop de demandes (' + res.status + ') après ' + RETRY_MAX + ' tentatives.');
                const entete = Number(res.headers.get('retry-after'));
                const attente = entete > 0 ? entete * 1000 : Math.pow(2, essai) * 1000;
                if (onLog) onLog('Le service demande d’attendre — nouvelle tentative dans ' + Math.round(attente / 1000) + ' s…');
                await sommeil(attente);
                continue;
            }

            const texte = await res.text();
            let corps = null;
            try { corps = texte ? JSON.parse(texte) : null; } catch (e) { /* pas du JSON */ }

            if (!res.ok) {
                const detail = (corps && (corps.message || corps.error_description || corps.error))
                    || texte.slice(0, 300) || '(réponse vide)';
                const quoi = res.status === 401 || res.status === 403
                    ? 'Identifiants refusés (' + res.status + ') : le jeton est faux, expiré, ou il lui manque les droits de lecture.'
                    : res.status === 404
                        ? 'Adresse inconnue (404) : vérifiez l’adresse de base dans le champ au-dessus.'
                        : 'Le service a répondu ' + res.status + '.';
                throw new Error(quoi + ' ' + detail);
            }
            return { corps, texte, status: res.status };
        }
    }

    const hote = url => { try { return new URL(url).host; } catch (e) { return url; } };
    const sansSlash = u => String(u || '').replace(/\/+$/, '');

    // ──────────────────────────────────────────────
    //  Parcourir toutes les pages
    // ──────────────────────────────────────────────
    /**
     * `adresse(suite)` construit l'URL de la page à demander. On s'arrête dès
     * qu'une page ne rend rien de nouveau, et dans tous les cas au bout de
     * MAX_PAGES : une pagination qui se répéterait ferait tourner la page
     * indéfiniment, et mieux vaut un import incomplet qui le dit qu'un
     * navigateur bloqué.
     */
    const MAX_PAGES = 400;
    async function parcourir(adresse, entetes, onLog) {
        const lignes = [];
        let suite = null, pages = 0, vues = new Set();
        for (;;) {
            const url = adresse(suite);
            const { corps } = await appeler(url, { headers: entetes }, onLog);
            const l = lot(corps);
            pages++;
            for (const o of l.lignes) lignes.push(aplatir(o));
            if (onLog) onLog('page ' + pages + ' — ' + lignes.length.toLocaleString('fr-FR') + ' lignes');
            if (!l.reste || !l.lignes.length) break;
            if (pages >= MAX_PAGES) {
                if (onLog) onLog('arrêt à ' + MAX_PAGES + ' pages — l’import est incomplet.');
                break;
            }
            const prochaine = l.suite != null ? String(l.suite) : String(pages + 1);
            if (vues.has(prochaine)) {       // la pagination tourne en rond
                if (onLog) onLog('la pagination se répète — arrêt.');
                break;
            }
            vues.add(prochaine);
            suite = l.suite != null ? l.suite : pages + 1;
        }
        return { lignes, pages };
    }

    // ══════════════════════════════════════════════
    //  Pennylane — le grand livre
    // ══════════════════════════════════════════════
    //
    // Jeton porteur, pagination par curseur. L'en-tête d'adhésion est envoyé
    // parce que Pennylane fait basculer ses listes de la pagination par page
    // à la pagination par curseur : sans lui, certaines réponses gardent
    // l'ancienne forme. Les deux sont reconnues de toute façon.
    const PENNYLANE_BASE = 'https://app.pennylane.com/api/external/v2';

    const pennylane = {
        base: PENNYLANE_BASE,
        entetes(jeton) {
            return {
                'Authorization': 'Bearer ' + String(jeton || '').trim(),
                'Accept': 'application/json',
                'X-Pennylane-Cursor-Pagination': 'true',
            };
        },
        /** Un seul appel, pour voir ce que le service répond. */
        async tester(jeton, base) {
            const url = sansSlash(base || PENNYLANE_BASE) + '/ledger_entry_lines?limit=1';
            const { corps } = await appeler(url, { headers: pennylane.entetes(jeton) });
            return diagnostic(corps, url);
        },
        async charger(jeton, base, onLog) {
            const racine = sansSlash(base || PENNYLANE_BASE);
            return parcourir(
                suite => racine + '/ledger_entry_lines?limit=100'
                    + (suite ? '&cursor=' + encodeURIComponent(suite) : ''),
                pennylane.entetes(jeton), onLog);
        },
    };

    // ══════════════════════════════════════════════
    //  Sellsy — la facturation
    // ══════════════════════════════════════════════
    //
    // OAuth2 « client credentials » : l'identifiant et le secret s'échangent
    // contre un jeton de courte durée, qu'on redemande à chaque import plutôt
    // que de le conserver.
    const SELLSY_BASE = 'https://api.sellsy.com/v2';
    const SELLSY_JETONS = 'https://login.sellsy.com/oauth2/access-tokens';

    const sellsy = {
        base: SELLSY_BASE,
        jetons: SELLSY_JETONS,
        async jeton(id, secret, adresseJetons) {
            const { corps } = await appeler(adresseJetons || SELLSY_JETONS, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                body: JSON.stringify({
                    grant_type: 'client_credentials',
                    client_id: String(id || '').trim(),
                    client_secret: String(secret || '').trim(),
                }),
            });
            const jeton = corps && (corps.access_token || corps.accessToken);
            if (!jeton) throw new Error('Le service n’a pas rendu de jeton. Réponse : '
                + JSON.stringify(corps).slice(0, 200));
            return jeton;
        },
        entetes(jeton) {
            return { 'Authorization': 'Bearer ' + jeton, 'Accept': 'application/json' };
        },
        async tester(id, secret, base, adresseJetons) {
            const j = await sellsy.jeton(id, secret, adresseJetons);
            const url = sansSlash(base || SELLSY_BASE) + '/invoices?limit=1';
            const { corps } = await appeler(url, { headers: sellsy.entetes(j) });
            return diagnostic(corps, url);
        },
        async charger(id, secret, base, onLog, adresseJetons) {
            if (onLog) onLog('échange des identifiants contre un jeton…');
            const j = await sellsy.jeton(id, secret, adresseJetons);
            const racine = sansSlash(base || SELLSY_BASE);
            return parcourir(
                suite => racine + '/invoices?limit=100'
                    + (suite ? '&offset=' + encodeURIComponent(suite) : ''),
                sellsy.entetes(j), onLog);
        },
    };

    // ──────────────────────────────────────────────
    //  Ce que le service a répondu, en clair
    // ──────────────────────────────────────────────
    /**
     * Le bouton « Tester » ne charge rien : il demande UN enregistrement et
     * rend de quoi comprendre. Les colonnes trouvées sont le vrai résultat :
     * ce sont elles que les lecteurs de l'application vont devoir
     * reconnaître, et c'est sur cette liste qu'on ajustera si besoin.
     */
    function diagnostic(corps, url) {
        const l = lot(corps);
        const premiere = l.lignes.length ? aplatir(l.lignes[0]) : {};
        return {
            url,
            enveloppe: corps && typeof corps === 'object' && !Array.isArray(corps)
                ? Object.keys(corps) : ['(une liste)'],
            reconnu: l.lignes.length > 0,
            nb: l.lignes.length,
            pagination: l.suite != null ? 'par curseur / décalage'
                : l.pages ? 'par page (' + l.pages + ' pages)' : 'inconnue',
            colonnes: Object.keys(premiere),
            exemple: premiere,
        };
    }

    global.LioraAPI = {
        aplatir, lot, appeler, parcourir, diagnostic,
        pennylane, sellsy,
        PENNYLANE_BASE, SELLSY_BASE, SELLSY_JETONS,
    };
})(window);
