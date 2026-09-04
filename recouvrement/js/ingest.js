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
        // « Élément », « Name », « Nom » : les noms que Monday donne à sa colonne
        // d'items selon la langue de l'export. C'est elle qui porte le numéro de
        // facture. Le contrôle de valeurs fait le tri — une colonne de ce nom
        // qui ne contient pas de numéros exploitables est écartée.
        { field: 'numero',               label: 'Numéro de facture',      aliases: ['numero de facture', 'numero facture', 'n facture', 'no facture', 'num facture', 'reference facture', 'numero de piece', 'invoice number', 'facture', 'element', 'elements', 'name', 'nom'] },
        { field: 'client',               label: 'Client / Entreprise',    aliases: ['entreprise', 'client', 'societe', 'raison sociale', 'nom du client', 'compte', 'apprenant', 'stagiaire', 'beneficiaire', 'nom prenom'] },
        // « Montant dû » n'est pas le montant de la facture mais ce qu'il en
        // reste à payer : sur une facture réglée il vaut zéro. Le prendre pour
        // le montant mettait à zéro des tableaux entiers — tout le financement
        // personnel. Il appartient au reste dû, d'où le montant est déduit
        // quand aucune autre colonne ne le porte.
        { field: 'montant',              label: 'Montant TTC',            aliases: ['montant ttc', 'total ttc', 'total facture', 'total de la facture', 'montant de la facture', 'montant facture', 'montant', 'total', 'prix ttc', 'ca ttc', 'montant total', 'montant tct', 'prix', 'cout', 'cout total', 'cout formation', 'cout de la formation', 'tarif', 'somme', 'valeur'] },
        { field: 'montantHT',            label: 'Montant HT',             aliases: ['montant ht', 'total ht', 'ca ht', 'prix ht'] },
        { field: 'montantRegle',         label: 'Montant réglé',          aliases: ['montant regle', 'montant paye', 'deja regle', 'encaisse', 'montant encaisse', 'total regle'] },
        { field: 'resteDu',              label: 'Reste dû',               aliases: ['montant du ttc', 'montant du ht', 'montant du', 'reste du', 'restant du', 'reste a payer', 'reste a regler', 'montant a payer', 'solde du', 'solde restant', 'solde', 'reliquat'] },
        { field: 'dateFacture',          label: 'Date de facture',        aliases: ['date de facture', 'date facture', 'date d emission', 'date emission', 'date de la facture', 'date piece', 'date facturation', 'date de facturation', 'facturation', 'date creation facture', 'date edition'] },
        { field: 'dateEcheanceSource',   label: 'Date d’échéance',   aliases: ['date d echeance', 'date echeance', 'echeance', 'date limite de paiement', 'date limite', 'date de reglement prevue', 'date calculee', 'date negociee', 'date calcule negocie'] },
        // « Début de service » et « Fin de service » sont le vocabulaire de Liora :
        // les tableaux Monday et l'export Sellsy nomment ainsi les dates de
        // formation. Sans ces libellés, les règles d'échéance qui comptent sur
        // la fin de formation ne trouvaient rien et des milliers de factures
        // sortaient en « échéance impossible à calculer ».
        { field: 'dateDebutFormation',   label: 'Début de formation',     aliases: ['debut de formation', 'date de debut de formation', 'date debut formation', 'debut formation', 'debut de service', 'date de debut de service', 'date debut service', 'debut service', 'date de debut', 'date debut', 'debut de session', 'date debut session', 'debut parcours', 'date d entree', 'entree en formation'] },
        { field: 'dateFinFormation',     label: 'Fin de formation',       aliases: ['fin de formation', 'date de fin de formation', 'date fin formation', 'fin formation', 'fin de service', 'date de fin de service', 'date fin service', 'fin service', 'date de fin', 'date fin', 'fin de session', 'date fin session', 'fin parcours', 'date de fin de parcours', 'fin de cursus', 'date de sortie', 'sortie de formation'] },
        { field: 'datePaiement',         label: 'Date de paiement',       aliases: ['date de paiement', 'date paiement', 'date de reglement', 'date reglement', 'date encaissement', 'date d encaissement'] },
        { field: 'dateControlePaiement', label: 'Date contrôle paiement', aliases: ['date controle paiement', 'date de controle paiement', 'controle paiement', 'date de controle', 'date validation paiement', 'validation paiement', 'date pointage'] },
        { field: 'financement',          label: 'Type de financement',    aliases: ['type de financement', 'financement', 'type financement', 'mode de financement', 'dispositif', 'financeur', 'type de financeur', 'source de financement'] },
        { field: 'typeClient',           label: 'Type de client',         aliases: ['type de client', 'type client', 'typologie client', 'typologie', 'segment client', 'segment', 'categorie client'] },
        { field: 'statut',               label: 'Statut',                 aliases: ['statut', 'status', 'etat', 'statut facture', 'statut de la facture'] },
        { field: 'proprietaire',         label: 'Propriétaire',           aliases: ['proprietaire', 'owner', 'responsable', 'charge de recouvrement', 'charge d affaire', 'gestionnaire', 'personne'] },
        { field: 'groupeOrigine',        label: 'Groupe d’origine',  aliases: ['groupe', 'grp', 'group', 'groupe d origine', 'tableau d origine', 'origine'] },
        // « Qualification recouvrement avec basculement » est la colonne que
        // l'équipe renseigne à la main sur le tableau 1.2 : c'est elle qui dit
        // où en est le dossier — en cours de traitement, permission de payer en
        // plusieurs fois, à déposer sur plateforme, pas de contact adéquat. Le
        // groupe Monday, lui, ne dit que l'étape du circuit. Champ distinct
        // pour que l'un ne se substitue pas à l'autre.
        { field: 'qualifBascule',        label: 'Qualification recouvrement (avec basculement)', aliases: ['qualification recouvrement avec basculement', 'qualif recouvrement avec basculement', 'qualification avec basculement', 'qualification recouv basculement'] },
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
     * Une colonne convient-elle au champ auquel son nom la destine ?
     *
     * Le contrôle porte sur les valeurs réellement présentes, les cases vides
     * étant écartées du calcul : une colonne de dates peu renseignée reste une
     * colonne de dates, et ne doit pas être rejetée pour sa rareté.
     */
    function verifierValeurs(champ, valeurs, opts) {
        const brutes = (valeurs || [])
            .map(v => (v == null ? '' : String(v).trim()))
            .filter(Boolean)
            .slice(0, 200);
        // Rien pour trancher. C'est valide pour un mapping choisi à la main —
        // une colonne encore vide reste une colonne légitime — mais pas pour un
        // arbitrage automatique : « Date de fin de formation », jamais
        // renseignée, gagnait au nom contre « Fin de service », renseignée à
        // 100 %, et la date utile était perdue.
        if (!brutes.length) {
            return (opts && opts.exigerDesValeurs)
                ? { ok: false, raison: 'colonne entièrement vide' }
                : { ok: true };
        }

        const SEUIL = 0.5;
        if (champ.startsWith('date')) {
            const n = brutes.filter(v => R.parseDate(v)).length;
            return n / brutes.length >= SEUIL
                ? { ok: true } : { ok: false, raison: 'ne contient pas de dates' };
        }
        if (champ.startsWith('montant') || champ === 'resteDu') {
            const n = brutes.filter(v => parseMontant(v) != null).length;
            return n / brutes.length >= SEUIL
                ? { ok: true } : { ok: false, raison: 'ne contient pas de nombres' };
        }
        // Un numéro de facture n'est ni un lien, ni une adresse, ni une date.
        // Une colonne de liens Monday emportait le champ et remplaçait le
        // numéro par une URL, rendant le rapprochement entre tableaux
        // arbitraire — deux factures partageant un lien devenaient une seule.
        if (champ === 'numero') {
            const liens = brutes.filter(v => /:\/\/|^www\.|@/.test(v)).length;
            if (liens / brutes.length >= SEUIL) return { ok: false, raison: 'contient des liens, pas des numéros' };
            // Pas de contrôle « ce ne sont pas des dates » ici : un numéro de
            // facture est fait de groupes de chiffres, et certains se lisent
            // comme une date. Le test rejetterait de vraies colonnes.
            const utilisables = brutes.filter(v => factureKey(v)).length;
            if (utilisables / brutes.length < SEUIL) return { ok: false, raison: 'ne contient pas de numéros exploitables' };
        }
        return { ok: true };
    }

    /**
     * Associe les colonnes disponibles aux champs canoniques.
     *
     * @param {Array<{id:string,title:string,type?:string}>} columns
     * @param {Function} [valeurs]  id de colonne → valeurs observées. Fourni,
     *   chaque candidat est confronté aux données avant d'être retenu, et un
     *   candidat écarté laisse la place au suivant sur ce champ — sans cela un
     *   nom trompeur emportait le champ, puis se faisait rejeter, et le champ
     *   restait vide alors qu'une autre colonne convenait.
     * @returns {Object|{mapping:Object,rejets:Array}} le mapping seul, ou le
     *   mapping et les rejets quand des valeurs ont été fournies.
     */
    function autoMapColumns(columns, valeurs) {
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

        const mapping = {}, usedCols = new Set(), rejets = [], suppleants = {};
        for (const p of pairs) {
            // Colonne déjà retenue pour ce champ : on la garde en réserve. Le
            // tableau des factures payées porte le numéro tantôt dans
            // « Numero de facture », tantôt dans « Name » : la colonne gagnante
            // est vide sur 1 400 lignes, et le numéro était perdu alors qu'il
            // se trouvait juste à côté.
            if (mapping[p.field] && p.score >= 30 && !usedCols.has(p.colId)) {
                (suppleants[p.field] = suppleants[p.field] || []).push(p.colId);
            }
            if (mapping[p.field] || usedCols.has(p.colId)) continue;
            if (p.score < 30) continue;
            if (valeurs) {
                const v = verifierValeurs(p.field, valeurs(p.colId), { exigerDesValeurs: true });
                if (!v.ok) {
                    // La colonne reste disponible pour un autre champ, et pour
                    // les qualifications : seule cette association est écartée.
                    rejets.push({ champ: p.field, colonne: p.colId, raison: v.raison });
                    continue;
                }
            }
            mapping[p.field] = p.colId;
            usedCols.add(p.colId);
        }
        // Une colonne suppléante ne doit pas être un champ à part entière.
        for (const champ of Object.keys(suppleants)) {
            suppleants[champ] = suppleants[champ].filter(c => !usedCols.has(c));
            if (!suppleants[champ].length) delete suppleants[champ];
        }
        return valeurs ? { mapping, rejets, suppleants } : mapping;
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
        for (const [champ, colId] of Object.entries(mapping)) {
            const v = verifierValeurs(champ, valeurs(colId));
            if (v.ok) propre[champ] = colId;
            else rejets.push({ champ, colonne: colId, raison: v.raison });
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

    /**
     * La valeur a-t-elle la forme d'un numéro de facture Liora ?
     *
     * Plus strict que factureKey, qui accepte quatre caractères quelconques :
     * ce test sert à repêcher un numéro dans une colonne voisine, et un nom de
     * client pris pour un numéro ferait plus de dégâts qu'un numéro manquant.
     */
    const FORME_NUMERO = /^(fact|fcat|fct|avr|avo|fa)[-_ ]/i;
    function ressembleANumero(v) {
        const t = String(v == null ? '' : v).trim();
        return FORME_NUMERO.test(t) && (t.match(/\d/g) || []).length >= 3;
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
        const qualifBascule = String(v.qualifBascule || '').trim();
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
            qualifBascule,
            qualifs: qualifRecouvrement || qualifBascule
                ? { ...(qualifRecouvrement ? { 'Qualification recouvrement': qualifRecouvrement } : {}),
                    ...(qualifBascule ? { 'Qualification recouvrement avec basculement': qualifBascule } : {}),
                    ...(v.__qualifs || {}) }
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
     * Colonnes qui pourraient convenir à un champ, d'après leurs valeurs.
     *
     * Élargir la liste des noms reconnus ne fait que déplacer la limite : il
     * restera toujours une colonne nommée autrement. Plutôt que de deviner, on
     * regarde ce que les colonnes contiennent — des nombres pour un montant,
     * des dates pour une date — et on propose celles qui conviendraient, à
     * charge pour l'utilisatrice de désigner la bonne.
     *
     * @param {Array} colonnes    [{id, title, type}]
     * @param {Object} mapping    associations déjà retenues
     * @param {Function} valeurs  id de colonne → valeurs observées
     * @param {string} champ      champ à pourvoir
     * @returns {Array} [{id, title, remplies, taux, exemple}] les mieux remplies d'abord
     */
    function colonnesCandidates(colonnes, mapping, valeurs, champ) {
        // Seuls les champs dont les valeurs se reconnaissent — dates, montants,
        // numéros — peuvent être proposés. Pour un type de financement, toute
        // colonne de texte conviendrait : proposer les unes plutôt que les
        // autres serait du bruit, pas une aide.
        const verifiable = champ.startsWith('date') || champ.startsWith('montant')
            || champ === 'resteDu' || champ === 'numero';
        if (!verifiable) return [];

        const prises = new Set(Object.values(mapping || {}));
        const out = [];
        for (const c of (colonnes || [])) {
            if (prises.has(c.id)) continue;
            const brutes = (valeurs(c.id) || [])
                .map(v => (v == null ? '' : String(v).trim())).filter(Boolean);
            if (!brutes.length) continue;
            if (!verifierValeurs(champ, brutes).ok) continue;
            // Le champ doit vraiment être servi : une colonne à peine remplie
            // ne réglera pas un montant absent.
            const total = (valeurs(c.id) || []).length || brutes.length;
            const taux = (brutes.length / total) * 100;
            if (taux < 20) continue;
            out.push({ id: c.id, title: c.title, remplies: brutes.length, taux, exemple: brutes[0] });
        }
        return out.sort((a, b) => b.taux - a.taux).slice(0, 6);
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
        // Les champs techniques ajoutés à l'aplatissement ne sont pas des
        // colonnes du tableau : ni à mapper, ni à qualifier.
        const headers = Object.keys(rows[0]).filter(h => !h.startsWith('__'));
        const columns = headers.map(h => ({ id: h, title: h }));
        // Noms de colonnes et valeurs sont confrontés ensemble : un candidat
        // démenti par les données laisse la place au suivant sur ce champ.
        const valeursDe = col => rows.map(r => r[col]);
        let mapping, rejets, suppleants = {};
        if (boardCfg.mapping && Object.keys(boardCfg.mapping).length) {
            const contr = validerMapping(boardCfg.mapping, valeursDe);
            mapping = contr.mapping; rejets = contr.rejets;
            // Un mapping choisi à la main ne dit rien des colonnes voisines :
            // on redemande les suppléantes au mappage automatique.
            const auto = autoMapColumns(columns, valeursDe);
            suppleants = auto.suppleants || {};
        } else {
            const auto = autoMapColumns(columns, valeursDe);
            mapping = auto.mapping; rejets = auto.rejets;
            suppleants = auto.suppleants || {};
        }
        // Les colonnes où retrouver un numéro que la colonne principale laisse
        // vide, dans l'ordre où le mappage les a jugées crédibles.
        const numeroSuppleant = (suppleants.numero || []).filter(c => c !== mapping.numero);
        const contr = { rejets };

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

        let repeches = 0;
        const factures = rows.map((row, i) => {
            const rowValues = {};
            for (const field of Object.keys(mapping)) {
                const col = mapping[field];
                if (col && row[col] !== undefined) rowValues[field] = row[col];
            }
            // Numéro absent de sa colonne : on regarde les colonnes voisines
            // que le mappage tenait pour des numéros. Une facture sans numéro
            // ne se rapproche de rien — ni du grand livre, ni de Sellsy, ni de
            // son tableau d'origine — c'est la donnée à ne pas perdre.
            if (!String(rowValues.numero == null ? '' : rowValues.numero).trim()) {
                for (const col of numeroSuppleant) {
                    const v = String(row[col] == null ? '' : row[col]).trim();
                    if (ressembleANumero(v)) { rowValues.numero = v; repeches++; break; }
                }
            }
            const qualifs = {};
            for (const h of qualifHeaders) {
                const v = String(row[h] == null ? '' : row[h]).trim();
                if (v) qualifs[h] = v;
            }
            // « Groupe » sert de repli au groupe d'origine — c'est ce qu'elle
            // contient sur le tableau des factures payées. Mais sur les
            // tableaux B2C, c'est une liste de choix à part entière :
            // « Recouvrement », « Facture a annuler / Modifier », « Gocard
            // validé ». Elle est donc aussi versée aux qualifications, sauf
            // quand elle porte un titre de groupe Monday (« 2.1.3. … »).
            const grp = String(row['__groupeQualif'] != null ? row['__groupeQualif'] : row['Groupe'] || '').trim();
            if (grp && !qualifs['Groupe']) qualifs['Groupe'] = grp;
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
        return { factures, mapping, columns, rejets: contr.rejets, couverture, repeches };
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
            'datePaiement', 'dateControlePaiement', 'statut', 'proprietaire', 'qualifRecouvrement', 'qualifBascule',
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

            // Deux familles de doublons, qui ne se corrigent pas pareil.
            //
            // Une facture vue sur son tableau opérationnel et sur le tableau des
            // factures payées, ou dans un groupe d'archive, est attendue : c'est
            // le fonctionnement même du circuit. Une facture présente sur deux
            // tableaux opérationnels à la fois ne l'est pas — dans un circuit
            // Tampon → ADV → Recouvrement, elle se déplace, elle ne se duplique
            // pas. Les mélanger dans un chiffre unique masquait les secondes,
            // les seules à corriger dans Monday.
            const estOperationnelle = g =>
                g.role !== 'payees' && g.role !== 'technique' && g.role !== 'ignore'
                && !R.estGroupeTechnique(g.groupe);
            const lignesOp = groupe.filter(estOperationnelle);
            const lignesPayees = groupe.filter(g => g.role === 'payees');

            f.nbLignes = groupe.length;
            f.nbLignesOperationnelles = lignesOp.length;
            f.boardsOperationnels = [...new Set(lignesOp.map(g => g.board))];
            f.doublonOperationnel = lignesOp.length > 1;

            // Une facture réglée n'a qu'un règlement : deux lignes dans le
            // tableau des factures payées — deux groupes, ou deux fois le même —
            // sont un doublon de saisie, pas un fonctionnement du circuit.
            f.nbLignesPayees = lignesPayees.length;
            f.groupesPayees = [...new Set(lignesPayees.map(g => g.groupe || '(sans groupe)'))];
            f.doublonPayees = lignesPayees.length > 1;

            // Lignes retirées du total, réparties entre les trois familles.
            // Les excédents se comptent famille par famille ; ce qui reste est
            // le rapprochement attendu entre un tableau opérationnel et le
            // tableau des règlements.
            f.doublonsRetiresOp = Math.max(0, lignesOp.length - 1);
            f.doublonsRetiresPayees = Math.max(0, lignesPayees.length - 1);
            f.doublonsRetiresAttendus =
                (groupe.length - 1) - f.doublonsRetiresOp - f.doublonsRetiresPayees;

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
     * Reporte sur les factures ce que dit le grand livre.
     *
     * La comptabilité est plus fiable que la saisie Monday : une date lettrée
     * remplace donc celle du tableau, et la date Monday d'origine est conservée
     * pour référence dans la fiche.
     *
     * Mais le grand livre ne dit pas seulement « réglée ». Il distingue trois
     * sorts, et les confondre fausse le recouvrement dans les deux sens :
     * — soldée par un règlement : l'argent est rentré ;
     * — soldée par un avoir : la créance a été annulée, rien n'est rentré, et
     *   il n'y a plus rien à relancer — la compter comme encaissée gonflerait
     *   le taux de récupération d'un argent qui n'existe pas ;
     * — présente mais non soldée : elle reste à recouvrer. La marquer payée
     *   parce qu'elle figure dans le fichier était l'erreur de la lecture
     *   ligne à ligne.
     *
     * @returns {{completees:number, remplacees:number, rapprochees:number,
     *            soldees:number, avoirs:number, ouvertes:number}}
     */
    function appliquerGrandLivre(factures, gl) {
        const vide = { completees: 0, remplacees: 0, rapprochees: 0, soldees: 0, avoirs: 0, ouvertes: 0 };
        if (!gl || !gl.length) return vide;

        // Le grand livre est conservé sérialisé entre deux sessions : ses dates
        // reviennent en texte. Les reconvertir ici, à l'entrée, évite qu'une
        // chaîne se retrouve là où le calcul attend une date — l'échéance
        // plantait alors sur toute la passe, et l'erreur ne disait rien.
        const asDate = v => (v instanceof Date ? v : R.parseDate(v));

        const index = new Map();
        for (const l of gl) {
            const k = l.cle || factureKey(l.numero);
            if (!k) continue;
            const d = asDate(l.datePaiement);
            const prev = index.get(k);
            // Une facture peut apparaître dans plusieurs lettrages (règlement
            // en plusieurs fois) : on retient le lettrage qui la solde, et à
            // défaut le plus tardif.
            const candidat = { ...l, date: d,
                dateFacture: asDate(l.dateFacture), dateEcheance: asDate(l.dateEcheance),
                dateAvoir: asDate(l.dateAvoir) };
            if (!prev
                || (candidat.soldee && !prev.soldee)
                || (candidat.soldee === prev.soldee && d && prev.date && d > prev.date)
                || (candidat.soldee === prev.soldee && d && !prev.date)) {
                index.set(k, candidat);
            }
        }

        const st = { ...vide };
        for (const f of factures) {
            if (!f.cle) continue;
            const hit = index.get(f.cle);
            if (!hit) continue;

            st.rapprochees++;
            f.grandLivre = true;
            f.grandLivreLettre = hit.lettre || null;

            // Le grand livre porte le montant comptabilisé de la facture et la
            // date de la pièce : ils valent mieux qu'un tableau muet, que la
            // créance soit soldée ou encore ouverte.
            if ((f.montant == null || f.montant === 0) && hit.montant) {
                f.montant = hit.montant;
                f.montantVientDuGL = true;
            }
            if (!f.dateFacture && hit.dateFacture) { f.dateFacture = hit.dateFacture; f.dateFactureVientDuGL = true; }

            if (!hit.soldee) {
                // Le grand livre la connaît et ne la solde pas : c'est une
                // créance ouverte, quoi qu'en dise le tableau Monday.
                // Signalé, non appliqué : l'extrait ne couvre qu'un exercice,
                // et une facture soldée avant sa première date y apparaît en
                // à-nouveau. Contredire Monday sur cette base ferait plus de
                // dégâts que de bien — Data Quality met les deux face à face.
                st.ouvertes++;
                f.grandLivreOuverte = true;
                if (hit.resteGroupe > 0 && hit.nbFacturesGroupe === 1) f.resteGrandLivre = hit.resteGroupe;
                continue;
            }

            st.soldees++;
            if (hit.parAvoir) {
                // Annulée par avoir : plus rien à relancer, mais rien n'est
                // rentré non plus. Elle sort du portefeuille sans compter dans
                // ce que le recouvrement a récupéré.
                st.avoirs++;
                f.soldeeParAvoir = true;
                f.avoirsGrandLivre = hit.avoirs || [];
                f.dateAvoir = hit.dateAvoir || null;
                f.originePaiement = 'Avoir (grand livre)';
                continue;
            }

            // Soldée par un règlement : c'est ce drapeau-ci, et lui seul, qui
            // vaut encaissement. « Reconnue au grand livre » ne veut pas dire
            // « réglée » — un extrait non lettré ne contient que des créances
            // vivantes, et les confondre viderait le portefeuille d'un coup.
            f.grandLivreSoldee = true;
            f.paye = true;
            if (hit.date) {
                if (!f.datePaiement) { f.datePaiement = hit.date; st.completees++; f.dateVientDuGL = true; }
                else if (+hit.date !== +f.datePaiement) {
                    f.datePaiementMonday = f.datePaiement;
                    f.datePaiement = hit.date;
                    st.remplacees++;
                    f.dateVientDuGL = true;
                }
            }
            if (hit.montantRegle != null && f.montantRegle == null) f.montantRegle = hit.montantRegle;
            if (hit.montantAvoir != null) f.montantAvoir = hit.montantAvoir;
            f.originePaiement = 'Grand livre lettré';
        }
        return st;
    }

    /**
     * Un export Monday est-il groupé, et si oui, à plat.
     *
     * Monday n'exporte pas un tableau rectangulaire : il écrit le nom du
     * tableau, puis pour chaque groupe son titre, sa propre ligne d'en-tête et
     * ses lignes — et recommence au groupe suivant. Lu comme un fichier plat,
     * la première ligne devient l'en-tête et tout le reste est illisible :
     * l'export de « 1.1. Entreprise - ADV » donnait une seule colonne nommée
     * « 1.1. Entreprise - ADV » et zéro facture exploitable.
     *
     * La mise à plat suit la structure : ligne à une seule cellule = titre de
     * groupe, ligne commençant par « Name » = nouvel en-tête, le reste = des
     * lignes, rattachées au groupe courant.
     *
     * @param {Array<Array>} matrice  le fichier en tableau de tableaux
     * @returns {{lignes:Array<Object>, groupes:number, tableau:string}|null}
     *   null si le fichier n'a pas cette forme — il est alors lu normalement.
     */
    function aplatirExportMonday(matrice) {
        if (!Array.isArray(matrice) || matrice.length < 3) return null;

        const remplies = r => (r || []).filter(c => String(c == null ? '' : c).trim()).length;
        const estEnTete = r => {
            const p = R.norm(r && r[0]);
            return p === 'name' || p === 'nom' || p === 'element' || p === 'elements';
        };

        // Signature : un en-tête « Name » ailleurs qu'en première ligne, précédé
        // d'au moins un titre seul. Sans cela, c'est un fichier plat ordinaire.
        let premierEnTete = -1;
        for (let i = 0; i < Math.min(matrice.length, 40); i++) {
            if (estEnTete(matrice[i])) { premierEnTete = i; break; }
        }
        if (premierEnTete < 1) return null;
        if (!matrice.slice(0, premierEnTete).some(r => remplies(r) === 1)) return null;

        const tableau = String((matrice[0] || [])[0] || '').trim();
        let entete = null, groupe = '', groupes = 0, totaux = 0;
        const lignes = [];

        for (let i = 0; i < matrice.length; i++) {
            const r = matrice[i];
            if (!remplies(r)) continue;
            if (estEnTete(r)) { entete = r.map(c => String(c == null ? '' : c).trim()); continue; }
            // Un titre porte son texte dans la première colonne. Une ligne de
            // total de groupe n'a parfois qu'une cellule remplie elle aussi —
            // la somme — mais ailleurs : la prendre pour un titre effaçait le
            // nom du groupe courant, et les factures suivantes le perdaient.
            if (remplies(r) === 1 && String(r[0] == null ? '' : r[0]).trim()) {
                // Le titre du tableau lui-même n'est pas un groupe.
                if (i > 0 || String(r[0]).trim() !== tableau) { groupe = String(r[0]).trim(); groupes++; }
                continue;
            }
            if (!entete) continue;

            // Monday ferme chaque groupe par une ligne de totaux : la colonne
            // d'identité y est vide, mais les colonnes de montant portent la
            // somme du groupe. Elle entrait comme une facture de 7,1 M€. Sur un
            // tableau Monday, tout élément a un nom : une ligne sans nom n'est
            // pas un élément.
            if (!String(r[0] == null ? '' : r[0]).trim()) { totaux++; continue; }

            const o = {};
            for (let c = 0; c < entete.length; c++) {
                const nom = entete[c] || ('Colonne ' + (c + 1));
                if (!(nom in o)) o[nom] = r[c] == null ? '' : r[c];
            }
            // Le groupe est une colonne à part entière : c'est lui qui porte
            // l'étape du circuit. Quand le fichier a bien une colonne
            // « Groupe » mais qu'elle est vide sur la ligne, c'est le titre du
            // groupe qui fait foi — sans quoi l'étape du circuit se perd.
            // La colonne « Groupe » de Monday n'est pas toujours le groupe :
            // sur les tableaux B2C c'est une liste de choix — « Recouvrement »,
            // « Facture a annuler / Modifier ». Sa valeur propre est conservée
            // à part, pour ne pas la confondre avec le titre du groupe qui la
            // remplace quand elle est vide.
            o.__groupeQualif = String(o.Groupe == null ? '' : o.Groupe).trim();
            if (!o.__groupeQualif) o.Groupe = groupe;
            lignes.push(o);
        }

        return lignes.length ? { lignes, groupes, tableau, totaux } : null;
    }

    /**
     * Complète les factures Monday avec l'export Sellsy.
     *
     * Sellsy est le logiciel de facturation : il porte le montant, la date de
     * facture et la date d'échéance de chaque facture émise. Monday, lui, est
     * saisi à la main et laisse des trous — le tableau des factures payées ne
     * reprend qu'un numéro et un règlement, et le tableau du financement
     * personnel porte des montants à zéro parce que le prix est ailleurs.
     *
     * Ce complément suit la même règle que le grand livre : il ne remplace
     * jamais une valeur présente, il ne remplit que les vides. Et il ne touche
     * pas au calcul de l'échéance — les règles de financement font foi. La date
     * d'échéance Sellsy est seulement mise de côté, pour servir de dernier
     * recours aux factures dont aucune règle ne peut calculer l'échéance.
     *
     * @param {Array} factures  factures consolidées
     * @param {Array} lignes    lignes issues de LioraSellsy.lireExport()
     * @returns {{rapprochees:number, montants:number, datesFacture:number,
     *            echeancesDisponibles:number}}
     */
    function appliquerSellsy(factures, lignes) {
        const vide = { rapprochees: 0, montants: 0, datesFacture: 0, datesService: 0, echeancesDisponibles: 0 };
        if (!lignes || !lignes.length) return vide;

        const index = new Map();
        for (const l of lignes) if (l.cle && !index.has(l.cle)) index.set(l.cle, l);

        const st = { ...vide };
        for (const f of factures) {
            if (!f.cle) continue;
            const l = index.get(f.cle);
            if (!l) continue;
            st.rapprochees++;
            f.sellsy = true;
            f.statutSellsy = l.statutLabel;

            // Un montant à zéro n'est pas un montant : sur le tableau du
            // financement personnel, toutes les factures en portaient un, et
            // tous les indicateurs en euros de la catégorie valaient zéro.
            if ((f.montant == null || f.montant === 0) && l.montant && !l.montantAberrant) {
                f.montant = l.montant;
                f.montantVientDeSellsy = true;
                st.montants++;
            }
            if (!f.dateFacture && l.dateFacture) {
                f.dateFacture = l.dateFacture;
                f.dateFactureVientDeSellsy = true;
                st.datesFacture++;
            }
            // Les dates de service sont les dates de formation : ce sont elles
            // que les règles d'échéance attendent. Les reprendre laisse la règle
            // calculer normalement, plutôt que de recopier l'échéance Sellsy.
            if (!f.dateDebutFormation && l.dateDebutService) {
                f.dateDebutFormation = l.dateDebutService;
                f.datesServiceViennentDeSellsy = true;
                st.datesService++;
            }
            if (!f.dateFinFormation && l.dateFinService) {
                f.dateFinFormation = l.dateFinService;
                f.datesServiceViennentDeSellsy = true;
                st.datesService++;
            }
            if (l.dateEcheance) { f.echeanceSellsy = l.dateEcheance; st.echeancesDisponibles++; }
        }
        return st;
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
            // La source retenue est conservée : « Type de financement »,
            // « Type de client », le groupe ou le tableau. Sans elle, un
            // financement surprenant ne se vérifie pas.
            const sources = [
                ['Colonne « Type de financement »', f.financementBrut],
                ['Colonne « Type de client »', f.typeClient],
                ['Groupe Monday', f.groupe],
                ['Tableau Monday', f.board],
            ];
            let finRededuit = null;
            for (const [nom, valeur] of sources) {
                const fin = R.detectFinancement(valeur, o.rules);
                if (!fin) continue;
                finRededuit = fin;
                f.origineFinancement = nom + (valeur ? ' : ' + String(valeur).slice(0, 60) : '');
                break;
            }
            if (finRededuit) f.financement = finRededuit;

            // Tampon : le sas où la facture attend avant d'entrer dans le
            // circuit. Aucune relance n'y est faite — ni ADV, ni recouvrement.
            // Une facture qui y est encore, ou qui a été réglée sans jamais en
            // sortir, gonfle les taux sans qu'aucun travail ait été fourni :
            // pouvoir l'écarter est le seul moyen de mesurer ce travail.
            //
            // Le tampon se lit partout où la facture a laissé une trace : le
            // tableau où elle est, celui d'où elle vient, son rôle, et les
            // groupes traversés — une facture passée au tampon puis réglée ne
            // porte plus que son groupe d'origine pour le dire.
            f.enTampon = (f.presenceRoles || [f.role]).includes('tampon')
                || /tampon/.test(R.norm([
                    f.board, f.groupe, f.groupeOrigine, f.groupePaiement,
                    f.boardOperationnel, f.groupeOperationnel,
                    ...(f.presenceTableaux || []),
                ].filter(Boolean).join(' ')));

            // Une correction saisie à la main l'emporte sur toute déduction, et
            // précède le calcul de l'échéance : c'est la règle du financement
            // choisi qui doit s'appliquer. La correction est retenue sur le
            // numéro de facture, donc elle survit à un rechargement de Monday ;
            // sans numéro, elle ne vaut que pour cette ligne-là.
            f.cleManuelle = f.cle || (f.boardId + '#' + f.itemId);
            const manuel = o.financementsManuels && o.financementsManuels[f.cleManuelle];
            if (manuel) {
                f.financement = manuel; f.financementManuel = true;
                f.origineFinancement = 'Corrigé à la main dans l’application';
            } else f.financementManuel = false;

            // Le périmètre suit le financement, non le tableau où la facture se
            // trouve. Une facture CPF déposée sur un tableau corporate est un
            // financement B2C : la ranger en Corporate parce qu'elle transite
            // par l'ADV faisait apparaître du B2C-Perso et du CPF sous
            // Corporate, ce que le référentiel dément.
            if (f.financement) {
                const per = R.getRule(f.financement, o.rules).perimetre;
                if (per && per !== 'Tous' && per !== 'Inconnu') f.perimetre = per;
            }

            // Un montant absent alors qu'un reste dû est saisi : le reste dû est
            // le seul chiffre disponible, et il vaut mieux que zéro. Sur une
            // facture réglée, « Montant dû TTC » porte d'ailleurs le montant de
            // la facture — c'est ce qui était dû. Repris seulement à défaut, et
            // marqué : une facture partiellement réglée le sous-estime.
            if ((f.montant == null || f.montant === 0) && f.resteDu) {
                f.montant = f.resteDu;
                f.montantVientDuResteDu = true;
            }

            const ech = R.computeEcheance(f, { rules: o.rules, prefereEcheanceMonday: o.prefereEcheanceMonday });
            f.dateEcheance = ech.date;
            f.echeanceOrigine = ech.origine;

            // Dernier recours : l'échéance portée par Sellsy. Elle n'intervient
            // que là où aucune règle n'a pu calculer — une facture réglée avant
            // l'entrée dans le circuit ne porte ni date de formation, ni parfois
            // de date de facture, et sortait de tous les taux. Les règles de
            // financement gardent la main partout où elles savent répondre.
            f.echeanceBase = ech.baseUtilisee;
            if (!f.dateEcheance && f.echeanceSellsy) {
                f.dateEcheance = f.echeanceSellsy;
                f.echeanceOrigine = 'Sellsy';
                f.echeanceBase = 'dateEcheanceSellsy';
            }
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
            else if (f.grandLivreSoldee === true) motif = 'Lettrée dans le grand livre';
            // Les groupes de comptabilité — « En traitement Comptabilité »,
            // « Pennylane non pointé », « Paiement non remonté sur Sellsy » —
            // désignent des factures encaissées dont le règlement n'est pas
            // encore rapproché. Elles ne sont donc plus à recouvrer.
            else if (f.etape === 'COMPTA') motif = 'Groupe de comptabilité — règlement à rapprocher';

            // Annulée par avoir : la créance a disparu sans qu'un euro rentre.
            // La laisser « payée » la ferait compter dans ce que le
            // recouvrement a récupéré, alors qu'il n'a rien récupéré du tout.
            // Elle n'est pas non plus à relancer : elle sort du portefeuille.
            if (f.soldeeParAvoir) motif = null;

            const paye = motif != null && !f.soldeeParAvoir;
            f.paye = paye;
            f.motifPaye = f.soldeeParAvoir ? 'Annulée par un avoir au grand livre' : motif;

            // Signaux de règlement portés par un tableau opérationnel : ils ne
            // valent pas paiement, mais méritent d'être signalés.
            f.enAttenteRapprochement = motif === 'Groupe de comptabilité — règlement à rapprocher';
            // Une créance annulée par avoir n'est pas un règlement orphelin :
            // le conseil « ajoutez la ligne manquante au tableau des payées »
            // n'aurait aucun sens, et la facture était pénalisée deux fois dans
            // le score de qualité.
            f.signalPaiementHorsTableau = !paye && !f.soldeeParAvoir && !!(
                f.datePaiement || f.dateControlePaiement || statutIndiquePaye(f.statut)
                || (f.resteDu != null && f.montant != null && f.resteDu <= 0.01 && f.montant > 0));

            if (f.soldeeParAvoir) {
                // Aucun euro n'est rentré : lui laisser une date d'encaissement
                // la ferait entrer dans le flux du mois et dans le délai moyen
                // de règlement, exactement ce que l'avoir doit empêcher. La
                // date Monday reste lisible dans f.datePaiement.
                f.datePaiementEffective = null;
                f.paiementEstime = false;
                f.origineDatePaiement = null;
                f.signalPaiementHorsTableau = false;
            } else if (f.datePaiement) {
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

            // Une créance annulée n'est plus un encours.
            if (f.soldeeParAvoir) f.encours = 0;

            // Ce qui est réellement rentré, distinct du montant de la facture.
            // Un groupe soldé pour partie par un avoir et pour partie par un
            // règlement est bien « payé », mais seule la part réglée est de
            // l'argent : compter le montant entier gonflerait le taux de
            // récupération de ce que l'avoir a effacé.
            f.montantEncaisse = f.soldeeParAvoir ? 0
                : !paye ? (f.montantRegle || 0)
                : (f.montantRegle != null && f.montantAvoir > 0)
                    ? f.montantRegle
                    : (f.montant || 0);

            // Retard
            if (f.soldeeParAvoir) {
                // La créance a été annulée : ni en retard, ni encaissée. La
                // ranger dans l'un ou l'autre fausserait le taux de
                // récupération — dans un sens comme dans l'autre.
                f.retardJours = null;
                f.etat = 'Annulée par avoir';
            } else if (!f.dateEcheance) {
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
        validerMapping, couvertureMapping, verifierValeurs, colonnesCandidates,
        consolider, appliquerGrandLivre, appliquerSellsy, enrichir, statutIndiquePaye,
        aplatirExportMonday,
    };
})(window);
