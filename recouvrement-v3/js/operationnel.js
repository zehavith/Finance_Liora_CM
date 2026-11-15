/* ═══════════════════════════════════════════════════════════════════════
   L'ONGLET OPÉRATIONNEL
   ═══════════════════════════════════════════════════════════════════════

   Repris de « Suivi recouvrement version 2 », onglet « Opérationnel »,
   13/11/2026 : « récupère de suivi recouvrement 2 l'onglet opérationnel et
   met le dans mon appli ».

   CE QU'IL RÉPOND : non pas « combien doit-on » — ça, c'est le pilotage —
   mais « qu'est-ce qu'il faut traiter, et depuis combien de temps ça
   attend ». Il lit les tableaux Monday, pas la comptabilité.

   LE CIRCUIT. Les quatre étapes et leurs cibles viennent de la v2, et la
   table qui range chaque groupe Monday dans son étape aussi. Vérifiée le
   13/11/2026 contre les neuf tableaux : elle couvre 100 % des groupes, zéro
   non classé. Ce modèle est PROPRE À CET ONGLET et ne remplace pas
   LioraRules.ETAPES, qui qualifie un groupe par ses mots et sert ailleurs :
   celui-ci dit quel service tient la facture et sous quel délai.

   L'ÂGE DANS L'ÉTAPE se compte depuis la date d'entrée quand Monday la
   porte (« Date MAJ qualif ADV », « Date bascule en recouvrement »…), sinon
   depuis la date de référence de l'étape — facture pour l'ADV, échéance
   pour les autres. D'où elle vient est écrit sous le graphique : un âge
   dont on ignore l'origine ne se vérifie pas.

   LES ENTRÉES ET LES SORTIES se lisent dans l'historique Monday, qui n'est
   pas dans le paquet publié. Elles se chargent à la demande, avec le même
   jeton que le reste de l'application, et le rapprochement se fait par le
   NUMÉRO DE FACTURE — les exports du paquet ne portent pas l'identifiant
   Monday des lignes.
   ═══════════════════════════════════════════════════════════════════════ */
