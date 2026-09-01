/* ==========================================================
   Liora — Suivi Recouvrement
   ingest.js — Normalisation des données

     1. Détection automatique des colonnes (Monday ou fichier)
     2. Construction de la facture canonique
     3. Déduplication multi-tableaux + fusion des factures payées
     4. Calcul de l'échéance, du retard et de l'état
   ========================================================== */

(function (global) {
    'use strict';

    const R = global.LioraRules;
    const M = global.LioraMonday;

    // ──────────────────────────────────────────────
    //  1. Détection des colonnes
    //
    //  Chaque champ canonique porte une liste de libellés candidats.
    //  Score : correspondance exacte (100) > début de libellé (60) > inclusion (30).
    //  Un score minimal évite les rapprochements hasardeux.
    // ──────────────────────────────────────────────

    const FIELD_DEFS = [
        { field: 'numero',               label: 'Numéro de facture',      aliases: ['numero de facture', 'numero facture', 'n facture', 'no facture', 'num facture', 'reference facture', 'numero de piece', 'invoice number', 'facture'] },
        { field: 'client',               label: 'Client / Entreprise',    aliases: ['entreprise', 'client', 'societe', 'raison sociale', 'nom du client', 'compte', 'apprenant', 'stagiaire', 'beneficiaire', 'nom prenom'] },
        { field: 'montant',              label: 'Montant TTC',            aliases: ['montant ttc', 'total ttc', 'montant de la facture', 'montant facture', 'montant', 'total', 'prix ttc', 'ca ttc', 'montant total', 'montant tct', 'prix', 'cout', 'cout total', 'cout formation', 'cout de la formation', 'tarif', 'somme', 'montant a payer', 'montant du', 'valeur'] },
        { field: 'montantHT',            label: 'Montant HT',             aliases: ['montant ht', 'total ht', 'ca ht', 'prix ht'] },
        { field: 'montantRegle',         label: 'Montant réglé',          aliases: ['montant regle', 'montant paye', 'deja regle', 'encaisse', 'montant encaisse', 'total regle'] },
        { field: 'resteDu',              label: 'Reste dû',               aliases: ['reste du', 'restant du', 'solde du', 'solde restant', 'solde', 'reliquat'] },
        { field: 'dateFacture',          label: 'Date de facture',        aliases: ['date de facture', 'date facture', 'date d emission', 'date emission', 'date de la facture', 'date piece', 'date facturation', 'date de facturation', 'facturation', 'date creation facture', 'date edition'] },
        { field: 'dateEcheanceSource',   label: 'Date d’échéance',   aliases: ['date d echeance', 'date echeance', 'echeance', 'date limite de paiement', 'date limite', 'date de reglement prevue', 'date calculee', 'date negociee', 'date calcule negocie'] },
        { field: 'dateDebutFormation',   label: 'Début de formation',     aliases: ['debut de formation', 'date de debut de formation', 'date debut formation', 'debut formation', 'date de debut', 'date debut', 'debut de session', 'date debut session', 'debut parcours', 'date d entree', 'entree en formation'] },
        { field: 'dateFinFormation',     label: 'Fin de formation',       aliases: ['fin de formation', 'date de fin de formation', 'date fin formation', 'fin formation', 'date de fin', 'date fin', 'fin de session', 'date fin session', 'fin parcours', 'date de fin de parcours', 'fin de cursus', 'date de sortie', 'sortie de formation'] },
        { field: 'datePaiement',         label: 'Date de paiement',       aliases: ['date de paiement', 'date paiement', 'date de reglement', 'date reglement', 'date encaissement', 'date d encaissement'] },
        { field: 'dateControlePaiement', label: 'Date contrôle paiement', aliases: ['date controle paiement', 'date de controle paiement', 'controle paiement', 'date de controle', 'date validation paiement', 'validation paiement', 'date pointage'] },
        { field: 'financement',          label: 'Type de financement',    aliases: ['type de financement', 'financement', 'type financement', 'mode de financement', 'dispositif', 'financeur', 'type de financeur', 'source de financement'] },
        { field: 'typeClient',           label: 'Type de client',         aliases: ['type de client', 'type client', 'typologie client', 'typologie', 'segment client', 'segment', 'categorie client'] },
        { field: 'statut',               label: 'Statut',                 aliases: ['statut', 'status', 'etat', 'statut facture', 'statut de la facture'] },
        { field: 'proprietaire',         label: 'Propriétaire',           aliases: ['proprietaire', 'owner', 'responsable', 'charge de recouvrement', 'charge d affaire', 'gestionnaire', 'personne'] },
        { field: 'groupeOrigine',        label: 'Groupe d’origine',  aliases: ['groupe', 'grp', 'group', 'groupe d origine', 'tableau d origine', 'origine'] },
        { field: 'qualifRecouvrement',   label: 'Qualification recouvrement', aliases: ['qualification recouvrement', 'qualif recouvrement', 'recouvrement', 'statut recouvrement'] },
        { field: 'relance',              label: 'Relances',               aliases: ['relance', 'nb relance', 'nombre de relances', 'derniere relance', 'date de relance'] },
        { field: 'commentaire',          label: 'Commentaire',            aliases: ['commentaire', 'commentaires', 'note', 'notes', 'observation'] },
        { field: 'litige',               label: 'Litige',                 aliases: ['litige', 'contentieux', 'en litige', 'blocage'] },
    ];

    const FIELD_BY_NAME = Object.fromEntries(FIELD_DEFS.map(f => [f.field, f]));

    function scoreAlias(colTitle, alias) {
        const c = R.norm(colTitle), a = R.norm(alias);
        if (!c || !a) return 0;
        if (c === a) return 100 + a.length;
        if (c.startsWith(a + ' ') || c.endsWith(' ' + a)) return 60 + a.length;
        if (c.includes(a)) return 30 + a.length;
        return 0;
    }

    /**
     * Associe les colonnes disponibles aux champs canoniques.
     * @param {Array<{id:string,title:string,type?:string}>} columns
     * @returns {Object} mapping field -> columnId
     */
    function autoMapColumns(columns) {
        const pairs = [];
        for (const col of columns) {
            for (const def of FIELD_DEFS) {
                let best = 0;
                for (const alias of def.aliases) best = Math.max(best, scoreAlias(col.title, alias));
                // Bonus quand le type Monday concorde avec la nature du champ
                if (best > 0 && col.type) {
                    const isDateField = def.field.startsWith('date');
                    if (isDateField && (col.type === 'date' || col.type === 'timeline')) best += 25;
                    if (!isDateField && col.type === 'date') best -= 40;
                    if (def.field.startsWith('montant') && (col.type === 'numbers' || col.type === 'formula')) best += 20;
                    if (def.field === 'proprietaire' && (col.type === 'people' || col.type === 'person')) best += 20;
                }
                if (best > 0) pairs.push({ colId: col.id, field: def.field, score: best });
            }
        }
        pairs.sort((a, b) => b.score - a.score);

        const mapping = {}, usedCols = new Set();
        for (const p of pairs) {
            if (mapping[p.field] || usedCols.has(p.colId)) continue;
            if (p.score < 30) continue;
            mapping[p.field] = p.colId;
            usedCols.add(p.colId);
        }
        return mapping;
    }

    /**
     * Confronte le mapping aux valeurs réelles et retire les associations que
     * les données démentent.
     *
     * Le nom d'une colonne ne suffit pas : « Problématique Pré-échéance »
     * contient le mot échéance et se faisait prendre pour la date d'échéance,
     * alors qu'elle contient « Demande d'avoir / Doublon - A contrôler ». Une
     * colonne de dates doit contenir des dates, une colonne de montants des
     * nombres — sinon l'association est fausse, et une échéance fausse fausse
     * tout le reste.
     *
     * @param {Object} mapping            field -> colId
     * @param {Function} valeurs          colId -> tableau de valeurs brutes
     * @returns {{mapping:Object, rejets:Array<{champ,colonne,raison}>}}
     */
    function validerMapping(mapping, valeurs) {
        const propre = {}, rejets = [];
        const SEUIL = 0.5;   // la moitié des valeurs renseignées doit convenir

        for (const [champ, colId] of Object.entries(mapping)) {
            const brutes = (valeurs(colId) || [])
                .map(v => (v == null ? '' : String(v).trim()))
                .filter(Boolean)
                .slice(0, 200);

            // Sans valeur pour trancher, on garde l'association du nom
            if (!brutes.length) { propre[champ] = colId; continue; }

            let ok = true, raison = '';
            if (champ.startsWith('date')) {
                const n = brutes.filter(v => R.parseDate(v)).length;
                ok = n / brutes.length >= SEUIL;
                raison = 'ne contient pas de dates';
            } else if (champ.startsWith('montant') || champ === 'resteDu') {
                const n = brutes.filter(v => parseMontant(v) != null).length;
                ok = n / brutes.length >= SEUIL;
                raison = 'ne contient pas de nombres';
            }

            if (ok) propre[champ] = colId;
            else rejets.push({ champ, colonne: colId, raison });
        }
        return { mapping: propre, rejets };
    }

    // ──────────────────────────────────────────────
    //  2. Nettoyage des valeurs
    // ──────────────────────────────────────────────

    /** Parse un montant en tolérant « 1 234,56 € », « 1,234.56 », « (123) ». */
    function parseMontant(value) {
        if (value == null || value === '') return null;
        if (typeof value === 'number') return isFinite(value) ? value : null;

        let s = String(value).trim();
        if (!s) return null;
        const negParen = /^\(.*\)$/.test(s);
        s = s.replace(/[()]/g, '')
             .replace(/[\s  ]/g, '')
             .replace(/[€$£eur]/gi, '');

        const lastComma = s.lastIndexOf(','), lastDot = s.lastIndexOf('.');
        if (lastComma > -1 && lastDot > -1) {
            // Le séparateur le plus à droite est le séparateur décimal
            if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
            else s = s.replace(/,/g, '');
        } else if (lastComma > -1) {
            // Contexte français : la virgule isolée est le séparateur décimal
            s = s.replace(/,/g, '.');
        }
        s = s.replace(/[^0-9.\-]/g, '');
        const n = parseFloat(s);
        if (!isFinite(n)) return null;
        return negParen ? -Math.abs(n) : n;
    }

    /** Clé de rapprochement d'une facture : numéro normalisé. */
    function factureKey(numero) {
        const n = String(numero || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        return n.length >= 4 ? n : null;
    }

    /** Un statut Monday indique-t-il un paiement ? */
    const PAID_STATUS = /(^|\s)(pay[ée]e?s?|regl[ée]e?s?|encaiss[ée]e?s?|solde[ée]?|lettr[ée]e?)(\s|$)/i;
    function statutIndiquePaye(statut) {
        const s = R.norm(statut);
        if (!s) return false;
        if (/non pay|impay|pas pay|a payer|non regl/.test(s)) return false;
        return PAID_STATUS.test(' ' + s + ' ');
    }

    // ──────────────────────────────────────────────
    //  3. Construction de la facture canonique
    // ──────────────────────────────────────────────

    /**
     * Périmètre de la facture. Les tableaux opérationnels le portent dans leur
     * rôle ; le tableau des factures payées, non — il faut le déduire du groupe
     * d'origine, faute de quoi toutes ses factures se retrouveraient dans un
     * « Tous » qui ne veut rien dire dans une répartition.
     */
    function perimetreDe(ctx, v) {
        if (ctx.perimetre && ctx.perimetre !== 'Tous' && ctx.perimetre !== 'Inconnu') return ctx.perimetre;
        const devine = R.perimetreDepuisTexte(v.groupeOrigine)
            || R.perimetreDepuisTexte(ctx.groupTitle)
            || R.perimetreDepuisTexte(ctx.boardName);
        return devine || 'Non déterminé';
    }

    /**
     * @param {Object} rowValues  { field: valeurBrute }
     * @param {Object} ctx        { boardId, boardName, role, perimetre, source, financementDefaut, groupTitle, itemId, itemName }
     */
    function buildFacture(rowValues, ctx) {
        const v = rowValues;

        const numero = String(v.numero || ctx.itemName || '').trim();
        const montant = parseMontant(v.montant) ?? parseMontant(v.montantHT);
        const montantRegle = parseMontant(v.montantRegle);
        const resteDu = parseMontant(v.resteDu);

        // Type de financement, du plus fiable au plus approximatif : colonne
        // dédiée, puis type de client — « B2C - Entreprise » y désigne un
        // financement —, puis libellé du groupe, puis nom du tableau, puis
        // valeur par défaut du tableau.
        let finKey = R.detectFinancement(v.financement);
        if (!finKey) finKey = R.detectFinancement(v.typeClient);
        if (!finKey) finKey = R.detectFinancement(ctx.groupTitle);
        if (!finKey) finKey = R.detectFinancement(ctx.boardName);
        if (!finKey) finKey = ctx.financementDefaut || null;

        const qualifRecouvrement = String(v.qualifRecouvrement || '').trim();
        const datePaiement = R.parseDate(v.datePaiement);
        const dateControlePaiement = R.parseDate(v.dateControlePaiement);

        return {
            id: ctx.boardId + ':' + ctx.itemId,
            itemId: String(ctx.itemId),
            boardId: String(ctx.boardId),
            board: ctx.boardName,
            role: ctx.role,
            source: ctx.source,
            perimetre: perimetreDe(ctx, v),
            groupe: ctx.groupTitle || '',
            groupeTechnique: R.estGroupeTechnique(ctx.groupTitle),
            etape: R.etapeDepuisGroupe(ctx.groupTitle).key,
            etapeLabel: R.etapeDepuisGroupe(ctx.groupTitle).label,
            groupeOrigine: String(v.groupeOrigine || '').trim(),

            numero,
            cle: factureKey(numero),
            client: String(v.client || '').trim() || '—',
            financement: finKey,
            financementBrut: String(v.financement || v.typeClient || '').trim(),
            typeClient: String(v.typeClient || '').trim(),

            montant: montant,
            montantHT: parseMontant(v.montantHT),
            montantRegle: montantRegle,
            resteDu: resteDu,

            dateFacture: R.parseDate(v.dateFacture),
            dateDebutFormation: R.parseDate(v.dateDebutFormation),
            dateFinFormation: R.parseDate(v.dateFinFormation),
            dateEcheanceSource: R.parseDate(v.dateEcheanceSource),
            datePaiement,
            dateControlePaiement,

            // La qualification recouvrement est un champ canonique — elle sert
            // au filtrage — mais elle reste une colonne de vocabulaire métier :
            // on la verse aussi dans les qualifications pour qu'elle apparaisse
            // dans l'inventaire et dans les statistiques de répartition.
            qualifs: qualifRecouvrement
                ? { 'Qualification recouvrement': qualifRecouvrement, ...(v.__qualifs || {}) }
                : (v.__qualifs || {}),
            statut: String(v.statut || '').trim(),
            proprietaire: String(v.proprietaire || '').trim() || '—',
            qualifRecouvrement,
            relance: String(v.relance || '').trim(),
            commentaire: String(v.commentaire || '').trim(),
            litige: String(v.litige || '').trim(),
        };
    }

    /**
     * Taux de remplissage de chaque champ mappé, mesuré sur les valeurs réelles.
     *
     * Une correspondance peut être correcte au nom et vide en pratique — colonne
     * jamais renseignée dans Monday, ou mauvaise colonne parmi plusieurs
     * homonymes. Sans cette mesure, un montant absent ou une date de fin de
     * formation manquante ne se voient qu'à l'arrivée, sous la forme de zéros
     * inexplicables dans les indicateurs.
     *
     * @param {Object} mapping    champ → id de colonne
     * @param {Function} valeurs  id de colonne → tableau des valeurs
     * @param {number} nbLignes   nombre de lignes examinées
     * @returns {Object} champ → { colId, remplies, total, taux }
     */
    function couvertureMapping(mapping, valeurs, nbLignes) {
        const out = {};
        for (const def of FIELD_DEFS) {
            const colId = (mapping || {})[def.field];
            if (!colId) { out[def.field] = { colId: null, remplies: 0, total: nbLignes, taux: 0 }; continue; }
            const vals = valeurs(colId) || [];
            const remplies = vals.filter(v => String(v == null ? '' : v).trim() !== '').length;
            out[def.field] = {
                colId,
                remplies,
                total: vals.length || nbLignes,
                taux: (vals.length || nbLignes) ? (remplies / (vals.length || nbLignes)) * 100 : 0,
            };
        }
        return out;
    }

    /**
     * Colonnes de qualification d'un tableau : les listes de choix qui portent
     * le vocabulaire métier — « Problématique pré-échéance », « Qualification
     * recouvrement », « Type de paiement ». Elles varient d'un tableau à
     * l'autre et ne peuvent pas être codées en dur ; on retient donc toute
     * colonne à choix qui n'a pas déjà été affectée à un champ canonique.
     */
    function colonnesQualification(colonnes, mapping) {
        const utilisees = new Set(Object.values(mapping || {}));
        return (colonnes || []).filter(c =>
            ['status', 'color', 'dropdown'].includes(c.type) && !utilisees.has(c.id));
    }

    /** Transforme les items Monday d'un tableau en factures canoniques. */
    function facturesFromMondayBoard(board, items, mapping, boardCfg) {
        const out = [];
        const qualifCols = colonnesQualification(boardCfg.columns, mapping);

        for (const item of items) {
            const byId = {};
            for (const cv of (item.column_values || [])) byId[cv.id] = M.columnValue(cv);

            const rowValues = {};
            for (const field of Object.keys(mapping)) {
                const colId = mapping[field];
                if (colId && byId[colId] !== undefined) rowValues[field] = byId[colId];
            }

            const qualifs = {};
            for (const c of qualifCols) {
                const v = byId[c.id];
                if (v) qualifs[c.title] = v;
            }
            rowValues.__qualifs = qualifs;

            out.push(buildFacture(rowValues, {
                boardId: board.id,
                boardName: board.name,
                role: boardCfg.role,
                source: boardCfg.source,
                perimetre: boardCfg.perimetre,
                financementDefaut: boardCfg.financementDefaut,
                groupTitle: (item.group && item.group.title) || '',
                itemId: item.id,
                itemName: item.name,
            }));
        }
        return out;
    }

    /** Transforme les lignes d'un fichier (objets { entête: valeur }) en factures. */
    function facturesFromRows(rows, boardCfg, boardName) {
        if (!rows.length) return { factures: [], mapping: {}, columns: [] };
        const headers = Object.keys(rows[0]);
        const columns = headers.map(h => ({ id: h, title: h }));
        let mapping = boardCfg.mapping && Object.keys(boardCfg.mapping).length
            ? boardCfg.mapping
            : autoMapColumns(columns);

        // Le mapping déduit des noms est confronté aux valeurs du fichier
        const contr = validerMapping(mapping, col => rows.map(r => r[col]));
        mapping = contr.mapping;

        // Sans type de colonne, une colonne de fichier est tenue pour une
        // qualification si elle prend peu de valeurs distinctes sur l'ensemble
        // des lignes — signature d'une liste de choix.
        const utilisees = new Set(Object.values(mapping));
        const qualifHeaders = headers.filter(h => {
            if (utilisees.has(h)) return false;
            const vals = new Set();
            for (const r of rows) {
                const v = String(r[h] == null ? '' : r[h]).trim();
                if (v) vals.add(v);
                if (vals.size > 25) return false;
            }
            return vals.size >= 2;
        });

        const factures = rows.map((row, i) => {
            const rowValues = {};
            for (const field of Object.keys(mapping)) {
                const col = mapping[field];
                if (col && row[col] !== undefined) rowValues[field] = row[col];
            }
            const qualifs = {};
            for (const h of qualifHeaders) {
                const v = String(row[h] == null ? '' : row[h]).trim();
                if (v) qualifs[h] = v;
            }
            rowValues.__qualifs = qualifs;

            // Le groupe peut venir d'une colonne « Groupe » du fichier
            const groupTitle = rowValues.groupeOrigine || row['Groupe'] || row['Group'] || '';
            return buildFacture(rowValues, {
                boardId: 'file:' + boardName,
                boardName,
                role: boardCfg.role,
                source: boardCfg.source,
                perimetre: boardCfg.perimetre,
                financementDefaut: boardCfg.financementDefaut,
                groupTitle,
                itemId: 'L' + (i + 2),
                itemName: rowValues.numero || '',
            });
        });
        const couverture = couvertureMapping(mapping, col => rows.map(r => r[col]), rows.length);
        return { factures, mapping, columns, rejets: contr.rejets, couverture };
    }

    // ──────────────────────────────────────────────
    //  4. Consolidation
    //
    //  Le tableau « 0.1. ALL - Factures payées » centralise les factures
    //  réglées de tous les tableaux : il sert de source de vérité pour le
    //  paiement, tandis que les tableaux opérationnels fournissent les dates
    //  de formation et le contexte. Les deux sont fusionnés par numéro.
    // ──────────────────────────────────────────────

    /**
     * Priorité de rétention quand une même facture existe sur plusieurs tableaux.
     *
     * Le tableau des factures payées l'emporte : une facture réglée qui traîne
     * encore sur un tableau opérationnel est une facture réglée, et c'est sa
     * ligne de règlement qui fait référence. Sans cette priorité, une colonne
     * « reste dû » périmée côté opérationnel pouvait contredire le paiement.
     */
    const ROLE_PRIORITE = { payees: 9, recouvrement: 5, opco: 4, b2c: 4, adv: 3, tampon: 2, technique: 0, ignore: 0 };

    function mergeFacture(base, extra) {
        const out = { ...base };
        // Champs conservés depuis la source la plus riche (non vide gagne)
        const champs = ['client', 'financement', 'financementBrut', 'typeClient', 'montant', 'montantHT', 'montantRegle',
            'resteDu', 'dateFacture', 'dateDebutFormation', 'dateFinFormation', 'dateEcheanceSource',
            'datePaiement', 'dateControlePaiement', 'statut', 'proprietaire', 'qualifRecouvrement',
            'relance', 'commentaire', 'litige', 'groupeOrigine'];
        // Les qualifications de chaque source se cumulent : une facture vue sur
        // deux tableaux porte les colonnes de qualification des deux.
        out.qualifs = { ...(extra.qualifs || {}), ...(base.qualifs || {}) };
        for (const c of champs) {
            const cur = out[c], nxt = extra[c];
            const vide = cur == null || cur === '' || cur === '—';
            if (vide && nxt != null && nxt !== '' && nxt !== '—') out[c] = nxt;
        }
        return out;
    }

    /**
     * Fusionne toutes les factures collectées.
     * Retourne la liste consolidée, chaque facture portant :
     *   · paye / datePaiementEffective / originePaiement
     *   · presenceTableaux : liste des tableaux où elle apparaît
     */
    function consolider(toutes) {
        const parCle = new Map();
        const sansCle = [];

        for (const f of toutes) {
            if (!f.cle) { sansCle.push(f); continue; }
            const lst = parCle.get(f.cle);
            if (lst) lst.push(f); else parCle.set(f.cle, [f]);
        }

        const resultat = [];

        for (const [cle, groupe] of parCle) {
            // Le groupe « Factures non payées » du tableau des payées dit
            // l'inverse de son tableau : il ne vaut pas règlement.
            const payees = groupe.filter(f => f.role === 'payees' && !/non pay/.test(R.norm(f.groupe || '')));
            const operationnelles = groupe.filter(f => f.role !== 'payees');

            // Facture porteuse : la ligne de règlement si elle existe, sinon la
            // plus avancée dans le circuit opérationnel.
            const porteuse = groupe.slice().sort((a, b) =>
                (ROLE_PRIORITE[b.role] || 0) - (ROLE_PRIORITE[a.role] || 0))[0];

            let f = { ...porteuse };
            for (const autre of groupe) if (autre !== porteuse) f = mergeFacture(f, autre);

            // Le contexte métier reste celui du tableau opérationnel : la ligne
            // de règlement ne dit pas d'où venait la facture ni ses dates de
            // formation, indispensables au calcul de l'échéance.
            if (payees.length && operationnelles.length) {
                const op = operationnelles.slice().sort((a, b) =>
                    (ROLE_PRIORITE[b.role] || 0) - (ROLE_PRIORITE[a.role] || 0))[0];
                f.boardOperationnel = op.board;
                f.groupeOperationnel = op.groupe;
                // Un reste dû hérité de l'opérationnel ne peut pas survivre au
                // règlement : c'est une valeur périmée.
                f.resteDu = null;
            }

            f.cle = cle;
            f.presenceTableaux = [...new Set(groupe.map(g => g.board))];
            f.presenceRoles = [...new Set(groupe.map(g => g.role))];
            f.doublon = groupe.length > 1;

            // Le groupe d'origine du tableau « Factures payées » indique d'où
            // venait la facture au moment de son règlement.
            // Le tableau des factures payées héberge aussi un groupe
            // « Factures non payées : Perte / Contentieux ». Son intitulé
            // dit l'inverse du rôle du tableau, et c'est lui qui fait foi.
            const p = payees.find(x => !/non pay/.test(R.norm(x.groupe || '')));
            if (p) {
                f.paye = true;
                f.originePaiement = 'Tableau factures payées';
                f.groupePaiement = p.groupeOrigine || p.groupe || '';
                if (!f.groupeOrigine) f.groupeOrigine = f.groupePaiement;
            }
            resultat.push(f);
        }

        for (const f of sansCle) {
            f.presenceTableaux = [f.board];
            f.presenceRoles = [f.role];
            f.doublon = false;
            if (f.role === 'payees' && !/non pay/.test(R.norm(f.groupe || ''))) {
                f.paye = true; f.originePaiement = 'Tableau factures payées';
            }
            resultat.push(f);
        }

        return resultat;
    }

    /**
     * Applique un extrait de grand livre lettré (numéro → date de règlement).
     *
     * Le grand livre fait foi : la comptabilité est plus fiable que la saisie
     * Monday. Une date lettrée remplace donc toujours celle du tableau, et la
     * date Monday d'origine est conservée pour référence dans la fiche.
     *
     * @returns {{completees:number, remplacees:number, rapprochees:number}}
     */
    function appliquerGrandLivre(factures, gl) {
        if (!gl || !gl.length) return { completees: 0, remplacees: 0, rapprochees: 0 };
        const index = new Map();
        for (const l of gl) {
            const k = factureKey(l.numero);
            if (!k) continue;
            const d = R.parseDate(l.datePaiement);
            const prev = index.get(k);
            // On retient le lettrage le plus tardif (solde définitif)
            if (!prev || (d && prev.date && d > prev.date) || (d && !prev.date)) {
                index.set(k, { date: d, montant: parseMontant(l.montant) });
            }
        }
        let completees = 0, remplacees = 0, rapprochees = 0;
        for (const f of factures) {
            if (!f.cle) continue;
            const hit = index.get(f.cle);
            if (!hit) continue;

            rapprochees++;
            f.paye = true;
            f.grandLivre = true;

            if (hit.date) {
                if (!f.datePaiement) { f.datePaiement = hit.date; completees++; f.dateVientDuGL = true; }
                else if (+hit.date !== +f.datePaiement) {
                    f.datePaiementMonday = f.datePaiement;
                    f.datePaiement = hit.date;
                    remplacees++;
                    f.dateVientDuGL = true;
                }
            }
            if (hit.montant != null && f.montantRegle == null) f.montantRegle = hit.montant;
            f.originePaiement = 'Grand livre lettré';
        }
        return { completees, remplacees, rapprochees };
    }

    /**
     * Calcule échéance, retard et état pour chaque facture.
     * @param {Date} dateRef  date d'arrêté
     */
    function enrichir(factures, opts) {
        const o = opts || {};
        const dateRef = o.dateRef || R.stripTime(new Date());

        for (const f of factures) {
            // Recalculé à chaque passe : les factures déjà en cache bénéficient
            // ainsi de toute évolution de la liste des groupes écartés.
            f.groupeTechnique = R.estGroupeTechnique(f.groupe);
            const et = R.etapeDepuisGroupe(f.groupe);
            f.etape = et.key; f.etapeLabel = et.label;

            // Le type de financement est redéduit ici, et non seulement à
            // l'import, pour la même raison : une correction de la
            // reconnaissance — un libellé de groupe jusque-là non rattaché —
            // profite aux factures déjà en cache, sans recharger Monday. La
            // cascade reprend celle de l'import, du plus fiable au plus
            // approximatif, en repartant des valeurs brutes conservées.
            const finRededuit = R.detectFinancement(f.financementBrut, o.rules)
                || R.detectFinancement(f.typeClient, o.rules)
                || R.detectFinancement(f.groupe, o.rules)
                || R.detectFinancement(f.board, o.rules);
            if (finRededuit) f.financement = finRededuit;

            const ech = R.computeEcheance(f, { rules: o.rules, prefereEcheanceMonday: o.prefereEcheanceMonday });
            f.dateEcheance = ech.date;
            f.echeanceOrigine = ech.origine;
            f.echeanceBase = ech.baseUtilisee;
            f.regleLabel = ech.regle.label;
            f.regleNote = ech.regle.note;
            f.sansRecouvrement = !!ech.regle.sansRecouvrement;
            if (!f.financement) f.financement = ech.regle.key === 'INCONNU' ? null : ech.regle.key;

            // Une facture n'est réglée que si un document de règlement le dit :
            // sa présence dans le tableau « Factures payées », ou son lettrage
            // dans le grand livre. Une date de paiement isolée, un statut ou un
            // reste dû nul saisis sur un tableau opérationnel ne suffisent pas —
            // ces colonnes se sont révélées trop peu fiables, au point de faire
            // basculer la quasi-totalité du portefeuille en « payée ».
            let motif = null;
            if (f.paye === true) motif = 'Présente dans le tableau des factures payées';
            else if (f.grandLivre === true) motif = 'Lettrée dans le grand livre';
            // Les groupes de comptabilité — « En traitement Comptabilité »,
            // « Pennylane non pointé », « Paiement non remonté sur Sellsy » —
            // désignent des factures encaissées dont le règlement n'est pas
            // encore rapproché. Elles ne sont donc plus à recouvrer.
            else if (f.etape === 'COMPTA') motif = 'Groupe de comptabilité — règlement à rapprocher';

            const paye = motif != null;
            f.paye = paye;
            f.motifPaye = motif;

            // Signaux de règlement portés par un tableau opérationnel : ils ne
            // valent pas paiement, mais méritent d'être signalés.
            f.enAttenteRapprochement = motif === 'Groupe de comptabilité — règlement à rapprocher';
            f.signalPaiementHorsTableau = !paye && !!(
                f.datePaiement || f.dateControlePaiement || statutIndiquePaye(f.statut)
                || (f.resteDu != null && f.montant != null && f.resteDu <= 0.01 && f.montant > 0));

            if (f.datePaiement) {
                f.datePaiementEffective = f.datePaiement;
                f.paiementEstime = false;
                f.origineDatePaiement = f.dateVientDuGL ? 'Grand livre lettré' : 'Monday — date de paiement';
            } else if (f.dateControlePaiement) {
                f.datePaiementEffective = f.dateControlePaiement;
                f.paiementEstime = true;
                f.origineDatePaiement = 'Monday — date de contrôle paiement';
            } else {
                f.datePaiementEffective = null;
                f.paiementEstime = paye;
                f.origineDatePaiement = null;
            }

            // Montant restant dû. Un « reste dû » nul saisi sur un tableau
            // opérationnel contredirait le fait que la facture est comptée
            // comme due : seul le tableau des règlements peut solder une
            // facture, donc cette valeur est ignorée. Un reste dû positif,
            // lui, décrit un règlement partiel et fait foi.
            if (paye) f.encours = 0;
            else if (f.resteDu != null && f.resteDu > 0)
                f.encours = f.montant != null ? Math.min(f.resteDu, f.montant) : f.resteDu;
            else if (f.montant != null) f.encours = Math.max(0, f.montant - (f.montantRegle || 0));
            else f.encours = 0;

            // Retard
            if (!f.dateEcheance) {
                f.retardJours = null;
                f.etat = 'Échéance inconnue';
            } else if (paye) {
                const d = f.datePaiementEffective;
                f.retardJours = d ? R.diffDays(d, f.dateEcheance) : null;
                f.etat = (f.retardJours != null && f.retardJours > 0) ? 'Payée en retard' : 'Payée';
            } else {
                f.retardJours = R.diffDays(dateRef, f.dateEcheance);
                f.etat = f.retardJours > 0 ? 'En retard' : 'Non échue';
            }

            f.enRecouvrement = f.etat === 'En retard';
            f.bucket = f.retardJours == null ? null : (R.bucketFor(f.retardJours) || null);
            f.moisEcheance = R.monthKey(f.dateEcheance);
            f.moisFacture = R.monthKey(f.dateFacture);
            f.moisPaiement = R.monthKey(f.datePaiementEffective);
            f.delaiPaiement = (f.datePaiementEffective && f.dateFacture)
                ? R.diffDays(f.datePaiementEffective, f.dateFacture) : null;
        }
        return factures;
    }

    global.LioraIngest = {
        FIELD_DEFS, FIELD_BY_NAME, autoMapColumns, parseMontant, factureKey,
        buildFacture, facturesFromMondayBoard, facturesFromRows, colonnesQualification,
        validerMapping, couvertureMapping,
        consolider, appliquerGrandLivre, enrichir, statutIndiquePaye,
    };
})(window);