(function (global) {
    'use strict';

    const U = () => global.LioraUI;

    // ── Le circuit, repris de la v2 ──
    const CIRCUIT = [
        { k: 'adv', n: 'Rendre payable', svc: 'ADV', cible: 10, ref: 'facture',
          d: 'Factures non conformes ou incomplètes, à rendre payables' },
        { k: 'rec', n: 'Relancer', svc: 'Recouvrement', cible: 15, ref: 'echeance',
          d: 'Factures échues à relancer' },
        { k: 'fin', n: 'Clôture', svc: 'Contentieux', cible: 90, ref: 'echeance',
          d: 'Contentieux, perdu, attente de décision de passage en perte' },
        { k: 'cor', n: 'Corriger', svc: 'Comptabilité', cible: 30, ref: 'echeance',
          d: 'Paiement reçu non lettré, facture à annuler, toute autre clôture' },
    ];
    const ETAPE = {}; CIRCUIT.forEach(e => { ETAPE[e.k] = e; });

    // Numéro de groupe Monday → étape. « cours » = pas encore à traiter.
    const GROUPE_ETAPE = {
        '1.0.1': 'adv',
        '1.1.1': 'adv', '1.1.2': 'adv', '1.1.3': 'adv', '1.1.4': 'adv', '1.1.5': 'cours',
        // 1.2.2 « Recouvrement - Facture à déposer » venait de la v2 dans « Rendre
        // payable ». « Il y a dans le rendre payable des factures en recouvrement,
        // je ne comprends pas pourquoi » : un groupe du tableau Recouvrement est
        // tenu par le recouvrement, il compte donc dans « Relancer ».
        '1.2.1': 'rec', '1.2.2': 'rec', '1.2.3': 'rec', '1.2.4': 'fin', '1.2.5': 'fin',
        '1.2.6': 'rec', '1.2.7': 'rec', '1.2.8': 'cor',
        '1.3.1': 'adv', '1.3.5': 'cours',
        '2.1.1': 'rec', '2.1.1.1': 'rec', '2.1.2': 'cor', '2.1.3': 'cor', '2.1.4': 'rec',
        '2.1.5': 'rec', '2.1.6': 'fin', '2.1.7': 'cours', '2.1.8': 'cor',
        '2.2.1': 'adv', '2.2.2': 'rec', '2.2.3': 'cor', '2.2.4': 'cor', '2.2.5': 'cours',
        '2.2.6': 'cor', '2.2.9': 'cor', '2.2.10': 'cor',
        '2.3.1': 'rec', '2.3.3': 'rec', '2.3.5': 'cours', '2.3.6': 'cours', '2.3.7': 'cours',
        '2.3.9': 'cor', '2.3.10': 'cor',
        '2.4.2': 'rec', '2.4.3': 'rec', '2.4.7': 'cours', '2.4.9': 'cor', '2.4.10': 'cor',
    };

    // ═════════ VERSION 3 : TOUS LES GROUPES DE MONDAY, CLASSÉS OU DITS ═════════
    //
    // « Il faut que tu arrives à identifier quel groupe se trouve dans quelle
    // catégorie. » La table ci-dessus ne connaissait que les groupes qui
    // portaient des factures le 13/11/2026. Monday en compte d'autres, vides
    // ce jour-là : une facture qui y arrivait sortait du circuit sans que rien
    // ne le dise. Ils sont rangés ici PAR ANALOGIE avec les groupes déjà
    // classés (« Facture déposée » suit 1.2.7, « En traitement Comptabilité »
    // suit 1.2.8…), et l'écran les signale « à vérifier » : ce classement est
    // une proposition, pas une règle qu'elle a écrite.
    const AJOUTS_V3 = {
        '1.1.6': 'cours',   // Factures en cours - fin de formation
        '1.1.7': 'cor',     // En cours comptabilité
        '1.3.2': 'rec',     // Facture en recouvrement
        '1.3.3': 'rec',     // Facture déposée
        '1.3.4': 'cor',     // En traitement Comptabilité
        '1.3.9': 'cor',     // Comptabilité : Pennylane non pointé / paiement non remonté
        '2.1.9': 'cor', '2.1.10': 'cor',
        '2.3.2': 'adv',     // Factures avec action partielle à faire
        '2.3.4': 'rec',     // Factures déposées
        '2.3.8': 'fin',     // Factures qualifiées en perte
        '2.4.1': 'adv',     // Factures à classer
        '2.4.4': 'rec',     // Dossier transmis
        '2.4.5': 'rec',     // Facture en recouvrement
        '2.4.6': 'cours', '2.4.8': 'cours',   // Facture en cours REGION / AGEFIPH
    };
    Object.keys(AJOUTS_V3).forEach(p => { if (!GROUPE_ETAPE[p]) GROUPE_ETAPE[p] = AJOUTS_V3[p]; });
    // Un groupe sans numéro se reconnaît à son titre.
    const TITRE_ETAPE = { 'facture en cours sellsy': 'cours' };
    const cleTitre = t => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();

    // Les groupes des neuf tableaux, tels que Monday les nomme (relevé du
    // 13/11/2026). Ils servent à écrire la table de correspondance en entier,
    // groupes vides compris ; un groupe créé depuis s'y ajoute tout seul dès
    // qu'une facture le porte.
    const REFERENTIEL = [
        ['1.0. Entreprise - Tampon', ['1.0.1. Factures à qualifier', '1.0.2. Technique - Assigné à ADV/Recouvrement',
            '1.0.9. Technique - Factures incomplètes', '1.0.9. Technique - Contentieux',
            '1.0.9. Technique - Pas encore à échéance', '1.0.9. Technique - Facture Alternance',
            '1.0.9. Technique - Facture OPCO']],
        ['1.1. Entreprise - ADV', ['1.1.1. Factures non conformes', '1.1.2. Factures incomplètes (Mail)',
            '1.1.3. Facture avec action à faire - B2B', '1.1.4. Factures avec action fin de formation',
            '1.1.5. Factures en cours', '1.1.6. Factures en cours -fin de formation', '1.1.7. En cours comptabilité',
            '1.1.9. Technique - Tampon', '1.1.9. Technique - Archive', '1.1.9. Technique - Service recouvrement']],
        ['1.2. Entreprise - Recouvrement', ['1.2.1. Recouvrement - Facture à relancer',
            '1.2.2.  Recouvrement - Facture à déposer',
            '1.2.3. Dossiers à retraiter - Déposée depuis + de 30 jours / Paiement prévu révolu',
            "1.2.4. Facture catégorie ''perdu'' / ''Partiellement perdu''", '1.2.5 Service contentieux',
            '1.2.6. Paiement Prévu', '1.2.7. Facture déposée', '1.2.8. En traitement Comptabilité',
            '1.2.9. Technique - Service ADV', '1.2.9. Technique - Tampon', '1.2.9. Technique - Archive']],
        ['1.3. Entreprise - OPCO', ['1.3.1. Factures à déposer', '1.3.2 Facture en recouvrement',
            '1.3.3. Facture déposée', '1.3.4. En traitement Comptabilité', '1.3.5. Facture en cours Filiz',
            'Facture en cours sellsy', '1.3.9. Technique - Archive', '1.3.9. Comptabilité : Pennylane non pointé',
            '1.3.9. Comptabilité : Paiement non remonté sur Sellsy']],
        ['2.1. Financement Personnel', ['2.1.1. Factures à qualifier', '2.1.1.1 Factures à suivre',
            '2.1.2. Factures à reclasser', '2.1.3. Factures à annuler', '2.1.4 Recouvrement - En cours de traitement',
            '2.1.5 Recouvrement - Dossier traité', '2.1.6. Facture en Contentieux', '2.1.7. Facture en cours',
            '2.1.8. En traitement Comptabilité - Paiement non validé', '2.1.9. Comptabilité : Pennylane non pointé',
            '2.1.10. Comptabilité : Paiement non remonté sur Sellsy']],
        ['2.2. Financement CPF', ['2.2.1 Facture à Traiter',
            '2.2.2  Factures CPF recouvrement- Fin de formation + 60 jours dépassée',
            '2.2.3  Factures CPF - Remboursement, dossier à annuler', '2.2.4  Factures CPF à annuler',
            '2.2.5  Factures en cours', '2.2.6. Facture En traitement Comptabilité', '2.2.8. Facture Archivée',
            '2.2.9. Comptabilité : Pennylane non pointé - sellsy pointé',
            '2.2.10. Comptabilité : Paiement non remonté sur Sellsy - Pennylane pointé']],
        ['2.3. Financement pôle emploi : AIF / POEI', ['2.3.1 Factures à échéance',
            '2.3.2 Factures avec action partielle à faire', '2.3.3 Factures en recouvrement',
            '2.3.4  Factures déposées', '2.3.5 Factures en cours AIF', '2.3.6 Factures en cours POEI',
            '2.3.7 Factures en cours Pôle emploi - B2B', '2.3.8 Factures qualifiées en perte',
            '2.3.9. Comptabilité : Pennylane non pointé', '2.3.10. Comptabilité : Paiement non remonté sur Sellsy']],
        ['2.4. Financement complexe : REGION / TRANSITION / AGEFIPH', ['2.4.1. Factures à classer',
            '2.4.2. Factures à échéance', '2.4.3. Factures en recouvrement non qualifiées par service ADV',
            '2.4.4. Dossier transmis', '2.4.5. Facture en recouvrement', '2.4.6. Facture en cours REGION',
            '2.4.7. Facture en cours TRANSITION PRO', '2.4.8. Facture en cours AGEFIPH',
            '2.4.9. Comptabilité : Pennylane non pointé', '2.4.10. Comptabilité : Paiement non remonté sur Sellsy']],
    ];

    const estTechnique = t => {
        const R = global.LioraRules;
        return !!(R && R.estGroupeTechnique && R.estGroupeTechnique(t));
    };
    // La catégorie d'un groupe, d'après son seul titre : une des quatre
    // étapes, « cours », « technique », ou null quand rien ne le classe.
    // Les groupes reclassés à la main dans l'onglet « Règles d'application » :
    // titre du groupe → catégorie choisie (« aucune » = non classé).
    const SURCHARGES = {};
    const categorieOrigine = titre => GROUPE_ETAPE[prefixe(titre)] || TITRE_ETAPE[cleTitre(titre)] || null;
    function categorieDuGroupe(titre) {
        if (estTechnique(titre)) return 'technique';
        const s = SURCHARGES[cleTitre(titre)];
        if (s) return s === 'aucune' ? null : s;
        return categorieOrigine(titre);
    }
    // Un groupe que la version 3 a rangé par analogie, et que personne n'a confirmé.
    const estPropose = titre => !SURCHARGES[cleTitre(titre)] && !estTechnique(titre)
        && !!AJOUTS_V3[prefixe(titre)] && AJOUTS_V3[prefixe(titre)] === categorieOrigine(titre);
    const LIB_CATEGORIE = {
        cours: ['Sous contrôle', 'groupe « en cours » : compté dans « Sous contrôle » tant que l’échéance n’est pas passée'],
        technique: ['Technique / archive', 'groupe de service — non compté'],
    };

    // PAS DE MÉTRIQUE « SANS RELANCE », 13/11/2026, et c'est un constat, pas un
    // oubli : AUCUN des sept tableaux de travail ne porte de date de dernière
    // relance. « Relance 1 - J », « Relance 1 » et « Blocage manuel des
    // relances » ne sont pas des dates. La v2 affichait « 100 % de dossiers
    // qui dorment » — vrai au sens du calcul, faux au sens de la réalité :
    // il ne mesurait que l'absence de la colonne. Il n'est pas repris.

    // ── l'état de l'onglet ──
    const F = { etape: 'adv', q: '', deplies: {} };
    let HIST = null;                    // { mois, de, le, par: Map(etape → {e,s,dest,dur}) }
    let histEtat = { s: 'idle', msg: '' };
    let FOCUS_OUVERT = false;
    let LISTE_FILTRE = 'tout', LISTE_COURANTE = { pr: [], k: '', nom: 'tout' };
    let DERNIERES = [];                 // les factures du dernier rendu

    // ═════════ helpers ═════════
    const prefixe = t => { const m = /^\s*(\d+(?:\.\d+)+)/.exec(String(t || '')); return m ? m[1] : ''; };
    const esc = s => U().escapeHtml(String(s == null ? '' : s));
    const eur = v => U().euros(v);
    const nb = v => (v == null || !isFinite(v)) ? '—' : Math.round(v).toLocaleString('fr-FR');
    const JOUR = 86400000;
    const auj = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
    const jours = (a, b) => (!a || !b) ? null : Math.round((b - new Date(a)) / JOUR);
    const mediane = arr => { const a = arr.filter(x => x != null && isFinite(x)).sort((x, y) => x - y);
        if (!a.length) return null;
        const m = Math.floor(a.length / 2);
        return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
    const somme = (arr, f) => arr.reduce((s, x) => s + (f(x) || 0), 0);

    // Le reste dû fait foi ; à défaut le montant TTC.
    const montantDe = f => (f.resteDu != null && isFinite(f.resteDu)) ? f.resteDu : (f.montant || 0);

    // Le groupe et le tableau Monday qui rangent la facture dans son étape.
    // Une facture peut figurer sur plusieurs tableaux ; c'est sa ligne de
    // travail — celle que le circuit suit — qui compte ici.
    const groupeDe = f => String(f.groupeOperationnel || f.groupe || '').trim() || '(sans groupe)';
    const tableauDe = f => String(f.boardOperationnel || f.board || '').trim() || '(tableau inconnu)';

    const etapeDe = f => {
        if (f.groupeTechnique) return null;
        const g = f.groupeOperationnel || f.groupe || '';
        const c = categorieDuGroupe(g);
        return (c && c !== 'technique') ? c : null;
    };

    // Les factures non réglées qu'aucune catégorie ne range : elles ne sont
    // dans aucune étape, et l'écran doit le dire plutôt que les taire.
    function nonClassees(factures) {
        return (factures || []).filter(f => {
            if (f.paye || f.groupeTechnique) return false;
            if (f.role === 'payees' || f.role === 'technique' || f.role === 'ignore' || f.role === 'sellsy') return false;
            if (/^avr/i.test(String(f.numero || ''))) return false;
            return categorieDuGroupe(groupeDe(f)) == null;
        });
    }

    /**
     * La table de correspondance : chaque groupe de chaque tableau, la
     * catégorie où il compte, et combien de factures non réglées il porte.
     */
    function tableCorrespondance(factures) {
        const ouvertesPar = new Map();          // tableau → titre de groupe → factures non réglées
        for (const f of (factures || [])) {
            if (f.paye || f.role === 'payees' || f.role === 'sellsy' || f.role === 'ignore') continue;
            if (/^avr/i.test(String(f.numero || ''))) continue;
            const t = tableauDe(f), g = groupeDe(f);
            if (!ouvertesPar.has(t)) ouvertesPar.set(t, new Map());
            const m = ouvertesPar.get(t);
            if (!m.has(g)) m.set(g, []);
            m.get(g).push(f);
        }
        // Le référentiel d'abord, puis ce que les données portent en plus.
        const num = t => prefixe(t).split('.').slice(0, 2).join('.');
        const tableaux = REFERENTIEL.map(r => ({ nom: r[0], groupes: r[1].slice() }));
        for (const [t, m] of ouvertesPar) {
            let cible = tableaux.find(x => num(x.nom) && num(x.nom) === num(t));
            if (!cible) { cible = { nom: t, groupes: [] }; tableaux.push(cible); }
            const connus = new Set(cible.groupes.map(cleTitre));
            for (const g of m.keys()) if (!connus.has(cleTitre(g))) cible.groupes.push(g);
            cible.donnees = cible.donnees || new Map();
            for (const [g, arr] of m) cible.donnees.set(cleTitre(g), (cible.donnees.get(cleTitre(g)) || []).concat(arr));
        }
        let h = '<table class="op-t op-corr"><thead><tr><th>Groupe Monday</th><th>Compte dans</th>'
              + '<th class="n">Factures non réglées</th></tr></thead><tbody>';
        for (const t of tableaux) {
            h += '<tr class="op-sous-tableau op-corr-tableau"><td colspan="3">' + esc(t.nom) + '</td></tr>';
            for (const g of t.groupes) {
                const cat = categorieDuGroupe(g);
                const its = (t.donnees && t.donnees.get(cleTitre(g))) || [];
                const propose = estPropose(g);
                let lib;
                if (cat && ETAPE[cat]) {
                    lib = '<span class="op-chip op-cat-' + cat + '">' + esc(ETAPE[cat].n) + '</span> '
                        + '<span class="op-pied">' + esc(ETAPE[cat].svc) + '</span>';
                } else if (cat) {
                    lib = '<span class="op-chip">' + esc(LIB_CATEGORIE[cat][0]) + '</span> '
                        + '<span class="op-pied">' + esc(LIB_CATEGORIE[cat][1]) + '</span>';
                } else {
                    lib = '<span class="op-chip mauvais">Non classé</span> '
                        + '<span class="op-pied">ce groupe n’est rangé dans aucune étape</span>';
                }
                if (propose) lib += ' <span class="op-chip moyen" title="Ce groupe n’était pas classé : la version 3 '
                    + 'le range par analogie avec un groupe voisin. À confirmer.">à vérifier</span>';
                h += '<tr><td>' + esc(g) + '</td><td>' + lib + '</td><td class="n">'
                   + (its.length ? ouvrable(nb(its.length), g, its,
                        'Factures non réglées du groupe Monday « ' + g + ' », tableau « ' + t.nom + ' ».') : '0')
                   + '</td></tr>';
            }
        }
        return h + '</tbody></table>';
    }

    // ═════════ VERSION 3 : CHAQUE NOMBRE S'OUVRE SUR SES FACTURES ═════════
    //
    // « Lorsque tu parles de "Rendre payable", que je puisse retrouver à quoi
    // correspond le nombre de factures, dans quels tableaux elles sont. »
    // Un nombre devient un bouton : il ouvre la liste des factures qu'il
    // compte, avec pour chacune son tableau et son groupe Monday. Les lots
    // sont enregistrés pendant le rendu et retrouvés au clic par leur rang.
    let LOTS = [];
    function lot(titre, its, note, opts) {
        LOTS.push({ titre, its: its || [], note: note || '', completer: !!(opts && opts.completer) });
        return LOTS.length - 1;
    }
    // Le nombre cliquable. `texte` est ce qui s'affiche ; le lot est ce qui s'ouvre.
    function ouvrable(texte, titre, its, note, opts) {
        if (!its || !its.length) return texte;
        return '<button type="button" class="op-lien" data-lot="' + lot(titre, its, note, opts)
            + '" title="Voir ces ' + nb(its.length) + ' factures">' + texte + '</button>';
    }

    // Les groupes Monday qui composent une étape, d'après la table ci-dessus.
    // Les numéros des groupes du référentiel que la règle en vigueur range
    // dans cette étape — reclassements faits à la main compris.
    const groupesDeLEtape = k => { const vus = [];
        REFERENTIEL.forEach(t => t[1].forEach(g => { if (categorieDuGroupe(g) === k) { const p = prefixe(g) || g;
            if (vus.indexOf(p) < 0) vus.push(p); } }));
        return vus; };

    // Tableau → groupe → factures, les plus fournis d'abord.
    function composition(its) {
        const t = new Map();
        for (const f of its) {
            const tb = tableauDe(f), g = groupeDe(f);
            if (!t.has(tb)) t.set(tb, new Map());
            const m = t.get(tb);
            if (!m.has(g)) m.set(g, []);
            m.get(g).push(f);
        }
        return [...t.entries()].map(([tableau, m]) => {
            const groupes = [...m.entries()].map(([groupe, arr]) => ({ groupe, its: arr }))
                .sort((a, b) => b.its.length - a.its.length);
            return { tableau, groupes, its: [].concat(...groupes.map(g => g.its)) };
        }).sort((a, b) => b.its.length - a.its.length);
    }

    const lienMonday = f => (/^\d+$/.test(String(f.itemId || '')) && /^\d+$/.test(String(f.boardId || '')))
        ? '<a href="https://cyberuniversity.monday.com/boards/' + f.boardId + '/pulses/' + f.itemId
          + '" target="_blank" rel="noopener">' + esc(f.numero) + '</a>'
        : esc(f.numero);

    // ═════════ VERSION 3 : COMPLÉTER LA DATE QUI MANQUE, SUR PLACE ═════════
    //
    // « Lorsque l'on clique dessus je dois pouvoir compléter direct. » Une
    // facture « à qualifier » n'a pas d'échéance parce qu'il lui manque la
    // date sur laquelle sa règle s'appuie. La liste dit laquelle, et la
    // laisse saisir. La date est gardée dans ce navigateur et sert au calcul
    // ici ; elle n'est PAS écrite dans Monday, et la liste le dit.
    const NOM_DATE = { dateFacture: 'Date de facture', dateFinFormation: 'Fin de formation',
                       dateDebutFormation: 'Début de formation' };
    function dateManquante(f) {
        const R = global.LioraRules, st = global.__recouvrement || {};
        const r = (R && R.getRule) ? R.getRule(f.financement, st.rules) : null;
        const champs = [r && r.base, r && r.fallback, 'dateFacture'].filter(c => NOM_DATE[c]);
        return champs.find(c => !f[c]) || champs[0] || 'dateFacture';
    }
    function celluleCompleter(f, i) {
        const champ = dateManquante(f);
        return '<td class="op-compl"><label class="op-pied" for="op-date-' + i + '">' + esc(NOM_DATE[champ])
            + '</label><span class="op-compl-l"><input type="date" class="input input-sm" id="op-date-' + i + '">'
            + '<button type="button" class="btn btn-primary btn-sm" data-completer="' + i + '" data-champ="'
            + champ + '">Enregistrer</button></span></td>';
    }

    const LIGNES_MAX = 300;
    function montrerLot(l) {
        const its = l.its.slice().sort((a, b) => montantDe(b) - montantDe(a));
        const comp = composition(its);
        const resume = comp.map(c => '<span class="op-chip">' + esc(c.tableau) + ' · ' + nb(c.its.length) + '</span>').join(' ');
        const lignes = its.slice(0, LIGNES_MAX).map(f => {
            const r = retard(f), ech = f.dateEcheance || f.dateEcheanceSource;
            return '<tr><td>' + lienMonday(f)
                + ((f.client && f.client !== '—') || f.apprenant
                    ? '<br><span class="op-pied">' + esc(f.client && f.client !== '—' ? f.client : f.apprenant) + '</span>' : '')
                + '</td><td>' + esc(tableauDe(f)) + '</td><td>' + esc(groupeDe(f)) + '</td>'
                + '<td>' + esc(f.financement || '—') + '</td>'
                + '<td class="n">' + eur(montantDe(f)) + '</td>'
                + '<td class="n">' + (ech ? U().dateFR(ech)
                    + (r != null && r > 0 ? '<br><span class="op-pied">dépassée de ' + r + ' j</span>' : '')
                    : '<span class="op-acompleter">à qualifier</span>') + '</td>'
                + (l.completer ? celluleCompleter(f, its.indexOf(f)) : '') + '</tr>';
        }).join('');
        const html = (l.note ? '<p class="op-pied op-lot-note">' + esc(l.note) + '</p>' : '')
            + '<p class="op-lot-total"><b>' + nb(its.length) + ' factures</b> · ' + eur(somme(its, montantDe))
            + ' de restant dû</p>'
            + '<p class="op-lot-resume"><span class="op-pied">Tableaux Monday :</span> ' + resume + '</p>'
            + '<div class="table-wrap"><table class="op-t"><thead><tr><th>Facture · client</th>'
            + '<th>Tableau Monday</th><th>Groupe Monday</th><th>Financement</th>'
            + '<th class="n">Restant dû</th><th class="n">Échéance</th>'
            + (l.completer ? '<th>Date à compléter</th>' : '') + '</tr></thead><tbody>'
            + lignes + '</tbody></table></div>'
            + (l.completer ? '<p class="op-pied">La date saisie sert au calcul de l’échéance dans cette '
                + 'application et reste dans ce navigateur. Elle n’est pas écrite dans Monday : '
                + 'pensez à l’y reporter, sans quoi la facture reviendra « à qualifier » sur un autre poste.</p>' : '')
            + (its.length > LIGNES_MAX ? '<p class="op-pied">Les ' + LIGNES_MAX + ' plus gros montants sur '
                + nb(its.length) + '. « Exporter en Excel » donne toutes les lignes.</p>' : '');
        const corps = U().modal(l.titre, html, [
            { label: 'Exporter en Excel', close: false, onClick: () => exporterLot(l.titre, its) },
            { label: 'Fermer', primary: true },
        ], { large: true });
        if (!l.completer || !corps) return;
        corps.querySelectorAll('[data-completer]').forEach(b => b.onclick = async () => {
            const i = +b.dataset.completer, f = its[i];
            const champ = b.dataset.champ, saisie = corps.querySelector('#op-date-' + i);
            const V3 = global.LioraV3;
            if (!f || !saisie || !saisie.value) { U().toast('Choisissez d’abord une date.', 'error'); return; }
            if (!V3 || !V3.completerDate) { U().toast('La saisie n’est pas disponible ici.', 'error'); return; }
            b.disabled = true;
            const ok = await V3.completerDate(f.cle, champ, saisie.value);
            if (ok) {
                b.closest('td').innerHTML = '<span class="op-chip bon">' + esc(NOM_DATE[champ]) + ' enregistrée</span>';
            } else {
                b.disabled = false;
                U().toast('La date n’a pas pu être appliquée à cette facture.', 'error');
            }
        });
    }

    function exporterLot(titre, its) {
        const X = global.XLSX;
        if (!X) { U().toast && U().toast('SheetJS n’est pas chargé.'); return; }
        const lignes = its.map(f => ({
            'Facture': f.numero, 'Client': f.client, 'Apprenant': f.apprenant || '',
            'Tableau Monday': tableauDe(f), 'Groupe Monday': groupeDe(f),
            'Étape du circuit': (ETAPE[etapeDe(f)] || {}).n || '',
            'Financement': f.financement || '', 'Problématique': f.problematique || '',
            'Restant dû': montantDe(f), 'Échéance': f.dateEcheance || f.dateEcheanceSource || '',
            'Jours de retard': retard(f) == null ? '' : retard(f),
            'Propriétaire': f.proprietaire || '',
        }));
        const wb = X.utils.book_new();
        X.utils.book_append_sheet(wb, X.utils.json_to_sheet(lignes), 'Factures');
        X.writeFile(wb, 'operationnel-' + String(titre).toLowerCase().replace(/[^a-z0-9]+/gi, '-').slice(0, 40)
            + '-' + new Date().toISOString().slice(0, 10) + '.xlsx');
    }

    // Les factures que le circuit suit : ni réglées, ni avoirs, ni « en cours ».
    function ouvertes(factures) {
        return (factures || []).filter(f => {
            if (f.paye) return false;
            if (/^avr/i.test(String(f.numero || ''))) return false;
            const k = etapeDe(f);
            return !!(k && ETAPE[k]);
        });
    }

    // L'âge dans l'étape, et d'où il vient.
    function ageEtape(f, k) {
        const e = ETAPE[k], t = auj();
        if (f.dateEtape) return { j: jours(f.dateEtape, t), src: 'etape' };
        const ref = e.ref === 'facture' ? f.dateFacture : (f.dateEcheance || f.dateEcheanceSource);
        return ref ? { j: jours(ref, t), src: 'ref' } : { j: null, src: 'aucune' };
    }

    function statsEtape(items, k) {
        const its = items.filter(f => etapeDe(f) === k);
        const ages = its.map(f => ageEtape(f, k).j).filter(j => j != null);
        const cible = ETAPE[k].cible;
        return {
            its, st: its.length, mt: somme(its, montantDe),
            a: mediane(ages), c: cible,
            h: ages.length ? ages.filter(j => j > cible).length / ages.length * 100 : null,
        };
    }

    const retard = f => { const d = f.dateEcheance || f.dateEcheanceSource;
        return d ? jours(d, auj()) : null; };

    // ═════════ l'historique Monday ═════════
    //
    // Monday garde le journal de ses tableaux. Un déplacement de ligne d'un
    // groupe à l'autre est une sortie pour l'un et une entrée pour l'autre :
    // c'est tout ce qu'il faut pour compter les mouvements d'un mois.
    //
    // LE RAPPROCHEMENT SE FAIT PAR LE NUMÉRO DE FACTURE, qui est le nom de la
    // ligne Monday. Les exports du paquet ne portent pas l'identifiant Monday,
    // et un identifiant qu'on n'a pas ne rapproche rien.
    // VERSION 3 — LES ENTRÉES ET LES SORTIES SE LISENT PAR LE CONNECTEUR.
    //
    // « Pourquoi ici je n'ai rien dans entrées et sorties ? Tu n'as pas les
    // infos sur Monday ? » Si : Monday tient le journal de ses tableaux, et
    // chaque déplacement d'une facture d'un groupe à un autre y est écrit
    // (« move_pulse_from_group », avec le groupe de départ et le groupe
    // d'arrivée). L'ancienne lecture demandait un jeton que la page publiée
    // n'a pas, et cherchait le déplacement sous un autre nom : les colonnes
    // restaient vides. La lecture passe maintenant par le connecteur
    // monday.com, tableau par tableau, sur le mois en cours.
    const etapeDuTitre = t => { const c = categorieDuGroupe(t); return (c && ETAPE[c]) ? c : null; };

    // Un déplacement : il sort d'une étape, il entre dans une autre.
    function compterMouvement(par, evenement, d) {
        const depT = d.source_group && d.source_group.title, arrT = d.dest_group && d.dest_group.title;
        const dep = depT ? etapeDuTitre(depT) : null, arr = arrT ? etapeDuTitre(arrT) : null;
        // Un changement de tableau s'écrit deux fois, une au départ et une à
        // l'arrivée : la sortie se compte au départ, l'entrée à l'arrivée.
        const entre = evenement !== 'move_pulse_from_board';
        const sort = evenement !== 'move_pulse_into_board';
        if (dep === arr) return false;                    // resté dans la même étape
        if (entre && arr && par[arr]) par[arr].e++;
        if (sort && dep && par[dep]) {
            par[dep].s++;
            const ou = arr ? ETAPE[arr].n
                : arrT ? (estTechnique(arrT) ? 'Groupe technique / archive'
                          : categorieDuGroupe(arrT) === 'cours' ? 'En cours' : arrT)
                : ((d.dest_board && d.dest_board.name) || 'Autre tableau');
            par[dep].dest[ou] = (par[dep].dest[ou] || 0) + 1;
        }
        return true;
    }

    async function chargerHistorique(mois, onAvance) {
        const M = global.LioraMonday;
        if (!M || !M.requeteConnecteur || !M.connecteurDisponible || !(await M.connecteurDisponible()))
            throw new Error('le connecteur monday.com n’est pas disponible dans cette vue (page ouverte hors '
                + 'de claude.ai, ou connecteurs non autorisés pour cette page).');
        const de = mois + '-01T00:00:00Z';
        const dernier = new Date(+mois.slice(0, 4), +mois.slice(5, 7), 0).getDate();
        const au = mois + '-' + String(dernier).padStart(2, '0') + 'T23:59:59Z';
        const par = {}; CIRCUIT.forEach(e => { par[e.k] = { e: 0, s: 0, dest: {}, dur: [] }; });
        // Les tableaux de travail ; celui des factures payées ne fait pas partie du circuit.
        const tableaux = (M.TABLEAUX_CONNECTEUR || []).slice(1);
        const TYPES = '["move_pulse_from_group", "move_pulse_into_board", "move_pulse_from_board"]';
        let lus = 0, tronque = false;
        for (let i = 0; i < tableaux.length; i++) {
            if (onAvance) onAvance('Lecture du journal Monday — tableau ' + (i + 1) + ' sur ' + tableaux.length
                + ' · ' + nb(lus) + ' déplacements lus');
            let curseur = null, pages = 0;
            do {
                const rep = await M.requeteConnecteur('query { boards(ids: [' + tableaux[i] + ']) { activity_logs('
                    + 'from: "' + de + '", to: "' + au + '", event_types: ' + TYPES + ', limit: 500'
                    + (curseur ? ', cursor: ' + JSON.stringify(curseur) : '') + ') { cursor logs { event data } } } }');
                const page = (((rep && rep.boards) || [])[0] || {}).activity_logs || {};
                for (const a of (page.logs || [])) {
                    let d; try { d = JSON.parse(a.data); } catch (_) { continue; }
                    if (d && d.is_undo_action) continue;
                    lus++;
                    compterMouvement(par, a.event, d || {});
                }
                curseur = page.cursor || null;
                pages++;
                if (curseur && pages >= 40) { tronque = true; curseur = null; }
            } while (curseur);
        }
        HIST = { mois, de: de.slice(0, 10), au: au.slice(0, 10), le: new Date().toISOString(), par, lus, tronque };
        return HIST;
    }

    // ═════════ VERSION 3 : UNE ÉTAPE SE DESCEND EN TROIS NIVEAUX ═════════
    //
    // « Lorsque je clique sur Rendre payable, j'ai les tableaux concernés avec
    // montant et nombre de factures — puis si je clique sur un des tableaux
    // j'ai les groupes concernés, et si je clique sur un des groupes j'ai les
    // factures. » La fenêtre d'une étape n'est donc plus une liste à plat :
    // elle s'ouvre sur ses tableaux, descend dans leurs groupes, puis dans
    // leurs factures, et le fil en tête permet de remonter d'un niveau.
    let ST = null;                      // les étapes du dernier rendu

    // « EN PREMIÈRE ÉTAPE DU CIRCUIT, UNE VIGNETTE AVEC TOUTES LES FACTURES
    // AVANT ÉCHÉANCE. » Ce n'est pas une cinquième étape de traitement : rien
    // n'y est en retard. C'est ce qui arrive — les factures non réglées dont
    // l'échéance calculée n'est pas encore passée, où qu'elles soient rangées
    // dans Monday, groupes « en cours » compris. Certaines sont déjà dans une
    // étape du circuit (une facture incomplète se traite avant son échéance) :
    // la vignette le dit, et elle n'entre pas dans le total du circuit.
    // « UNE FACTURE EN RECOUVREMENT NE PEUT PAS ÊTRE SOUS CONTRÔLE. » Une
    // facture déjà rangée dans une étape — à rendre payable, à relancer, en
    // clôture, à corriger — est suivie par cette étape, même si son échéance
    // calculée n'est pas passée : elle n'entre pas ici. C'est la règle
    // « horsEtapes », modifiable dans l'onglet « Règles d'application ».
    const CONTROLE = { k: 'ctl', n: 'Sous contrôle', svc: 'Avant échéance', proche: 15, horsEtapes: true,
        d: 'Factures non réglées dont l’échéance n’est pas encore passée' };
    const etapeOuControle = k => k === 'ctl' ? CONTROLE : ETAPE[k];
    const joursAvant = f => { const r = retard(f); return r == null ? null : -r; };
    function sousControle(factures) {
        return (factures || []).filter(f => {
            if (f.paye || f.groupeTechnique) return false;
            if (f.role === 'payees' || f.role === 'technique' || f.role === 'ignore' || f.role === 'sellsy') return false;
            if (/^avr/i.test(String(f.numero || ''))) return false;
            if (CONTROLE.horsEtapes) { const k = etapeDe(f); if (k && ETAPE[k]) return false; }
            const r = retard(f);
            return r != null && r <= 0;
        });
    }
    // Échues, non réglées, et pourtant encore dans un groupe « en cours » :
    // elles ne sont ni sous contrôle (leur échéance est passée) ni dans une
    // étape. Sans cette alerte, elles n'apparaîtraient nulle part.
    function echuesEnCours(factures) {
        return (factures || []).filter(f => {
            if (f.paye || f.groupeTechnique) return false;
            if (f.role === 'payees' || f.role === 'technique' || f.role === 'ignore' || f.role === 'sellsy') return false;
            if (/^avr/i.test(String(f.numero || ''))) return false;
            const r = retard(f);
            return r != null && r > 0 && categorieDuGroupe(groupeDe(f)) === 'cours';
        });
    }
    function vignetteControle(c, circuit, oubliees) {
        const dans = new Set((circuit || []).map(f => f.cle));
        const deja = c.its.filter(f => dans.has(f.cle));
        const proches = c.its.filter(f => joursAvant(f) <= CONTROLE.proche);
        const comp = composition(c.its);
        return '<div class="op-fcard op-fcard-ctl" data-carte="ctl">'
            + '<span class="op-ft">' + ouvrableEtape(esc(CONTROLE.n), 'ctl') + '<span>' + esc(CONTROLE.svc) + '</span></span>'
            + '<span class="op-fs op-fdesc">' + esc(CONTROLE.d) + (CONTROLE.horsEtapes
                ? ' et qui ne sont encore dans aucune étape du circuit.' : ', où qu’elles soient dans Monday.') + '</span>'
            + '<span class="op-fbig">' + ouvrableEtape(nb(c.st), 'ctl') + ' <small>factures</small></span>'
            + '<span class="op-fs">' + eur(c.mt) + ' de restant dû</span>'
            + '<span class="op-fs">échéance médiane dans <b>'
            + (c.its.length ? nb(mediane(c.its.map(joursAvant))) + ' j' : '—') + '</b></span>'
            + '<span class="op-chips">'
            + (proches.length ? '<span class="op-chip moyen">' + ouvrable(nb(proches.length) + ' à échéance sous '
                + CONTROLE.proche + ' jours', 'Sous contrôle — échéance sous ' + CONTROLE.proche + ' jours', proches,
                'Factures non réglées dont l’échéance tombe dans les ' + CONTROLE.proche + ' prochains jours.')
                + ' · ' + eur(somme(proches, montantDe)) + '</span>' : '')
            + ((oubliees || []).length ? '<span class="op-chip mauvais">' + ouvrable(nb(oubliees.length)
                + ' échues encore dans un groupe « en cours »', 'Échues encore dans un groupe « en cours »', oubliees,
                'Factures non réglées dont l’échéance est passée, mais qui sont toujours dans un groupe Monday « en cours » : '
                + 'elles ne sont ni sous contrôle ni dans une étape du circuit. À déplacer dans Monday.')
                + ' · ' + eur(somme(oubliees, montantDe)) + '</span>' : '')
            + (deja.length ? '<span class="op-chip">' + ouvrable(nb(deja.length) + ' déjà dans une étape',
                'Sous contrôle — déjà dans une étape du circuit', deja,
                'Factures pas encore échues mais déjà rangées dans un groupe du circuit (à rendre payable, à corriger…). '
                + 'Elles sont aussi comptées dans leur étape.') + '</span>' : '')
            + '</span>'
            + (comp.length ? '<span class="op-ou op-ou-large"><span class="op-ou-t">Dans quels tableaux Monday</span>'
                + comp.map(x => '<span class="op-ou-l"><span>' + esc(x.tableau) + '</span>'
                    + ouvrableEtape(nb(x.its.length), 'ctl', x.tableau) + '</span>').join('') + '</span>' : '')
            + '</div>';
    }

    function ouvrableEtape(texte, k, t, g) {
        return '<button type="button" class="op-lien" data-nav-etape="' + k + '"'
            + (t ? ' data-t="' + esc(t) + '"' : '') + (g ? ' data-g="' + esc(g) + '"' : '')
            + ' title="Voir le détail : tableaux, groupes, factures">' + texte + '</button>';
    }
    // Ce qu'on veut savoir d'un lot de factures, quel que soit le niveau.
    // Dans une étape : ce qui est échu, l'âge dans l'étape, la part hors
    // délai. Sous contrôle : ce qui échoit bientôt, et dans combien de jours.
    function resumeLot(its, k) {
        if (k === 'ctl') {
            const pr = its.filter(f => joursAvant(f) <= CONTROLE.proche);
            return { n: its.length, mt: somme(its, montantDe), nEch: pr.length, mtEch: somme(pr, montantDe),
                     age: mediane(its.map(joursAvant)), hd: null };
        }
        const cible = ETAPE[k].cible;
        const ages = its.map(f => ageEtape(f, k).j).filter(j => j != null);
        const ech = its.filter(f => { const r = retard(f); return r != null && r > 0; });
        return { n: its.length, mt: somme(its, montantDe), nEch: ech.length, mtEch: somme(ech, montantDe),
                 age: mediane(ages),
                 hd: ages.length ? ages.filter(j => j > cible).length / ages.length * 100 : null };
    }
    function problematiquePrincipale(its) {
        const c = {};
        its.forEach(f => { const t = (f.problematique || '').trim(); if (t) c[t] = (c[t] || 0) + 1; });
        const noms = Object.keys(c).sort((a, b) => c[b] - c[a]);
        return noms.length ? noms[0] + ' (' + nb(c[noms[0]]) + ')' : '—';
    }
    function montrerEtape(k, t, g) {
        const e = etapeOuControle(k), ctl = k === 'ctl';
        if (!e || !ST || !ST[k]) return;
        const tous = ST[k].its;
        const comp = composition(tous);
        const ct = t ? comp.find(c => c.tableau === t) : null;
        const cg = (ct && g) ? ct.groupes.find(x => x.groupe === g) : null;
        const its = cg ? cg.its : ct ? ct.its : tous;
        const niveau = cg ? 3 : ct ? 2 : 1;
        const r = resumeLot(its, k);

        // Le fil : étape › tableau › groupe. Le dernier maillon est l'endroit
        // où l'on est ; les précédents ramènent à leur niveau.
        const maillon = (texte, actif, vt, vg) => actif
            ? '<b>' + esc(texte) + '</b>'
            : '<button type="button" class="op-lien" data-vers="1" data-t="' + esc(vt || '') + '" data-g="'
              + esc(vg || '') + '">' + esc(texte) + '</button>';
        const fil = '<nav class="op-fil" aria-label="Niveau affiché">'
            + maillon(e.n, niveau === 1, '', '')
            + (ct ? '<span aria-hidden="true">›</span>' + maillon(ct.tableau, niveau === 2, ct.tableau, '') : '')
            + (cg ? '<span aria-hidden="true">›</span>' + maillon(cg.groupe, true) : '')
            + '</nav>';
        const chiffres = '<p class="op-lot-total"><b>' + nb(r.n) + ' factures</b> · ' + eur(r.mt) + ' de restant dû'
            + (ctl ? ' · dont ' + nb(r.nEch) + ' à échéance sous ' + CONTROLE.proche + ' jours (' + eur(r.mtEch) + ')'
                     + ' · échéance médiane dans ' + (r.age == null ? '—' : nb(r.age) + ' j')
                   : ' · dont ' + nb(r.nEch) + ' échues (' + eur(r.mtEch) + ')'
                     + ' · âge médian dans l’étape ' + (r.age == null ? '—' : nb(r.age) + ' j')
                     + ' pour une cible de ' + e.cible + ' j') + '</p>';

        const enTete = (premier, dernier) => '<thead><tr><th>' + premier + '</th><th class="n">Factures</th>'
            + '<th class="n">Restant dû</th><th class="n">Part</th>'
            + (ctl ? '<th class="n">Échéance sous ' + CONTROLE.proche + ' j</th><th class="n">Échéance médiane dans</th>'
                   : '<th class="n">Dont échues</th><th class="n">Âge médian</th><th class="n">% hors délai</th>')
            + '<th>' + dernier + '</th></tr></thead>';
        const ligne = (nom, lot, total, vt, vg, dernier) => { const x = resumeLot(lot, k);
            return '<tr class="op-nav" data-vers="1" data-t="' + esc(vt) + '" data-g="' + esc(vg || '') + '">'
                + '<td><button type="button" class="op-lien">' + esc(nom) + '</button></td>'
                + '<td class="n">' + nb(x.n) + '</td><td class="n">' + eur(x.mt) + '</td>'
                + '<td class="n">' + nb(total ? x.n / total * 100 : 0) + ' %</td>'
                + '<td class="n">' + nb(x.nEch) + '<br><span class="op-pied">' + eur(x.mtEch) + '</span></td>'
                + '<td class="n">' + (x.age == null ? '—' : nb(x.age) + ' j') + '</td>'
                + (ctl ? '' : '<td class="n">' + (x.hd == null ? '—' : '<span class="op-chip '
                    + (x.hd >= 60 ? 'mauvais' : x.hd >= 30 ? 'moyen' : 'bon') + '">' + nb(x.hd) + ' %</span>') + '</td>')
                + '<td>' + dernier + '</td></tr>'; };

        let corps, aide;
        if (niveau === 1) {
            aide = (ctl ? 'Les factures non réglées dont l’échéance calculée n’est pas encore passée'
                    + (CONTROLE.horsEtapes ? ' et qui ne sont dans aucune étape du circuit (groupes « en cours »).'
                        : ', où qu’elles soient rangées dans Monday.')
                    + ' Rien n’y est en retard : c’est ce qui arrive à échéance.' : noteEtape(k))
                + ' Cliquez un tableau pour voir ses groupes.';
            corps = '<table class="op-t">' + enTete('Tableau Monday', 'Groupes concernés') + '<tbody>'
                + comp.map(c => ligne(c.tableau, c.its, r.n, c.tableau, '',
                    nb(c.groupes.length) + ' groupe' + (c.groupes.length > 1 ? 's' : ''))).join('')
                + '</tbody></table>';
        } else if (niveau === 2) {
            aide = 'Les groupes du tableau « ' + ct.tableau + ' » qui comptent dans « ' + e.n
                + ' ». Cliquez un groupe pour voir ses factures.';
            corps = '<table class="op-t">' + enTete('Groupe Monday', ctl ? 'Étape du groupe' : 'Problématique la plus fréquente')
                + '<tbody>'
                + ct.groupes.map(x => { const cat = categorieDuGroupe(x.groupe);
                    return ligne(x.groupe, x.its, r.n, ct.tableau, x.groupe,
                        ctl ? esc(cat && ETAPE[cat] ? ETAPE[cat].n : cat === 'cours' ? 'En cours' : 'Non classé')
                            : esc(problematiquePrincipale(x.its))); }).join('')
                + '</tbody></table>';
        } else {
            aide = 'Les factures non réglées du groupe « ' + cg.groupe + ' », tableau « ' + ct.tableau + ' », '
                + (ctl ? 'de l’échéance la plus proche à la plus lointaine.' : 'des plus gros montants aux plus petits.');
            const tri = its.slice().sort(ctl ? (a, b) => joursAvant(a) - joursAvant(b)
                                             : (a, b) => montantDe(b) - montantDe(a));
            corps = '<table class="op-t"><thead><tr><th>Facture · client</th><th>Financement</th>'
                + '<th>Problématique</th><th class="n">Restant dû</th><th class="n">Échéance</th>'
                + '<th class="n">' + (ctl ? 'Échéance dans' : 'Dans l’étape depuis') + '</th><th>Propriétaire</th></tr></thead><tbody>'
                + tri.slice(0, LIGNES_MAX).map(f => { const rt = retard(f), a = ctl ? joursAvant(f) : ageEtape(f, k).j;
                    const ech = f.dateEcheance || f.dateEcheanceSource;
                    return '<tr><td>' + lienMonday(f)
                        + ((f.client && f.client !== '—') || f.apprenant ? '<br><span class="op-pied">'
                            + esc(f.client && f.client !== '—' ? f.client : f.apprenant) + '</span>' : '')
                        + '</td><td>' + esc(f.financement || '—') + '</td>'
                        + '<td>' + esc(f.problematique || '—') + '</td>'
                        + '<td class="n">' + eur(montantDe(f)) + '</td>'
                        + '<td class="n">' + (ech ? U().dateFR(ech) + (rt != null && rt > 0
                                ? '<br><span class="op-pied">dépassée de ' + rt + ' j</span>' : '')
                            : '<span class="op-acompleter">à qualifier</span>') + '</td>'
                        + '<td class="n">' + (a == null ? '—' : a + ' j'
                            + (ctl ? (a <= CONTROLE.proche ? '<br><span class="op-chip moyen">bientôt</span>' : '')
                                   : (a > e.cible ? '<br><span class="op-chip moyen">hors délai</span>' : ''))) + '</td>'
                        + '<td>' + esc(f.proprietaire && f.proprietaire !== '—' ? f.proprietaire : '—') + '</td></tr>';
                  }).join('')
                + '</tbody></table>'
                + (tri.length > LIGNES_MAX ? '<p class="op-pied">Les ' + LIGNES_MAX + ' premières lignes sur '
                    + nb(tri.length) + '. « Exporter en Excel » donne toutes les lignes.</p>' : '');
        }

        const titre = e.n + (ct ? ' — ' + ct.tableau : '') + (cg ? ' — ' + cg.groupe : '');
        const hote = U().modal(e.n + ' · ' + e.svc,
            fil + '<p class="op-pied op-lot-note">' + esc(aide) + '</p>' + chiffres
            + '<div class="table-wrap">' + corps + '</div>', [
            { label: 'Exporter ces factures en Excel', close: false, onClick: () => exporterLot(titre, its) },
            { label: 'Fermer', primary: true },
        ], { large: true });
        if (!hote) return;
        hote.querySelectorAll('[data-vers]').forEach(el => el.onclick = () =>
            montrerEtape(k, el.dataset.t || '', el.dataset.g || ''));
        hote.scrollTop = 0;
    }

    // Comment le nombre d'une étape est constitué, en une phrase.
    function noteEtape(k) {
        const e = ETAPE[k];
        return 'Étape « ' + e.n + ' » (' + e.svc + ') : les factures non réglées rangées dans les groupes Monday '
            + groupesDeLEtape(k).join(', ') + ' (classement modifiable dans l’onglet « Règles d’application »). Les factures réglées, les avoirs et les groupes « en cours » '
            + 'ou techniques n’y sont pas comptés.';
    }

    // ═════════ rendu ═════════
    function vignetteEtape(st, k, fleche) {
        const s = st[k], e = ETAPE[k];
        // D'où vient le nombre : un tableau Monday par ligne, avec son compte.
        const comp = composition(s.its);
        const ou = comp.length
            ? '<span class="op-ou"><span class="op-ou-t">Dans quels tableaux Monday</span>'
              + comp.map(c => '<span class="op-ou-l"><span>' + esc(c.tableau) + '</span>'
                  + ouvrableEtape(nb(c.its.length), k, c.tableau) + '</span>').join('')
              + '</span>'
            : '';
        return '<div class="op-fcard" data-carte="' + k + '">'
            + '<span class="op-ft">' + ouvrableEtape(esc(e.n), k) + '<span>' + esc(e.svc) + '</span></span>'
            + '<span class="op-fs op-fdesc">' + esc(e.d) + '</span>'
            + '<span class="op-fbig">' + ouvrableEtape(nb(s.st), k) + ' <small>factures</small></span>'
            + '<span class="op-fs">' + eur(s.mt) + ' de restant dû</span>'
            + '<span class="op-fs">âge médian du traitement <b>' + (s.a == null ? '—' : nb(s.a) + ' j')
            + '</b> · cible ' + e.cible + ' j</span>'
            + (s.h == null ? '' : '<span class="op-chip ' + (s.h >= 60 ? 'mauvais' : s.h >= 30 ? 'moyen' : 'bon')
                + '">' + nb(s.h) + ' % hors délai</span>')
            + ou
            + '<button type="button" class="btn btn-ghost btn-sm op-fdetail" data-etape="' + k
            + '">Détail de l’étape</button>'
            + '</div>' + (fleche ? '<div class="op-fleche" aria-hidden="true">→</div>' : '');
    }

    function tableauCircuit(items, st) {
        const mx = Math.max(...CIRCUIT.map(e => st[e.k].mt), 1);
        const barre = (p, c) => '<span class="op-mini"><i style="width:'
            + Math.max(0, Math.min(100, p)).toFixed(1) + '%;background:' + c + '"></i></span>';
        let h = '<table class="op-t"><thead><tr><th>Étape du process</th><th class="n">Factures</th>'
            + '<th class="n">Montant</th><th class="n">Entrées</th><th class="n">Sorties</th>'
            + '<th class="n">Âge médian du traitement</th><th class="n">Cible</th>'
            + '<th class="n">% hors délai</th></tr></thead><tbody>';
        let tSt = 0, tMt = 0, tE = 0, tS = 0;
        // Sans le journal, la case dit pourquoi elle est vide et comment la remplir.
        const sansHist = '<button type="button" class="op-lien op-lire-hist" title="Les entrées et sorties se '
            + 'lisent dans le journal de Monday : cliquez pour les charger.">à lire</button>';
        for (const e of CIRCUIT) {
            const s = st[e.k], ouvert = !!F.deplies[e.k];
            const fl = HIST ? HIST.par[e.k] : null;
            tSt += s.st; tMt += s.mt; if (fl) { tE += fl.e; tS += fl.s; }
            h += '<tr><td><button class="op-tog" data-deplie="' + e.k + '" aria-expanded="' + ouvert + '">'
               + (ouvert ? '▾ ' : '▸ ') + esc(e.n) + '</button>'
               + '<br><span class="op-pied">' + esc(e.d) + '</span></td>'
               + '<td class="n">' + ouvrableEtape(nb(s.st), e.k) + '</td>'
               + '<td class="n">' + eur(s.mt) + barre(s.mt / mx * 100, 'var(--serie-2)') + '</td>'
               + '<td class="n">' + (fl ? nb(fl.e) : sansHist) + '</td>'
               + '<td class="n">' + (fl ? nb(fl.s) : sansHist) + '</td>'
               + '<td class="n">' + (s.a == null ? '—' : nb(s.a) + ' j') + '</td>'
               + '<td class="n">' + e.cible + ' j</td>'
               + '<td class="n">' + (s.h == null ? '—' : nb(s.h) + ' %'
                    + barre(s.h, s.h >= 60 ? 'var(--red)' : s.h >= 30 ? 'var(--amber)' : 'var(--green)')) + '</td></tr>';
            if (ouvert) {
                // D'abord où sont ces factures dans Monday : tableau, puis groupe.
                h += '<tr class="op-sous op-sous-titre"><td colspan="8">Où sont ces factures dans Monday — '
                   + 'tableau, puis groupe</td></tr>';
                composition(s.its).forEach(c => {
                    const mT = somme(c.its, montantDe);
                    h += '<tr class="op-sous op-sous-tableau"><td>' + esc(c.tableau) + '</td><td class="n">'
                       + ouvrableEtape(nb(c.its.length), e.k, c.tableau)
                       + '</td><td class="n">' + eur(mT) + barre(mT / mx * 100, 'var(--text-muted)') + '</td>'
                       + '<td class="n" colspan="5"></td></tr>';
                    c.groupes.forEach(gr => {
                        const mG = somme(gr.its, montantDe);
                        const agesG = gr.its.map(f => ageEtape(f, e.k).j).filter(j => j != null);
                        const hdG = agesG.length ? agesG.filter(j => j > e.cible).length / agesG.length * 100 : null;
                        h += '<tr class="op-sous op-sous-groupe"><td>' + esc(gr.groupe) + '</td><td class="n">'
                           + ouvrableEtape(nb(gr.its.length), e.k, c.tableau, gr.groupe)
                           + '</td><td class="n">' + eur(mG) + '</td><td class="n"></td><td class="n"></td>'
                           + '<td class="n">' + (mediane(agesG) == null ? '—' : nb(mediane(agesG)) + ' j') + '</td>'
                           + '<td class="n">' + e.cible + ' j</td>'
                           + '<td class="n">' + (hdG == null ? '—' : nb(hdG) + ' %') + '</td></tr>';
                    });
                });
                h += '<tr class="op-sous op-sous-titre"><td colspan="8">Les mêmes factures, par problématique '
                   + 'pré-échéance</td></tr>';
                const g = {};
                s.its.forEach(f => { const t = (f.problematique || '').trim() || 'Problématique non renseignée';
                    (g[t] || (g[t] = [])).push(f); });
                Object.keys(g).sort((a, b) => g[b].length - g[a].length).forEach(t => {
                    const arr = g[t];
                    const ages = arr.map(f => ageEtape(f, e.k).j).filter(j => j != null);
                    const hd = ages.length ? ages.filter(j => j > e.cible).length / ages.length * 100 : null;
                    const m2 = somme(arr, montantDe);
                    h += '<tr class="op-sous"><td>' + esc(t) + '</td><td class="n">'
                       + ouvrable(nb(arr.length), e.n + ' — ' + t, arr,
                            'Factures de l’étape « ' + e.n + ' » dont la problématique pré-échéance est « ' + t + ' ».')
                       + '</td>'
                       + '<td class="n">' + eur(m2) + barre(m2 / mx * 100, 'var(--text-muted)') + '</td>'
                       + '<td class="n"></td><td class="n"></td>'
                       + '<td class="n">' + (mediane(ages) == null ? '—' : nb(mediane(ages)) + ' j') + '</td>'
                       + '<td class="n">' + e.cible + ' j</td>'
                       + '<td class="n">' + (hd == null ? '—' : nb(hd) + ' %') + '</td></tr>';
                });
            }
        }
        h += '<tr class="total"><td>Total circuit</td><td class="n">'
           + ouvrable(nb(tSt), 'Toutes les factures du circuit', items,
                'Les factures non réglées des quatre étapes du circuit.') + '</td>'
           + '<td class="n">' + eur(tMt) + '</td>'
           + '<td class="n">' + (HIST ? nb(tE) : '—') + '</td>'
           + '<td class="n">' + (HIST ? nb(tS) : '—') + '</td>'
           + '<td class="n"></td><td class="n"></td><td class="n"></td></tr>';
        return h + '</tbody></table>';
    }

    function blocSorties() {
        if (histEtat.s === 'run')
            return '<div class="op-vide">' + esc(histEtat.msg || 'Lecture de l’historique Monday…') + '</div>';
        if (histEtat.s === 'error')
            return '<div class="op-vide">L’historique n’a pas pu être lu : ' + esc(histEtat.msg)
                 + '<br><br><button class="btn btn-sm" id="op-hist">Réessayer</button></div>';
        if (!HIST)
            return '<div class="op-vide">Les entrées, les sorties et leurs destinations se lisent dans le '
                 + 'journal de Monday, à la demande : claude.ai vous demande d’autoriser le connecteur '
                 + 'monday.com la première fois.<br><br>'
                 + '<button class="btn btn-primary btn-sm" id="op-hist">Lire les entrées et sorties du mois '
                 + 'dans Monday</button></div>';
        const TEINTES = ['var(--serie-1)', 'var(--serie-2)', 'var(--serie-3)', 'var(--serie-4)',
                         'var(--serie-5)', 'var(--serie-6)'];
        let h = '';
        for (const e of CIRCUIT) {
            const fl = HIST.par[e.k];
            const noms = Object.keys(fl.dest).sort((a, b) => fl.dest[b] - fl.dest[a]);
            if (!fl.s) { h += '<div class="op-stk"><div class="op-stk-h"><b>' + esc(e.n) + '</b>'
                + '<span class="op-pied">aucune sortie sur le mois</span></div></div>'; continue; }
            const seg = noms.map((n, i) => { const p = fl.dest[n] / fl.s * 100;
                return '<div style="width:' + p.toFixed(2) + '%;background:' + TEINTES[i % TEINTES.length]
                     + '" title="' + esc(n + ' : ' + fl.dest[n] + ' factures')
                     + '">' + (p >= 9 ? Math.round(p) + ' %' : '') + '</div>'; }).join('');
            const leg = noms.map((n, i) => '<span><i class="op-sw" style="background:'
                + TEINTES[i % TEINTES.length] + '"></i>' + esc(n) + ' — ' + nb(fl.dest[n])
                + ' factures · ' + nb(fl.dest[n] / fl.s * 100) + ' %</span>').join('');
            h += '<div class="op-stk"><div class="op-stk-h"><b>' + esc(e.n) + '</b>'
               + '<span class="op-pied">' + nb(fl.s) + ' factures sorties</span></div>'
               + '<div class="op-stk-bar">' + seg + '</div><div class="op-legende">' + leg + '</div></div>';
        }
        return h;
    }

    // Les lignes à traiter en premier : montant d'abord, ancienneté du retard
    // ensuite. Une facture sans échéance n'est pas prioritaire — elle est à
    // qualifier, et elle le dit.
    function priorisees(its, k) {
        return its.map(f => {
            const a = ageEtape(f, k), r = retard(f), m = montantDe(f);
            const tags = [];
            if (r != null && r > 0) tags.push(['échue de ' + r + ' j', r > 90 ? 'mauvais' : r > 30 ? 'moyen' : '']);
            if (!f.dateEcheance && !f.dateEcheanceSource) tags.push(['échéance à qualifier', 'moyen']);
            if (f.promesse) tags.push([new Date(f.promesse) < auj() ? 'promesse dépassée' : 'paiement promis',
                                       new Date(f.promesse) < auj() ? 'mauvais' : 'bon']);
            if (a.j != null && a.j > ETAPE[k].cible) tags.push(['hors délai', 'moyen']);
            const score = (m || 0) * (1 + Math.max(0, (r == null ? 0 : r)) / 180);
            return { f, a: a.j, r, m, tags, score };
        }).sort((x, y) => y.score - x.score);
    }

    function rendre(factures) {
        const hote = document.getElementById('op-corps');
        if (!hote) return;
        LOTS = [];
        DERNIERES = factures || [];
        const items0 = ouvertes(factures);
        const q = F.q.trim().toLowerCase();
        const items = !q ? items0 : items0.filter(f =>
            [f.numero, f.client, f.apprenant, f.groupe].some(v => String(v || '').toLowerCase().includes(q)));
        const st = {}; CIRCUIT.forEach(e => { st[e.k] = statsEtape(items, e.k); });
        // Avant le circuit : tout ce qui n'est pas encore arrivé à échéance.
        const ctl0 = sousControle(factures);
        const ctl = !q ? ctl0 : ctl0.filter(f =>
            [f.numero, f.client, f.apprenant, f.groupe].some(v => String(v || '').toLowerCase().includes(q)));
        st.ctl = { its: ctl, st: ctl.length, mt: somme(ctl, montantDe) };
        const oubliees0 = echuesEnCours(factures);
        const oubliees = !q ? oubliees0 : oubliees0.filter(f =>
            [f.numero, f.client, f.apprenant, f.groupe].some(v => String(v || '').toLowerCase().includes(q)));
        ST = st;
        const avecEntree = items.filter(f => !!f.dateEtape).length;
        const horsCircuit = nonClassees(factures);

        // ── le portefeuille ──
        const tousOuverts = items;
        const ech = tousOuverts.filter(f => { const r = retard(f); return r != null && r > 0; });
        const nonEch = tousOuverts.filter(f => { const r = retard(f); return r != null && r <= 0; });
        const sans = tousOuverts.filter(f => retard(f) == null);
        const tot = somme(tousOuverts, montantDe);
        // Le libellé, la valeur et la ligne du dessous s'empilent dans .kpi-data :
        // posés à même la carte, ils s'alignaient sur une ligne et se coupaient.
        const tuile = (l, v, s, ton) => '<div class="kpi-card op-tuile' + (ton ? ' ' + ton : '') + '">'
            + '<div class="kpi-data"><span class="kpi-label">' + esc(l) + '</span>'
            + '<span class="kpi-value">' + v + '</span>'
            + '<span class="kpi-sub">' + s + '</span></div></div>';
        const portefeuille = '<div class="kpi-grid">'
            + tuile('Reste à encaisser', eur(tot), ouvrable(nb(tousOuverts.length) + ' factures',
                'Reste à encaisser — le circuit', tousOuverts,
                'Toutes les factures non réglées que le circuit suit, échues ou non.') + ' ouvertes dans le circuit')
            + tuile('En recouvrement', eur(somme(ech, montantDe)), ouvrable(nb(ech.length) + ' factures',
                'En recouvrement — échues et non réglées', ech,
                'Factures du circuit dont l’échéance calculée est dépassée et qui ne sont pas réglées.')
                + ' échues · ' + nb(tot ? somme(ech, montantDe) / tot * 100 : 0) + ' % du reste')
            + tuile('Non échu', eur(somme(nonEch, montantDe)), ouvrable(nb(nonEch.length) + ' factures',
                'Non échu', nonEch, 'Factures du circuit dont l’échéance n’est pas encore passée.')
                + ' pas encore exigibles')
            // À zéro, la tuile n'a rien à dire : elle ne s'affiche que s'il y
            // a des dates à compléter, et elle s'ouvre alors sur leur saisie.
            + (sans.length ? tuile('Échéance à qualifier', eur(somme(sans, montantDe)),
                ouvrable(nb(sans.length) + ' factures', 'Échéance à qualifier', sans,
                'Factures du circuit dont l’échéance ne peut pas être calculée : une date manque dans Monday. '
                + 'Saisissez-la ici pour que l’échéance se calcule.', { completer: true })
                + ' dont la date manque — cliquez pour la compléter') : '')
            + '</div>';

        // ── le focus ──
        const k = ETAPE[F.etape] ? F.etape : 'adv';
        const e = ETAPE[k], s = st[k];
        const srcs = { etape: 0, ref: 0, aucune: 0 };
        s.its.forEach(f => { srcs[ageEtape(f, k).src]++; });
        const prom = s.its.filter(f => f.promesse);
        const promKO = prom.filter(f => new Date(f.promesse) < auj());
        const echK = s.its.filter(f => { const r = retard(f); return r != null && r > 0; });
        // La promesse de paiement n'est saisie que sur l'ADV, le Recouvrement et
        // le Financement personnel. Ailleurs la tuile le dit plutôt que
        // d'afficher un zéro qui passerait pour « aucune promesse ».
        const portePromesse = ['adv', 'rec'].indexOf(k) >= 0 || prom.length > 0;
        const horsDelai = s.its.filter(f => { const a = ageEtape(f, k).j; return a != null && a > e.cible; });
        const quatrieme = k === 'adv'
            ? ['Échues encore à l’ADV', ouvrable(nb(echK.length), 'Échues encore à l’ADV', echK,
                    'Factures de l’étape « Rendre payable » dont l’échéance est déjà dépassée.')
                    + ' · ' + eur(somme(echK, montantDe)),
               'en retard sans avoir été rendues payables']
            : portePromesse
            ? ['Promesses de paiement', ouvrable(nb(prom.length), 'Promesses de paiement — ' + e.n, prom,
                    'Factures de l’étape qui portent une date de paiement promis.'),
               ouvrable(nb(promKO.length), 'Promesses dépassées — ' + e.n, promKO,
                    'Factures de l’étape dont la date de paiement promis est passée.') + ' dont la date est passée']
            : ['Promesses de paiement', '<span class="op-acompleter">à compléter</span>',
               'ces tableaux ne portent pas de colonne de paiement promis'];
        const tuilesFocus = '<div class="kpi-grid">'
            + tuile('Dans l’étape', ouvrableEtape(nb(s.st), k) + ' · ' + eur(s.mt),
                HIST ? nb(HIST.par[k].e) + ' entrées, ' + nb(HIST.par[k].s) + ' sorties sur le mois'
                     : 'factures non réglées de cette étape')
            + tuile('Âge médian du traitement', (s.a == null ? '—' : nb(s.a) + ' j'),
                'cible ' + e.cible + ' j · ' + (s.h == null ? '—' : nb(s.h) + ' % hors délai'))
            + tuile('Montant hors délai', eur(somme(horsDelai, montantDe)),
                ouvrable(nb(horsDelai.length) + ' factures', 'Hors délai — ' + e.n, horsDelai,
                    'Factures de l’étape qui y attendent depuis plus de ' + e.cible + ' jours.')
                + ' depuis plus de ' + e.cible + ' jours')
            + tuile(quatrieme[0], quatrieme[1], quatrieme[2])
            + '</div>';

        // par tableau et groupe Monday : le groupe garde son numéro, qui dit
        // à lui seul de quel tableau il vient, et le tableau est écrit dessous.
        const lignesG = [];
        composition(s.its).forEach(c => c.groupes.forEach(gr => lignesG.push({ t: c.tableau, g: gr.groupe, its: gr.its })));
        lignesG.sort((a, b) => b.its.length - a.its.length);
        const mxG = Math.max(...lignesG.map(x => x.its.length), 1);
        const barres = lignesG.map(x =>
            '<div class="op-hb"><span class="op-hb-nom" title="' + esc(x.g + ' — ' + x.t) + '">' + esc(x.g)
            + '<small>' + esc(x.t) + '</small></span>'
            + '<span class="op-track"><i style="width:' + (x.its.length / mxG * 100).toFixed(1)
            + '%;background:var(--serie-2)"></i></span>'
            + '<span class="op-v">' + ouvrableEtape(nb(x.its.length), k, x.t, x.g) + '</span></div>').join('');

        // l'âge dans l'étape
        const BK = { adv: [5, 10, 20, 30], rec: [15, 30, 90, 180], fin: [90, 180, 365, 730],
                     cor: [15, 30, 60, 120] }[k];
        const libs = ['0-' + BK[0] + ' j', (BK[0] + 1) + '-' + BK[1] + ' j', (BK[1] + 1) + '-' + BK[2] + ' j',
                      (BK[2] + 1) + '-' + BK[3] + ' j', '> ' + BK[3] + ' j'];
        const cpt = [0, 0, 0, 0, 0], parTranche = [[], [], [], [], []];
        s.its.forEach(f => { const a = ageEtape(f, k).j; if (a == null) return;
            const i = a <= BK[0] ? 0 : a <= BK[1] ? 1 : a <= BK[2] ? 2 : a <= BK[3] ? 3 : 4;
            cpt[i]++; parTranche[i].push(f); });
        const mxB = Math.max(...cpt, 1);
        const hist = cpt.map((v, i) => { const bas = i === 0 ? 0 : BK[i - 1];
            return '<div class="op-col"><span class="op-col-v">' + ouvrable(nb(v), e.n + ' — depuis ' + libs[i],
                    parTranche[i], 'Factures de l’étape qui y sont depuis ' + libs[i] + '.') + '</span>'
                 + '<i style="height:' + (v / mxB * 100).toFixed(1) + '%;background:'
                 + (bas >= e.cible ? 'var(--red)' : 'var(--serie-2)') + '"></i>'
                 + '<span class="op-col-l">' + libs[i] + '</span></div>'; }).join('');

        // la liste priorisée
        // VERSION 3 — cinq lignes visibles, le reste défile ; trois pastilles
        // pour ne garder que les grosses factures ou les retards longs ; et
        // l'export donne exactement la liste affichée.
        const prTout = priorisees(s.its, k);
        const FILTRES_LISTE = [['tout', 'Toutes', () => true], ['m10k', 'Plus de 10 000 €', p => p.m > 10000],
            ['r90', 'Plus de 90 jours de retard', p => p.r != null && p.r > 90],
            ['r360', 'Plus de 360 jours de retard', p => p.r != null && p.r > 360]];
        const filtreListe = FILTRES_LISTE.find(x => x[0] === LISTE_FILTRE) || FILTRES_LISTE[0];
        const prListe = prTout.filter(filtreListe[2]);
        LISTE_COURANTE = { pr: prListe, k: k, nom: filtreListe[0] };
        const pastillesListe = '<div class="pil-vues">' + FILTRES_LISTE.map(x =>
            '<button type="button" class="pil-vue' + (x[0] === filtreListe[0] ? ' active' : '') + '" data-liste-filtre="' + x[0] + '">'
            + x[1] + ' <span class="op-cnt">' + nb(prTout.filter(x[2]).length) + '</span></button>').join('') + '</div>';
        const pr = prTout, top = prListe.slice(0, 500);
        const lien = lienMonday;
        const lignes = top.map(p => { const f = p.f;
            return '<tr><td>' + lien(f)
                 + ((f.client && f.client !== '—') || f.apprenant
                    ? '<br><span class="op-pied">' + esc(f.client !== '—' ? f.client : f.apprenant) + '</span>' : '')
                 + '</td><td>' + esc(f.financement || '—') + '</td>'
                 + '<td>' + esc(groupeDe(f))
                 + '<br><span class="op-pied">' + esc(tableauDe(f))
                 + (f.problematique ? ' · ' + esc(f.problematique) : '') + '</span></td>'
                 + '<td class="n">' + eur(p.m) + '</td>'
                 + '<td class="n">' + (f.dateEcheance || f.dateEcheanceSource
                        ? U().dateFR(f.dateEcheance || f.dateEcheanceSource)
                          + (p.r != null ? '<br><span class="op-pied">' + (p.r > 0 ? 'dépassée de ' + p.r + ' j'
                             : p.r === 0 ? 'aujourd’hui' : 'dans ' + (-p.r) + ' j') + '</span>' : '')
                        : '<span class="op-acompleter">à qualifier</span>') + '</td>'
                 + '<td class="n">' + (p.a == null ? '—' : p.a + ' j') + '</td>'
                 + '<td><span class="op-tags">' + p.tags.map(t =>
                        '<span class="op-chip ' + t[1] + '">' + esc(t[0]) + '</span>').join('') + '</span></td></tr>';
        }).join('');

        const sousTabs = CIRCUIT.map(x => '<button class="seg-btn' + (x.k === k ? ' active' : '')
            + '" data-focus="' + x.k + '">' + esc(x.n) + ' <span class="op-cnt">' + nb(st[x.k].st)
            + '</span></button>').join('');

        hote.innerHTML =
            '<p class="aide-bloc">Ce qu’il faut traiter, étape par étape du circuit. Les actions se font dans '
          + 'Monday. Les factures réglées, les avoirs et les groupes « en cours » n’entrent pas dans le circuit. '
          + '<strong>Chaque nombre souligné s’ouvre</strong> : il montre les factures qu’il compte, avec leur '
          + 'tableau et leur groupe Monday.</p>'
          + '<div class="table-toolbar"><div class="table-toolbar-right">'
          + '<input type="search" id="op-q" class="op-rech" placeholder="Facture, client, groupe" value="'
          + esc(F.q) + '">'
          + '<button class="btn btn-ghost btn-sm" id="op-export">Exporter l’étape</button>'
          + '</div></div>'
          + portefeuille
          + '<div class="charts-grid"><div class="chart-card chart-wide">'
          + '<div class="chart-header"><h3>1 · Le circuit</h3></div>'
          + '<p class="pil-note">Combien de factures à chaque étape, depuis combien de temps elles y sont, '
          + 'face à la cible de traitement.</p>'
          + '<div class="op-flow op-flow-ctl">' + vignetteControle(st.ctl, items, oubliees) + '</div>'
          + '<div class="op-sep"><span></span>à l’échéance, la facture non réglée entre dans le circuit<span></span></div>'
          + '<div class="op-flow">' + vignetteEtape(st, 'adv', true) + vignetteEtape(st, 'rec', true)
          + vignetteEtape(st, 'fin') + '</div>'
          + '<div class="op-sep"><span></span>en parallèle du circuit<span></span></div>'
          + '<div class="op-flow">' + vignetteEtape(st, 'cor') + '</div>'
          + '<div class="op-sub"><b>Les étapes du process</b>'
          + '<span class="op-pied">Âge du traitement = jours depuis l’entrée dans l’étape quand Monday '
          + 'porte la date — ' + nb(avecEntree) + ' factures sur ' + nb(items.length) + ' — sinon depuis '
          + 'la date de facture (Rendre payable) ou l’échéance (les autres). Les tableaux Tampon, ADV et '
          + 'Recouvrement n’ont pas de colonne de date d’entrée : sur eux, le « % hors délai » mesure '
          + 'l’ancienneté de la créance, pas le temps de traitement du service. '
          + '<strong>Dépliez une étape (▸)</strong> pour voir dans quels tableaux et groupes Monday se trouvent '
          + 'ses factures, puis leur problématique pré-échéance.</span>'
          + tableauCircuit(items, st) + '</div>'
          + '<div class="op-sub"><b>Où sont parties les factures sorties d’une étape</b>'
          + '<span class="op-pied">' + (HIST ? 'Déplacements du ' + U().dateFR(new Date(HIST.de)) + ' au '
              + U().dateFR(new Date(HIST.au)) + ', lus dans le journal de Monday le '
              + new Date(HIST.le).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })
              + ' · ' + nb(HIST.lus) + ' déplacements. Une entrée est une facture arrivée dans un groupe de '
              + 'l’étape ; une sortie, une facture qui l’a quitté.'
              + (HIST.tronque ? ' Le journal est très long : la lecture a été arrêtée avant la fin, les '
                  + 'nombres sont un minimum.' : '') : '') + '</span>'
          + blocSorties() + '</div></div></div>'
          + '<div id="v3-op-edof"></div>'
          + '<div class="charts-grid"><div class="chart-card chart-wide">'
          + '<details class="v3-pli" id="op-focus-pli"' + (FOCUS_OUVERT ? ' open' : '') + '><summary><h3>2 · Focus sur chaque étape</h3>'
          + '<span class="pil-coin">Quoi traiter, pourquoi ça bloque, et est-ce que ça avance.</span></summary>'
          + '<div class="seg" id="op-seg">' + sousTabs + '</div>'
          + '<p class="op-focus-h"><b>' + esc(e.n) + '</b> · ' + esc(e.d)
          + ' <span class="op-chip">' + esc(e.svc) + '</span></p>'
          + tuilesFocus
          + '<div class="charts-grid charts-grid-2">'
          + '<div class="op-sub"><b>Où sont les factures</b>'
          + '<span class="op-pied">Nombre de factures par groupe Monday, avec le tableau dessous. '
          + 'Cliquez un nombre pour voir les factures.</span>'
          + '<div class="op-hbs">' + barres + '</div></div>'
          + '<div class="op-sub"><b>Depuis combien de temps elles sont dans l’étape</b>'
          + '<span class="op-pied">En rouge, au-delà de la cible de ' + e.cible + ' jours. '
          + 'Date d’entrée : colonne Monday pour ' + nb(srcs.etape) + ' factures, à défaut '
          + (e.ref === 'facture' ? 'date de facture' : 'échéance') + ' pour ' + nb(srcs.ref)
          + (srcs.aucune ? ', et ' + nb(srcs.aucune) + ' sans aucune date' : '') + '.</span>'
          + '<div class="op-chart">' + hist + '</div></div></div>'
          + '<div class="op-sub"><b>Liste priorisée</b>'
          + '<span class="op-pied">' + nb(prListe.length) + ' facture' + (prListe.length > 1 ? 's' : '') + ' · '
          + eur(prListe.reduce((t, p) => t + (p.m || 0), 0)) + ', classées par montant et ancienneté du retard. '
          + 'Cinq lignes visibles : faites défiler pour voir les autres.'
          + (prListe.length > 500 ? ' Les 500 premières sont affichées ; l’export les donne toutes.' : '') + '</span>'
          + pastillesListe
          + '<p><button type="button" class="btn btn-ghost btn-sm" id="op-export-liste">Exporter cette liste (Excel)</button></p>'
          + (top.length ? '<div class="op-defile"><table class="op-t"><thead><tr><th>Facture · client</th><th>Financement</th>'
              + '<th>Groupe Monday</th><th class="n">Restant dû</th><th class="n">Échéance</th>'
              + '<th class="n">Dans l’étape depuis</th><th>Priorité</th></tr></thead><tbody>'
              + lignes + '</tbody></table></div>'
            : '<div class="op-vide">Aucune facture dans cette étape avec ces filtres.</div>')
          + '</div></details></div></div>'
          + '<div class="charts-grid"><div class="chart-card chart-wide" id="op-correspondance">'
          + (horsCircuit.length ? '<p class="op-alerte">' + ouvrable(nb(horsCircuit.length) + ' factures non réglées',
                'Factures dans un groupe non classé', horsCircuit,
                'Ces factures sont dans un groupe Monday qu’aucune étape ne range : elles ne sont comptées nulle part '
                + 'dans le circuit.') + ' se trouvent dans un groupe qu’aucune étape ne range. '
                + 'Elles ne sont comptées dans aucun des nombres ci-dessus.</p>' : '')
          + '<p class="pil-note">Quel groupe Monday compte dans quelle étape, avec le nombre de factures non réglées de chaque groupe : '
          + 'c’est dans <button type="button" class="op-lien" data-vers-regles="1">Contrôles › Règles d’application</button>, '
          + 'règle « Circuit — dans quelle vignette compte chaque groupe Monday ».</p>'
          + '</div></div>';

        brancher(items, st, k, pr);
    }

    function brancher(items, st, k, pr) {
        const h = document.getElementById('op-corps');
        if (!h) return;
        // Le circuit CPF d'après EDOF se pose juste sous le circuit général.
        try { if (global.LioraV3 && global.LioraV3.carteEdof) global.LioraV3.carteEdof(); } catch (e) { /* le circuit reste lisible sans lui */ }
        h.querySelectorAll('[data-nav-etape]').forEach(b =>
            b.onclick = ev => { ev.stopPropagation();
                montrerEtape(b.dataset.navEtape, b.dataset.t || '', b.dataset.g || ''); });
        // Le focus est replié au départ ; il garde ensuite l'état qu'on lui donne.
        const pliFocus = document.getElementById('op-focus-pli');
        if (pliFocus) pliFocus.addEventListener('toggle', () => { FOCUS_OUVERT = pliFocus.open; });
        h.querySelectorAll('[data-vers-regles]').forEach(b => b.onclick = () => {
            const o = document.querySelector('[data-tab="regles"]'); if (o) o.click();
            setTimeout(() => { const d = document.querySelector('#v3-regles-corps details[data-regle="groupes"], #v3-regle-groupes');
                if (d) { d.open = true; d.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }, 400); });
        h.querySelectorAll('[data-lot]').forEach(b =>
            b.onclick = ev => { ev.stopPropagation(); const l = LOTS[+b.dataset.lot]; if (l) montrerLot(l); });
        h.querySelectorAll('[data-etape]').forEach(b =>
            b.onclick = () => { F.etape = b.dataset.etape; FOCUS_OUVERT = true; rendre(DERNIERES);
                const cible = document.getElementById('op-seg');
                if (cible && cible.scrollIntoView) cible.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
        h.querySelectorAll('[data-focus]').forEach(b =>
            b.onclick = () => { F.etape = b.dataset.focus; rendre(DERNIERES); });
        h.querySelectorAll('[data-deplie]').forEach(b =>
            b.onclick = () => { const x = b.dataset.deplie; F.deplies[x] = !F.deplies[x]; rendre(DERNIERES); });
        const q = document.getElementById('op-q');
        if (q) { let t = null; q.oninput = () => { clearTimeout(t);
            t = setTimeout(() => { F.q = q.value; rendre(DERNIERES);
                const n = document.getElementById('op-q');
                if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } }, 300); }; }
        const hb = document.getElementById('op-hist');
        h.querySelectorAll('.op-lire-hist').forEach(b => b.onclick = () => { if (hb) { hb.scrollIntoView({ block: 'center' }); hb.click(); } });
        if (hb) hb.onclick = async () => {
            const mois = String(new Date().toISOString().slice(0, 7));
            histEtat = { s: 'run', msg: 'Lecture de l’historique Monday…' }; rendre(DERNIERES);
            try {
                await chargerHistorique(mois, msg => { histEtat = { s: 'run', msg };
                    const v = document.querySelector('#op-corps .op-vide'); if (v) v.textContent = msg; });
                histEtat = { s: 'ok', msg: '' };
            }
            catch (err) { histEtat = { s: 'error', msg: (err && err.message) || String(err) }; }
            rendre(DERNIERES);
        };
        h.querySelectorAll('[data-liste-filtre]').forEach(b => b.onclick = () => {
            LISTE_FILTRE = b.dataset.listeFiltre; const y = window.scrollY; rendre(DERNIERES); window.scrollTo(0, y); });
        // Exactement cinq lignes visibles, quelle que soit leur hauteur.
        const boite = h.querySelector('.op-defile');
        if (boite) { const tete = boite.querySelector('thead'), rangs = [...boite.querySelectorAll('tbody tr')].slice(0, 5);
            const haut = (tete ? tete.offsetHeight : 0) + rangs.reduce((t, r) => t + r.offsetHeight, 0);
            if (haut > 0) boite.style.maxHeight = (haut + 2) + 'px'; }
        const exl = document.getElementById('op-export-liste');
        if (exl) exl.onclick = () => exporter(LISTE_COURANTE.pr || [], LISTE_COURANTE.k,
            LISTE_COURANTE.nom === 'tout' ? '' : '-' + LISTE_COURANTE.nom);
        const ex = document.getElementById('op-export');
        if (ex) ex.onclick = () => exporter(pr || [], k);
    }

    // L'export donne TOUTES les lignes de l'étape, pas les trente affichées.
    function exporter(pr, k, suffixe) {
        const X = global.XLSX;
        if (!X) { U().toast && U().toast('SheetJS n’est pas chargé.'); return; }
        const lignes = pr.map(p => ({
            'Facture': p.f.numero, 'Client': p.f.client, 'Apprenant': p.f.apprenant || '',
            'Financement': p.f.financement || '', 'Tableau': p.f.board, 'Groupe': p.f.groupe,
            'Problématique': p.f.problematique || '',
            'Restant dû': p.m, 'Échéance': p.f.dateEcheance || p.f.dateEcheanceSource || '',
            'Jours de retard': p.r == null ? '' : p.r,
            'Dans l’étape depuis (j)': p.a == null ? '' : p.a,
            'Cible (j)': ETAPE[k].cible,
            'Paiement promis': p.f.promesse || '', 'Dernière relance': p.f.derniereRelance || '',
            'Propriétaire': p.f.proprietaire || '',
        }));
        const wb = X.utils.book_new();
        X.utils.book_append_sheet(wb, X.utils.json_to_sheet(lignes), ETAPE[k].n.slice(0, 30));
        X.writeFile(wb, 'operationnel-' + k + (suffixe || '') + '-' + new Date().toISOString().slice(0, 10) + '.xlsx');
    }

    function ouvrir(factures) { rendre(factures); }

    // ═════════ les réglages posés depuis l'onglet « Règles d'application » ═════════
    const CIBLES_ORIGINE = {}; CIRCUIT.forEach(e => { CIBLES_ORIGINE[e.k] = e.cible; });
    function appliquerReglages(r) {
        r = r || {};
        Object.keys(SURCHARGES).forEach(k => { delete SURCHARGES[k]; });
        Object.keys(r.groupes || {}).forEach(k => { SURCHARGES[k] = r.groupes[k]; });
        CIRCUIT.forEach(e => { const v = r.cibles ? +r.cibles[e.k] : 0; e.cible = v > 0 ? v : CIBLES_ORIGINE[e.k]; });
        const c = r.controle || {};
        CONTROLE.proche = +c.proche > 0 ? +c.proche : 15;
        // Une facture sous contrôle n'est dans aucune étape : ce n'est plus un réglage, c'est la définition.
        CONTROLE.horsEtapes = true;
    }

    /** Les factures non réglées de chaque groupe Monday, pour l'onglet des règles. */
    function ouvertesParGroupe(factures) {
        const num = t => prefixe(t).split('.').slice(0, 2).join('.');
        const sortie = {};
        for (const f of (factures || [])) {
            if (f.paye || f.role === 'payees' || f.role === 'sellsy' || f.role === 'ignore') continue;
            if (/^avr/i.test(String(f.numero || ''))) continue;
            const t = tableauDe(f), g = groupeDe(f), k = (num(t) || t) + '|' + cleTitre(g);
            (sortie[k] = sortie[k] || { tableau: t, groupe: g, its: [] }).its.push(f);
        }
        return sortie;
    }
    const cleGroupe = (t, g) => ((prefixe(t).split('.').slice(0, 2).join('.')) || t) + '|' + cleTitre(g);
    const montrerFactures = (titre, its, note) => montrerLot({ titre, its: its || [], note: note || '', completer: false });

    global.LioraOperationnel = {
        ouvertesParGroupe, cleGroupe, montrerFactures,
        appliquerReglages, categorieDuGroupe, estPropose, estTechnique, cleTitre,
        referentiel: REFERENTIEL, CONTROLE, CIBLES_ORIGINE,
        rendre, ouvrir, CIRCUIT, GROUPE_ETAPE, etapeDe,
        etat: () => ({ F, HIST, histEtat }),
    };
})(window);
