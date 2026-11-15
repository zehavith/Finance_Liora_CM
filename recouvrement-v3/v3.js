/* ══════════════════════════════════════════════════════════════════════
   SUIVI RECOUV — VERSION 3
   ══════════════════════════════════════════════════════════════════════

   Ce fichier porte ce que la version 3 ajoute AUTOUR de l'application,
   sans toucher à son moteur (app.js n'est pas modifié) :

     1. l'en-tête de chaque onglet — son nom, et la question à laquelle
        il répond ;
     2. les explications affichées dès la première ouverture (le bouton
        du menu les masque) ;
     3. le lexique ;
     4. l'actualisation depuis Monday par le connecteur monday.com de
        claude.ai — le bouton que la page publiée ne pouvait pas offrir.

   Il se charge après les modules et AVANT app.js, qu'il lance lui-même
   une fois ses précautions prises.
   ══════════════════════════════════════════════════════════════════════ */
(function (G) {
    'use strict';

    var S = G.LioraStore, M = G.LioraMonday, R = G.LioraRules, I = G.LioraIngest;
    var UI = function () { return G.LioraUI; };
    var $ = function (sel) { return document.querySelector(sel); };
    var JETON = M && M.CONNECTEUR;
    var CLE_ARRETE_SERVI = 'rec_arrete_servi';
    var CLE_ACTUALISATION = 'rec_derniere_actualisation';

    function dire(texte, genre, duree) {
        var U = UI();
        if (U && U.toast) U.toast(texte, genre || 'info', duree || 7000);
    }
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    // ══════════════════════════════════════════════
    //  Deux précautions sur ce qui s'enregistre
    // ══════════════════════════════════════════════
    if (S) {
        // Le « jeton » du connecteur n'en est pas un : enregistré, il ferait
        // croire à l'application qu'elle peut interroger Monday toute seule à
        // chaque ouverture. Il ne vit que le temps d'une actualisation.
        var poser = S.set;
        S.set = function (cle, valeur) {
            if (cle === S.KEYS.settings && valeur && valeur.token === JETON) {
                valeur = Object.assign({}, valeur, { token: '' });
            }
            return poser.call(S, cle, valeur);
        };
        // Les explications sont affichées tant qu'on n'a pas choisi de les
        // masquer : une page qu'on ouvre pour la première fois doit se lire.
        var lire = S.get;
        S.get = function (cle, defaut) {
            if (cle === 'rec_aide') return lire.call(S, cle, true);
            return lire.call(S, cle, defaut);
        };
    }

    /**
     * Avant de lancer l'application : si une lecture directe de Monday est
     * enregistrée dans ce navigateur ET qu'un dépôt plus récent accompagne
     * la page, la lecture directe est retirée. Sans cela l'import du dépôt
     * s'ajouterait à elle, et chaque facture compterait deux fois.
     */
    async function preparer() {
        if (!S) return;
        try {
            var tableaux = await S.get(S.KEYS.boards, []);
            var directe = (tableaux || []).some(function (b) {
                return !String(b.id).startsWith('file:') && b.workspace !== 'Démonstration';
            });
            if (!directe) return;
            var servi = await S.get(CLE_ARRETE_SERVI, null);
            var rep = await fetch('donnees/du-jour.json', { cache: 'no-store' });
            if (!rep.ok) return;
            var m = await rep.json();
            var depose = (m.arreteLe || '') + ' ' + (m.arreteA || '');
            if (servi !== depose) {
                await S.set(S.KEYS.factures, []);
                await S.set(S.KEYS.boards, []);
                await S.del(CLE_ACTUALISATION);
            }
        } catch (e) { /* rien à préparer : l'application démarre comme d'habitude */ }
    }

    function lancerApplication() {
        return new Promise(function (resolve) {
            var s = document.createElement('script');
            s.src = 'app.js';
            s.onload = resolve;
            s.onerror = resolve;
            document.body.appendChild(s);
        });
    }

    // ══════════════════════════════════════════════
    //  1. L'en-tête de chaque onglet
    // ══════════════════════════════════════════════
    var ONGLETS = {
        dashboard: {
            titre: 'Tableau de bord',
            quoi: 'Où en est l’argent qu’on nous doit : ce qui est facturé, encaissé, en retard, et depuis quand.',
            source: 'Source : les tableaux Monday. Les échéances sont calculées par vos règles de financement.',
        },
        pilotage: {
            titre: 'Pilotage',
            quoi: 'La revue du mois vue par la comptabilité : encours, part échue, délai d’encaissement, financeur par financeur.',
            source: 'Source : le grand livre Pennylane. Cet onglet a ses propres filtres, juste en dessous.',
        },
        operationnel: {
            titre: 'Opérationnel',
            quoi: 'Le travail en cours : combien de factures attendent à chaque étape du circuit, dans quels tableaux Monday, et depuis combien de temps.',
            source: 'Source : les tableaux Monday. Chaque nombre souligné s’ouvre sur ses factures.',
        },
        aging: {
            titre: 'Balance âgée',
            quoi: 'Ce qui reste dû, rangé par ancienneté du retard. Plus une créance est ancienne, plus elle est difficile à récupérer.',
            source: 'Source au choix : Monday, le grand livre, ou la comparaison des deux.',
        },
        financements: {
            titre: 'Financements',
            quoi: 'Le même suivi, dispositif par dispositif (CPF, OPCO, entreprise, financement personnel…), avec la règle d’échéance de chacun.',
            source: 'Cliquez une ligne pour entrer dans un dispositif.',
        },
        factures: {
            titre: 'Factures',
            quoi: 'La liste détaillée des factures de la vue. Cliquez une ligne pour voir comment son échéance a été calculée.',
            source: 'Les filtres du haut s’appliquent à cette liste et à son export.',
        },
        prelevements: {
            titre: 'Prélèvements GoCardless',
            quoi: 'Les apprenants qui paient par prélèvement : combien vont au bout sans incident, et à quel moment les rejets arrivent.',
            source: 'Source : les exports GoCardless, à déposer dans cet onglet.',
        },
        sellsy: {
            titre: 'Contrôle Sellsy',
            quoi: 'Les factures émises dans Sellsy et absentes de Monday : celles que personne ne suit.',
            source: 'Source : l’export de facturation Sellsy, à déposer dans cet onglet.',
        },
        quality: {
            titre: 'Qualité des données',
            quoi: 'Ce qui manque dans Monday et fausse les calculs : dates absentes, montants vides, doublons.',
            source: 'Chaque ligne dit combien de factures sont concernées et où les corriger.',
        },
        regles: {
            titre: 'Règles d’application',
            quoi: 'Toutes les règles que l’application applique : échéances, classement de la balance âgée, vignettes du circuit. Chacune se déplie et se modifie.',
            source: 'Les modifications restent dans ce navigateur et s’appliquent aux calculs de cette page.',
        },
        donnees: {
            titre: 'Données',
            quoi: 'D’où viennent les chiffres, de quand ils datent, et comment les actualiser.',
            source: 'Rien ne quitte ce navigateur, hormis la lecture de Monday quand vous la demandez.',
        },
    };

    function majEntete() {
        var actif = document.querySelector('.v3-side .nav-tab.active');
        var o = ONGLETS[actif && actif.dataset.tab] || ONGLETS.dashboard;
        // L'onglet des règles ne filtre rien : la barre de filtres s'efface.
        document.body.classList.toggle('v3-onglet-regles', !!(actif && actif.dataset.tab === 'regles'));
        document.body.classList.toggle('v3-onglet-operationnel', !!(actif && actif.dataset.tab === 'operationnel'));
        var t = $('#v3-entete-titre'), q = $('#v3-entete-quoi'), s = $('#v3-entete-source');
        if (t && t.textContent !== o.titre) t.textContent = o.titre;
        if (q && q.textContent !== o.quoi) q.textContent = o.quoi;
        if (s && s.textContent !== o.source) s.textContent = o.source;
    }
    function suivreOnglets() {
        majEntete();
        var tabs = document.querySelector('.v3-side .nav-tabs');
        if (!tabs || !G.MutationObserver) return;
        // L'application change d'onglet par bien des chemins (un clic dans le
        // menu, un lien dans une tuile, la fin d'un import) : on suit le
        // résultat — la classe « active » — plutôt que chacun des chemins.
        new MutationObserver(majEntete).observe(tabs, { attributes: true, subtree: true, attributeFilter: ['class'] });
    }

    // ══════════════════════════════════════════════
    //  2. Le bouton des explications dit son état
    // ══════════════════════════════════════════════
    function suivreAide() {
        // L'explication de chaque filtre passe en infobulle : la barre reste
        // sur une ligne, et le texte reste à portée de souris.
        document.querySelectorAll('.filter-block').forEach(function (bloc) {
            var aide = bloc.querySelector('.aide-ligne');
            if (aide && !bloc.title) bloc.title = aide.textContent.replace(/\s+/g, ' ').trim();
        });
        var libelle = $('#v3-aide-libelle');
        if (!libelle) return;
        var maj = function () {
            var oui = document.body.classList.contains('aide');
            var txt = oui ? 'Masquer les explications' : 'Afficher les explications';
            if (libelle.textContent !== txt) libelle.textContent = txt;
        };
        maj();
        if (G.MutationObserver) {
            new MutationObserver(maj).observe(document.body, { attributes: true, attributeFilter: ['class'] });
        }
    }

    // ══════════════════════════════════════════════
    //  3. Le lexique
    // ══════════════════════════════════════════════
    var LEXIQUE = [
        ['Arrêté au', 'La date à laquelle la situation est regardée. Tous les retards se comptent jusqu’à ce jour. '
            + 'Vous pouvez la reculer dans les filtres pour revoir la situation telle qu’elle était.'],
        ['Échéance calculée', 'La date à laquelle une facture doit être payée. Elle est calculée par vos règles de '
            + 'financement — par exemple fin de formation + 60 jours pour le CPF, date de facture + 30 jours pour une '
            + 'entreprise — et non reprise de la colonne « Date d’échéance » de Monday. Les règles se lisent et se '
            + 'modifient dans l’onglet Financements.'],
        ['Réglée (encaissée)', 'Une facture est comptée comme réglée si elle figure dans le tableau Monday des factures '
            + 'payées, si elle porte une date de paiement, ou si le grand livre la solde par un règlement.'],
        ['Reste à encaisser', 'Tout ce qui n’est pas encore réglé : ce qui est en retard, plus ce qui n’est pas encore '
            + 'arrivé à échéance.'],
        ['En recouvrement (en retard)', 'Une facture dont l’échéance calculée est dépassée à la date d’arrêté et qui '
            + 'n’est toujours pas réglée, quel que soit le tableau Monday où elle se trouve. C’est l’argent à aller chercher.'],
        ['Non échu', 'Facturé, mais l’échéance n’est pas encore passée : un encaissement attendu, pas un retard.'],
        ['Échéance inconnue / à qualifier', 'Il manque une date dans Monday (date de facture, début ou fin de formation) : '
            + 'l’échéance ne peut pas être calculée, et la facture sort des taux. Aucune date n’est inventée.'],
        ['Annulée par avoir', 'Une facture soldée au grand livre par un avoir et non par un paiement : la créance a été '
            + 'annulée, rien n’est rentré. Elle est exclue des chiffres par défaut.'],
        ['Retard moyen', 'Sur les factures encore impayées : le nombre de jours écoulés depuis l’échéance, en moyenne. '
            + 'La médiane est la valeur du milieu ; elle n’est pas tirée vers le haut par quelques créances très anciennes.'],
        ['Retard moyen au paiement', 'Sur les factures qui ont fini par être payées : combien de jours après l’échéance '
            + 'l’argent est arrivé. À ne pas confondre avec le retard moyen, qui porte sur ce qui est toujours impayé.'],
        ['Balance âgée', 'Le reste dû rangé par tranches d’ancienneté du retard (0 à 3 mois, 6 à 12 mois, plus de 12 mois…).'],
        ['Créance compromise (bad debt)', 'Une créance échue depuis plus de 12 mois. Le seuil se règle dans l’onglet Données.'],
        ['Encours', 'Dans l’onglet Pilotage : le total que les clients doivent à une date donnée, d’après la comptabilité. '
            + 'Il se partage en échu (l’échéance est passée) et non échu.'],
        ['DSO', 'Le délai moyen entre la date d’une facture et son encaissement, pondéré par les montants. '
            + 'Plus il est bas, plus l’argent rentre vite.'],
        ['Grand livre et lettrage', 'Le grand livre est le relevé comptable tenu dans Pennylane. Lettrer, c’est rattacher '
            + 'un règlement à la facture qu’il solde. Un règlement non lettré est rentré en banque sans être rattaché.'],
        ['Circuit et étapes', 'Dans l’onglet Opérationnel, chaque groupe Monday est rangé dans une étape : Rendre payable '
            + '(ADV), Relancer (Recouvrement), Clôture (Contentieux), Corriger (Comptabilité). Le nombre d’une étape est '
            + 'le nombre de factures non réglées de ses groupes ; cliquez-le pour voir lesquelles.'],
        ['Tableau et groupe Monday', 'Un tableau Monday (par exemple « 1.1. Entreprise - ADV ») contient des groupes '
            + '(« 1.1.2. Factures incomplètes »). Le numéro d’un groupe commence par celui de son tableau. Les groupes '
            + '« Technique » et « Archive » ne sont pas comptés.'],
        ['Données déposées / lecture directe', 'Les données déposées sont la copie des neuf tableaux Monday publiée avec '
            + 'cette page, à la date indiquée en bas du menu. La lecture directe relit Monday à l’instant, par le '
            + 'connecteur monday.com, quand vous cliquez « Actualiser depuis Monday ».'],
    ];
    function ouvrirLexique() {
        var U = UI();
        if (!U || !U.modal) return;
        var html = '<p class="v3-lexique-intro">Les mots utilisés dans l’application, dans l’ordre où on les rencontre.</p>'
            + '<dl class="v3-lexique">'
            + LEXIQUE.map(function (l) { return '<div><dt>' + esc(l[0]) + '</dt><dd>' + esc(l[1]) + '</dd></div>'; }).join('')
            + '</dl>';
        U.modal('Lexique', html, [{ label: 'Fermer', primary: true }], { large: true });
    }

    // ══════════════════════════════════════════════
    //  4. Actualiser depuis Monday, par le connecteur
    // ══════════════════════════════════════════════
    var enCours = false;
    var connecteur = null;          // null : pas encore su ; true / false ensuite

    var INDISPONIBLE = 'Le connecteur monday.com n’est pas disponible dans cette vue (page ouverte hors de claude.ai, '
        + 'ou connecteurs non autorisés pour cette page). Les données déposées restent affichées.';

    var etat = function () { return G.__recouvrement; };
    var prefixeTableau = function (nom) { var m = /^\s*(\d+\.\d+)/.exec(String(nom || '')); return m ? m[1] : ''; };
    var directe = function (st) {
        return !!st && (st.boards || []).some(function (b) {
            return !String(b.id).startsWith('file:') && b.workspace !== 'Démonstration';
        });
    };
    var attendre = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    var jourLocal = function (d) {
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    };

    function majEtatMonday() {
        var st = etat();
        var el = $('#v3-monday-etat'), btn = $('#v3-btn-monday'), retour = $('#v3-btn-depot');
        var pt = $('#v3-point-monday'), lg = $('#v3-ligne-monday');
        var estDirecte = directe(st);
        var quand = st && st.derniereActualisation
            ? st.derniereActualisation.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '';
        if (pt) pt.className = 'v3-point ' + (enCours ? 'attente' : 'ok');
        if (lg) {
            var txt = enCours ? 'Monday : lecture en cours…'
                : estDirecte ? 'Monday : lu en direct' + (quand ? ' le ' + quand : '')
                : 'Monday : données déposées';
            if (lg.textContent !== txt) lg.textContent = txt;
        }
        if (retour) retour.hidden = !estDirecte || enCours;
        [btn, $('#v3-btn-complet'), $('#btn-refresh'), $('#btn-aging-refresh')].forEach(function (b) {
            if (!b) return;
            b.disabled = enCours || connecteur === false;
            b.title = connecteur === false ? INDISPONIBLE
                : b.id === 'v3-btn-complet'
                    ? 'Relit en entier les neuf tableaux Monday. Compter quelques minutes.'
                    : 'Relit dans Monday les seules factures modifiées depuis la dernière lecture. La première fois, tout est relu.';
        });
        if (!el) return;
        var html = enCours
            ? '<strong>Lecture de Monday en cours…</strong> L’écran de chargement montre l’avancement, tableau par tableau.'
            : connecteur === false ? esc(INDISPONIBLE)
            : estDirecte
                ? '<strong>Les chiffres viennent d’une lecture directe de Monday'
                  + (quand ? ' du ' + esc(quand) : '') + '.</strong> Ils sont gardés dans ce navigateur. '
                  + '« Revenir aux données déposées » reprend la copie publiée avec la page.'
                : '<strong>Les chiffres viennent des données déposées avec la page.</strong> '
                  + '« Actualiser depuis Monday » relit les neuf tableaux à l’instant, avec votre compte Monday.';
        if (el.innerHTML !== html) el.innerHTML = html;
    }

    async function actualiserDepuisMonday(mode) {
        var st = etat();
        if (!st || enCours) return;
        if (st.chargementEnCours) { dire('Un chargement est déjà en cours.', 'error'); return; }
        if (!M || !JETON || !R) { dire('Le client Monday n’est pas chargé.', 'error'); return; }

        enCours = true; majEtatMonday();
        var avant = null;
        try {
            // « Rapide » ne relit que les lignes que le journal de Monday dit
            // modifiées depuis la dernière lecture ; sans copie gardée, ou sur
            // demande, tout est relu.
            if (M.definirModeConnecteur) M.definirModeConnecteur(mode === 'complet' ? 'complet' : 'rapide');
            connecteur = await M.connecteurDisponible();
            if (!connecteur) { dire(INDISPONIBLE, 'error', 12000); return; }

            dire('Connexion à Monday… claude.ai peut vous demander d’autoriser le connecteur.', 'info', 6000);
            var trouves;
            try { trouves = await M.listBoards(JETON); }
            catch (e) { dire(e.message, 'error', 14000); return; }

            var attendus = M.TABLEAUX_CONNECTEUR, vus = {};
            (trouves || []).forEach(function (b) { vus[String(b.id)] = b; });
            var manquants = attendus.filter(function (id) { return !vus[id]; });
            if (manquants.length) {
                dire('Votre compte Monday ne voit que ' + (attendus.length - manquants.length) + ' des '
                    + attendus.length + ' tableaux du circuit : l’actualisation serait incomplète, elle n’est pas '
                    + 'lancée. Vérifiez vos accès dans Monday.', 'error', 16000);
                return;
            }

            // Les neuf tableaux lus en direct remplacent leur copie déposée.
            // Un tableau importé à la main et qui n'est pas l'un des neuf reste.
            avant = { brutes: st.brutes, boards: st.boards };
            var numeros = {};
            attendus.forEach(function (id) { numeros[prefixeTableau(vus[id].name)] = true; });
            var gardes = (avant.boards || []).filter(function (b) {
                return String(b.id).startsWith('file:') && !numeros[prefixeTableau(b.name)];
            });
            var idsGardes = {};
            gardes.forEach(function (b) { idsGardes[String(b.id)] = true; });

            var nouveaux = attendus.map(function (id) {
                var b = vus[id], d = R.detectBoardRole(b.name);
                var prev = (avant.boards || []).find(function (x) { return String(x.id) === id; });
                return {
                    id: id, name: b.name, itemsCount: null,
                    workspace: b.workspace ? b.workspace.name : '',
                    role: prev ? prev.role : (d.role === 'ignore' ? 'adv' : d.role),
                    perimetre: prev ? prev.perimetre : (d.perimetre === 'Inconnu' ? 'Corporate' : d.perimetre),
                    source: prev ? prev.source : (d.source || 'adv'),
                    financementDefaut: prev ? prev.financementDefaut : d.financementDefaut,
                    actif: true,
                    columns: prev ? prev.columns : null,
                    mapping: prev && prev.mappingManuel ? prev.mapping : null,
                    mappingManuel: !!(prev && prev.mappingManuel),
                    charge: null,
                };
            });

            st.boards = nouveaux.concat(gardes);
            // Les factures d'une lecture directe précédente restent en place
            // jusqu'à leur remplacement : c'est ce qui permet de dire, à la
            // fin, combien sont nouvelles et combien ont disparu.
            var etaitDirecte = directe({ boards: avant.boards });
            st.brutes = (avant.brutes || []).filter(function (f) {
                return idsGardes[String(f.boardId)] || !String(f.boardId).startsWith('file:');
            });
            st.derniereErreur = null;
            st.token = JETON;

            // Le chargement lui-même est celui de l'application : mêmes
            // colonnes reconnues, même consolidation, mêmes règles d'échéance.
            // Un tableau importé à la main n'a pas d'identifiant Monday : il
            // est mis de côté le temps du chargement, ses factures restent.
            gardes.forEach(function (b) { b.__actifAvant = b.actif; b.actif = false; });
            var remettre = function () {
                gardes.forEach(function (b) { b.actif = b.__actifAvant; delete b.__actifAvant; });
            };
            var lanceur = $('#btn-boards-load');
            if (lanceur) lanceur.click();
            await attendre(50);
            if (!st.chargementEnCours) {
                remettre();
                st.boards = avant.boards; st.brutes = avant.brutes; st.token = '';
                dire('L’actualisation n’a pas pu démarrer. Les données déposées restent affichées.', 'error', 10000);
                return;
            }
            while (st.chargementEnCours) await attendre(400);
            st.token = '';
            remettre();

            var echecs = (st.boards || []).filter(function (b) { return b.erreurChargement; });
            var lues = (st.brutes || []).filter(function (f) { return !String(f.boardId).startsWith('file:'); }).length;
            if (etaitDirecte && !st.derniereErreur && lues && echecs.length) {
                // Une lecture directe existait déjà : les tableaux relus sont à
                // jour, les autres gardent leurs factures d'avant. Rien à défaire.
                dire(echecs.length + ' tableau(x) n’ont pas pu être relus (' + echecs.map(function (b) { return b.name; }).join(', ')
                    + ') : leurs factures de la lecture précédente sont conservées. Relancez l’actualisation.', 'error', 16000);
            } else if (st.derniereErreur || echecs.length || !lues) {
                var pourquoi = st.derniereErreur
                    || (echecs.length ? echecs.length + ' tableau(x) non lu(s) : '
                        + echecs.map(function (b) { return b.name; }).join(', ') : 'aucune facture reçue');
                await revenirAuDepot('L’actualisation depuis Monday n’a pas abouti (' + pourquoi
                    + '). La page reprend les données déposées.');
                return;
            }

            // Les chiffres sont ceux d'aujourd'hui : l'arrêté suit.
            var champ = $('#date-ref'), jour = jourLocal(new Date());
            if (champ && champ.value !== jour) {
                champ.value = jour;
                champ.dispatchEvent(new Event('change', { bubbles: true }));
            }
        } catch (e) {
            if (avant && etat()) { etat().token = ''; }
            dire('L’actualisation a été interrompue : ' + ((e && e.message) || e), 'error', 14000);
        } finally {
            enCours = false;
            majEtatMonday();
        }
    }

    /** Efface la lecture directe et relit la copie publiée avec la page. */
    async function revenirAuDepot(message) {
        dire(message || 'Retour aux données déposées avec la page…', message ? 'error' : 'info', 12000);
        try {
            await S.set(S.KEYS.factures, []);
            await S.set(S.KEYS.boards, []);
            await S.del(CLE_ARRETE_SERVI);
            await S.del(CLE_ACTUALISATION);
        } catch (e) { /* le rechargement fera le reste */ }
        setTimeout(function () {
            try { location.reload(); }
            catch (e) { dire('Rechargez la page pour retrouver les données déposées.', 'error', 15000); }
        }, message ? 3500 : 800);
    }

    function brancherMonday() {
        // Les boutons d'actualisation de l'application supposent un jeton,
        // qu'une page publiée n'a pas. Le clic est repris ici, avant eux.
        document.addEventListener('click', function (e) {
            var b = e.target && e.target.closest
                && e.target.closest('#btn-refresh, #btn-aging-refresh, #v3-btn-monday, #v3-btn-complet, #v3-btn-depot, #v3-btn-lexique');
            if (!b) return;
            if (b.id === 'v3-btn-lexique') { ouvrirLexique(); return; }
            e.preventDefault(); e.stopPropagation();
            if (b.disabled) return;
            if (b.id === 'v3-btn-depot') revenirAuDepot();
            else actualiserDepuisMonday(b.id === 'v3-btn-complet' ? 'complet' : 'rapide');
        }, true);

        if (M && M.connecteurDisponible) {
            M.connecteurDisponible().then(function (ok) { connecteur = !!ok; majEtatMonday(); });
        } else { connecteur = false; }
        majEtatMonday();
        // L'état se relit de temps en temps : une actualisation peut finir,
        // un dépôt se charger, sans que ce fichier en soit prévenu.
        setInterval(majEtatMonday, 4000);
        setInterval(suivreDates, 1500);
    }

    // ══════════════════════════════════════════════
    //  5. Les dates complétées à la main
    // ══════════════════════════════════════════════
    //
    // Une facture « à qualifier » n'a pas d'échéance parce qu'une date lui
    // manque dans Monday. La date saisie dans l'onglet Opérationnel est gardée
    // ici, par numéro de facture, et reposée sur la facture à chaque fois que
    // les données sont relues — dépôt ou lecture directe. Elle ne remplit
    // qu'un vide : si Monday finit par porter la date, c'est Monday qui gagne.
    var CLE_DATES = 'rec_v3_dates';
    var DATES = {};
    var brutesVues = null;
    var CHAMPS_DATES = { dateFacture: 1, dateDebutFormation: 1, dateFinFormation: 1 };

    function appliquerDates(st) {
        var n = 0;
        (st.brutes || []).forEach(function (f) {
            var o = f.cle && DATES[f.cle];
            if (!o) return;
            Object.keys(o).forEach(function (champ) {
                if (!CHAMPS_DATES[champ] || f[champ]) return;
                var d = R.parseDate(o[champ]);
                if (d) { f[champ] = d; n++; }
            });
        });
        return n;
    }
    function recalculer() {
        var champ = $('#date-ref');
        if (champ) champ.dispatchEvent(new Event('change', { bubbles: true }));
    }
    function suivreDates() {
        var st = etat();
        if (!st || st.chargementEnCours || st.brutes === brutesVues) return;
        brutesVues = st.brutes;
        if (Object.keys(DATES).length && appliquerDates(st) && (st.factures || []).length) recalculer();
    }
    async function completerDate(cle, champ, iso) {
        var st = etat();
        if (!st || !cle || !CHAMPS_DATES[champ] || !R.parseDate(iso)) return false;
        DATES[cle] = Object.assign({}, DATES[cle], {});
        DATES[cle][champ] = iso;
        if (!appliquerDates(st)) { delete DATES[cle][champ]; return false; }
        try { await S.set(CLE_DATES, DATES); } catch (e) { /* la date vaut pour cette session */ }
        recalculer();
        return true;
    }
    G.LioraV3 = { completerDate: completerDate, datesSaisies: function () { return DATES; },
                  bilan: function () { return BILAN; }, grandLivre: function () { return GL_INFO; },
                  carteEdof: function () { carteEdofOperationnel(); } };

    // ══════════════════════════════════════════════
    //  Compléments appliqués avant chaque calcul
    // ══════════════════════════════════════════════
    /**
     * Quatre compléments passent juste avant le calcul des échéances, à chaque
     * recalcul :
     *  1. le grand livre fait foi pour les règlements — date de paiement,
     *     avoir, montant manquant. Sans grand livre déposé à la main, c'est
     *     l'extrait de la balance âgée publié avec la page qui sert ;
     *  2. une facture refaite (colonne « Ancienne facture » de Monday) garde
     *     la date de la facture d'origine : la refaire ne repousse pas ce qui
     *     est dû ;
     *  3. le fichier du financeur (Filiz…) complète aussi les montants vides ;
     *  4. les lignes Sellsy au montant aberrant ou négatif (avoirs, erreurs
     *     de saisie) sont écartées des factures ajoutées depuis Sellsy.
     */
    var GL = null, GL_INFO = null, ANCIENNES = null, RAPPRO = null, RAPPRO_INFO = null, CONTROLES = [], EDOF = null;
    var BILAN = { gl: null, anciennes: 0, anciennesSansDate: 0, montantsDossier: 0, sellsyEcartees: [] };
    var PLAFOND_SELLSY = 500000;

    // ── Import EDOF depuis l'onglet Données ──
    var CLE_EDOF = 'rec_v3_edof', EDOF_BRUT = { factures: {}, avances: {}, periodes: [], dossiers: {} }, EDOF_IMPORT = null;
    /** Ajoute un lot EDOF à ce qui est connu : la ligne la plus récente d'une facture l'emporte. */
    function fusionnerEdof(lot) {
        [['factures', lot.factures || {}], ['avances', lot.avances || {}]].forEach(function (c) {
            Object.keys(c[1]).forEach(function (k) { var l = c[1][k], a = EDOF_BRUT[c[0]][k];
                if (!a || String(l[4]) >= String(a[4])) EDOF_BRUT[c[0]][k] = l; });
        });
        (lot.periodes || []).forEach(function (p) {
            if (!EDOF_BRUT.periodes.some(function (q) { return q[0] === p[0] && q[1] === p[1]; })) EDOF_BRUT.periodes.push(p);
        });
        EDOF_BRUT.periodes.sort();
        EDOF_BRUT.dossiers = EDOF_BRUT.dossiers || {};
        Object.keys(lot.dossiers || {}).forEach(function (k) { EDOF_BRUT.dossiers[k] = lot.dossiers[k]; });
    }
    /** Nom et prénom ramenés à une clé : sans accent, en majuscules, mots triés. */
    function nomCle(t) {
        return String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().split(/[^A-Z]+/).filter(Boolean).sort().join(' ');
    }
    function poserEdof() {
        if (!Object.keys(EDOF_BRUT.factures).length && !Object.keys(EDOF_BRUT.avances).length && !Object.keys(EDOF_BRUT.dossiers || {}).length) { EDOF = null; return; }
        EDOF = { factures: {}, avances: EDOF_BRUT.avances, periodes: EDOF_BRUT.periodes, dossiers: EDOF_BRUT.dossiers || {}, parNom: {} };
        Object.keys(EDOF.dossiers).forEach(function (k) { var n = EDOF.dossiers[k][7]; if (n) (EDOF.parNom[n] = EDOF.parNom[n] || []).push(k); });
        EDOF.parDossier = {};
        Object.keys(EDOF_BRUT.factures).forEach(function (n) { var l = EDOF_BRUT.factures[n];
            EDOF.factures[I.factureKey(n)] = l;
            if (l[3]) (EDOF.parDossier[String(l[3]).replace(/\s+/g, '')] = EDOF.parDossier[String(l[3]).replace(/\s+/g, '')] || []).push(n); });
    }
    /** Lit un export EDOF (CSV à points-virgules) : renvoie un lot, ou lève une erreur lisible. */
    function lireCsvEdof(texte, nom) {
        var lignes = String(texte || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter(function (l) { return l.trim(); });
        var sep = (lignes[0] || '').indexOf(';') >= 0 ? ';' : ',';
        var tete = (lignes[0] || '').split(sep).map(function (h) { return h.trim().replace(/^"|"$/g, '').toUpperCase(); });
        var col = function (n) { return tete.indexOf(n); };
        var iD = col('NUMERO_DOSSIER'), iF = col('NUMERO_FACTURE'), iT = col('TYPE FACTURE'), iE = col('DATE_EMISSION_FACTURE'),
            iM = col('MONTANT_REGLEMENT'), iS = col('STATUT_REGLEMENT'), iR = col('DATE_REGLEMENT'), iC = col('DOSSIER EN CONTROLE O/N');
        if (col('STATUT_DOSSIER') >= 0 && iD >= 0) {
            // Export « Tous les dossiers » : seuls le statut, les dates de session, les montants et le nom sont gardés.
            var jd = function (x) { return x && x.length >= 10 ? x.slice(6, 10) + '-' + x.slice(3, 5) + '-' + x.slice(0, 2) : ''; };
            var nb2 = function (x) { var v = parseFloat(String(x).replace(',', '.')); return isNaN(v) ? null : Math.round(v * 100) / 100; };
            var jS = col('STATUT_DOSSIER'), jDeb = col('DATE_DEBUT_SESSION'), jFin = col('DATE_FIN_SESSION'), jMF = col('MONTANT_FORMATION'), jFa = col('MONTANT_FACTURABLE'),
                jAc = col('DATE_DERNIERE_ACTION'), jCt = col('EN_CONTROLE'), jN = col('NOM'), jP = col('PRENOM'), lotD = { factures: {}, avances: {}, periodes: [], dossiers: {} }, nd = 0;
            for (var q = 1; q < lignes.length; q++) { var cc = lignes[q].split(sep).map(function (x) { return x.trim().replace(/^"|"$/g, ''); });
                if (!/^\d{6,}$/.test(cc[iD] || '') || !cc[jS]) continue;
                lotD.dossiers[cc[iD]] = [cc[jS], jd(cc[jDeb]), jd(cc[jFin]), nb2(cc[jMF]), nb2(cc[jFa]), jd(cc[jAc]), cc[jCt] === 'OUI', nomCle((cc[jN] || '') + ' ' + (cc[jP] || ''))]; nd++; }
            if (!nd) throw new Error('« ' + nom + ' » ne contient aucun dossier lisible.');
            lotD.nbLignes = nd;
            return lotD;
        }
        if (iD < 0 || iF < 0 || iS < 0 || iM < 0) throw new Error('« ' + nom + ' » n’est pas un export EDOF des factures : colonnes NUMERO_DOSSIER, NUMERO_FACTURE, MONTANT_REGLEMENT et STATUT_REGLEMENT attendues.');
        var lot = { factures: {}, avances: {}, periodes: [] }, min = '', max = '', n = 0;
        for (var i = 1; i < lignes.length; i++) {
            var c = lignes[i].split(sep).map(function (x) { return x.trim().replace(/^"|"$/g, ''); });
            if (!c[iD] && !c[iF]) continue;
            var em = iE >= 0 ? c[iE] : '', avance = iT >= 0 && /avance/i.test(c[iT]);
            var ligne = [Math.round(parseFloat(String(c[iM]).replace(',', '.')) * 100) / 100 || 0, iR >= 0 ? c[iR] : '', c[iS], c[iD], em, iC >= 0 && c[iC] === 'O'];
            lot[avance ? 'avances' : 'factures'][avance ? c[iD] : c[iF]] = ligne;
            if (em) { if (!min || em < min) min = em; if (em > max) max = em; }
            n++;
        }
        if (!n) throw new Error('« ' + nom + ' » ne contient aucune ligne.');
        lot.periodes = [[min, max, n]];
        return lot;
    }
    async function importerEdof(fichiers) {
        var etatEl = $('#v3-edof-etat'), recus = 0, noms = [];
        try {
            for (var i = 0; i < fichiers.length; i++) {
                var lot = lireCsvEdof(await fichiers[i].text(), fichiers[i].name);
                fusionnerEdof(lot);
                EDOF_IMPORT = EDOF_IMPORT || { factures: {}, avances: {}, periodes: [], dossiers: {} };
                Object.assign(EDOF_IMPORT.factures, lot.factures); Object.assign(EDOF_IMPORT.avances, lot.avances);
                EDOF_IMPORT.dossiers = Object.assign(EDOF_IMPORT.dossiers || {}, lot.dossiers || {});
                EDOF_IMPORT.periodes = EDOF_IMPORT.periodes.concat(lot.periodes);
                recus += lot.nbLignes || lot.periodes[0][2]; noms.push(fichiers[i].name);
            }
        } catch (e) { dire(e.message || 'Fichier EDOF illisible.', 'error', 9000); if (etatEl) majCarteEdof(); return; }
        poserEdof();
        var garde = true;
        try { await S.set(CLE_EDOF, EDOF_IMPORT); } catch (e) { garde = false; }
        recalculer();
        majCarteEdof();
        dire(recus.toLocaleString('fr-FR') + ' lignes EDOF importées' + (garde ? ' et gardées dans ce navigateur.' : ' — mais elles n’ont pas pu être gardées : il faudra réimporter à la prochaine visite.'), garde ? 'success' : 'error', 7000);
    }
    function majCarteEdof() {
        var el = $('#v3-edof-etat');
        if (!el) return;
        var f = EDOF_BRUT.factures, nb = Object.keys(f).length, verse = 0;
        Object.keys(f).forEach(function (k) { if (f[k][2] === 'Versé') verse++; });
        var jour = function (d) { return String(d || '').split('-').reverse().join('/'); };
        var p = EDOF_BRUT.periodes;
        el.innerHTML = nb ? '<b>' + nb.toLocaleString('fr-FR') + ' factures EDOF connues</b>, dont ' + verse.toLocaleString('fr-FR') + ' « Versé », et '
            + Object.keys(EDOF_BRUT.avances).length.toLocaleString('fr-FR') + ' avances, et ' + Object.keys(EDOF_BRUT.dossiers || {}).length.toLocaleString('fr-FR') + ' dossiers. Factures déposées du ' + jour(p[0] && p[0][0]) + ' au ' + jour(p.length && p[p.length - 1][1]) + '. '
            + (BILAN.edof ? BILAN.edof.toLocaleString('fr-FR') + ' factures Monday sont comptées payées grâce à EDOF.' : '')
            + (EDOF_IMPORT ? ' <span class="op-pied">Dont un import fait depuis ce navigateur.</span>' : '')
            : 'Aucun export EDOF n’est connu pour l’instant.';
        var raz = $('#v3-edof-raz'); if (raz) raz.hidden = !EDOF_IMPORT;
    }
    function brancherEdof() {
        var ancre = $('#v3-carte-monday');
        if (!ancre || $('#v3-carte-edof')) return;
        var carte = document.createElement('div');
        carte.className = 'chart-card chart-wide settings-card'; carte.id = 'v3-carte-edof';
        carte.innerHTML = '<div class="chart-header"><h3>Paiements CPF — export EDOF</h3><div class="chart-controls">'
            + '<button class="btn btn-ghost btn-sm" id="v3-edof-raz" type="button" hidden>Oublier mes imports</button>'
            + '<button class="btn btn-primary btn-sm" id="v3-edof-btn" type="button">Importer un export EDOF</button>'
            + '<input type="file" id="v3-edof-fichier" accept=".csv,text/csv" multiple hidden></div></div>'
            + '<div class="settings-body"><p id="v3-edof-etat"></p>'
            + '<p class="op-pied">Pour le CPF, EDOF fait foi : une facture « Versé » est comptée payée à la date de règlement EDOF. '
            + 'Fichiers acceptés : l’export « Factures » et l’export « Tous les dossiers » d’EDOF, au format CSV, tels qu’ils sont téléchargés. De l’export des dossiers, seuls le statut, les dates de session, les montants et le nom sont gardés. Plusieurs fichiers peuvent être choisis d’un coup ; '
            + 'un nouvel export s’ajoute aux précédents, et la ligne la plus récente d’une facture l’emporte. '
            + 'L’import est gardé dans ce navigateur : sur un autre poste, il faut le refaire.</p></div>';
        ancre.parentNode.insertBefore(carte, ancre.nextSibling);
        var champ = $('#v3-edof-fichier');
        $('#v3-edof-btn').addEventListener('click', function () { champ.click(); });
        champ.addEventListener('change', function () { var l = [].slice.call(champ.files || []); champ.value = ''; if (l.length) importerEdof(l); });
        $('#v3-edof-raz').addEventListener('click', async function () {
            EDOF_IMPORT = null;
            try { await S.set(CLE_EDOF, null); } catch (e) { /* rien à effacer */ }
            dire('Imports EDOF de ce navigateur oubliés : la page est rechargée avec les données publiées.', 'info', 3000);
            setTimeout(function () { location.reload(); }, 1200);
        });
        majCarteEdof();
        setInterval(majCarteEdof, 4000);
    }

    // ── Opérationnel : où en est EDOF pour le CPF ──
    var EDOF_LOTS = [], CIRCUIT_FIN = 'CPF';
    // L'état de pointage Sellsy d'une facture : d'après l'export Sellsy s'il est déposé, sinon d'après le
    // groupe Monday qui le dit (« sellsy pointé », « non remonté sur Sellsy »).
    var SELLSY_VU = null, SELLSY_PAR_CLE = null;
    function sellsyPointe(f) {
        var st = etat() || {}, lignes = (st.sellsy && st.sellsy.lignes) || [];
        if (lignes !== SELLSY_VU) { SELLSY_VU = lignes; SELLSY_PAR_CLE = null;
            if (lignes.length) { SELLSY_PAR_CLE = {}; lignes.forEach(function (l) { var k = l.cle || I.factureKey(l.numero); if (k) SELLSY_PAR_CLE[k] = l; }); } }
        var l = SELLSY_PAR_CLE && f.cle && SELLSY_PAR_CLE[f.cle];
        if (l) return l.paye ? 'oui' : 'non';
        var g = String(f.groupe || '').toLowerCase();
        if (/sellsy point/.test(g)) return 'oui';
        if (/non remont[ée] sur sellsy/.test(g)) return 'non';
        return 'inconnu';
    }
    /** Dans quel cas de « Corriger » tombe une facture. */
    var CAS_CORRIGER = [
        ['a', 'Payées, pointées sur Sellsy et Pennylane — rectification à faire sur Monday'],
        ['b', 'Payées, pointées sur Pennylane mais pas sur Sellsy — rectification à faire sur Sellsy et sur Monday'],
        ['c', 'Payées, non pointées sur Sellsy et Pennylane — à pointer'],
        ['hors', 'Réglées ou annulées en comptabilité, sans versement EDOF connu — rectification à faire sur Monday'],
        ['groupe', 'Non réglées, rangées dans un groupe Monday du circuit « Corriger »']
    ];
    // Hors CPF, EDOF n'existe pas : seuls le pointage en comptabilité et le groupe Monday comptent.
    var CAS_CORRIGER_GENERAL = [
        ['p', 'Payées, pointées en comptabilité (Pennylane) — rectification à faire sur Monday'],
        ['np', 'Payées, non pointées en comptabilité — à pointer, puis rectifier Monday'],
        ['groupe', 'Non réglées, rangées dans un groupe Monday du circuit « Corriger »']
    ];
    function casCorriger(f, cpf) {
        if (!f.paye) return 'groupe';
        if (!cpf) return f.grandLivreSoldee || f.soldeeParAvoir ? 'p' : 'np';
        if (!f.edofVerse) return 'hors';
        if (!f.grandLivreSoldee) return 'c';
        return sellsyPointe(f) === 'oui' ? 'a' : 'b';
    }
    /** Ouvre un lot dans une fenêtre, avec son export et, pour « Corriger », un filtre par cas. */
    /** Fenêtre des factures à revérifier : le motif est une colonne, et la liste est triée par motif. */
    function ouvrirLotMotifs(l) {
        var u = UI(); if (!u || !u.modal || !u.table) return false;
        var d = function (v) { var x = v && R.parseDate(v); return x ? jourLocal(x).split('-').reverse().join('/') : ''; };
        var cols = [
            { key: '__motif', label: 'Motif', width: '300px', format: function (v, f) { return '<span class="v3-motif">' + esc(v || '') + '</span>'
                + ((f.__autresMotifs || []).length ? '<br><span class="op-pied">aussi : ' + esc(f.__autresMotifs.join(' ; ')) + '</span>' : '')
                + ((f.__autresDossiers || []).length ? '<br><span class="v3-trouve">Autre dossier EDOF : ' + esc(f.__autresDossiers.join(' | ')) + '</span>' : '')
                + ((f.__autresFactures || []).length ? '<br><span class="v3-trouve">Autre facture Monday : ' + esc(f.__autresFactures.join(' | ')) + '</span>' : ''); } },
            { key: 'numero', label: 'Facture', width: '150px', format: function (v, f) { return esc(v || '') + (f.apprenant ? '<br><span class="op-pied">' + esc(f.apprenant) + '</span>' : ''); } },
            { key: 'groupe', label: 'Groupe Monday' },
            { key: 'dateFinFormation', label: 'Fin de formation', width: '104px', format: d },
            { key: 'montant', label: 'Montant', align: 'right', width: '100px', format: function (v) { return v == null ? '—' : Math.round(v).toLocaleString('fr-FR') + ' €'; } },
            (EDOF && l.its.some(function (f) { return f.financement === 'CPF'; }))
                ? { key: 'edof', label: 'EDOF', width: '150px', format: function (v, f) { return v ? esc(v.statut) + (v.date ? ' le ' + d(v.date) : '') : (f.edofDossier ? 'dossier : ' + esc(f.edofDossier.statut) + (f.edofAvance ? '<br><span class="op-pied">avance versée</span>' : '') : 'dossier introuvable'); } }
                : { key: 'dateEcheance', label: 'Échéance', width: '150px', format: function (v, f) { return v ? d(v) + (f.retardJours > 0 ? '<br><span class="op-pied">dépassée de ' + f.retardJours + ' j</span>' : '') : '<span class="op-pied">inconnue</span>'; } }
        ];
        var somme = l.its.reduce(function (t, f) { return t + (f.montant || 0); }, 0);
        u.modal(l.titre, '<p class="pil-note">' + l.its.length.toLocaleString('fr-FR') + ' facture' + (l.its.length > 1 ? 's' : '') + ' · ' + Math.round(somme).toLocaleString('fr-FR') + ' €. ' + esc(l.note || '')
            + (l.its.length > 400 ? ' Les 400 premières sont affichées ; l’export les donne toutes.' : '') + '</p><div class="table-wrap-tall">'
            + u.table(cols, l.its.slice(0, 400), { vide: 'Aucune facture.' }) + '</div>',
            [{ label: 'Exporter cette liste (Excel)', action: function () { exporterControle({ code: l.code, items: l.its }); } }, { label: 'Fermer' }], { large: true });
        // Si la fenêtre ne sait pas porter un bouton d'action, l'export est ajouté à la main.
        setTimeout(function () { var pied = document.querySelector('#modal-overlay .modal-foot'); if (!pied) return;
            var deja = [].slice.call(pied.querySelectorAll('button')).filter(function (b) { return /Exporter/.test(b.textContent); })[0];
            if (deja) { deja.onclick = function (ev) { ev.stopPropagation(); ev.preventDefault(); exporterControle({ code: l.code, items: l.its }); }; return; }
            var e = document.createElement('button'); e.type = 'button'; e.className = 'btn btn-ghost btn-sm'; e.textContent = 'Exporter cette liste (Excel)';
            e.onclick = function () { exporterControle({ code: l.code, items: l.its }); }; pied.insertBefore(e, pied.firstChild); }, 60);
        return true;
    }
    function ouvrirLotCircuit(l, cas) {
        var OPX = G.LioraOperationnel;
        if (l && l.motifs && ouvrirLotMotifs(l)) return;
        if (!l || !OPX || !OPX.montrerFactures) return;
        var LISTE = l.cpf ? CAS_CORRIGER : CAS_CORRIGER_GENERAL;
        var its = cas ? l.its.filter(function (f) { return casCorriger(f, l.cpf) === cas; }) : l.its;
        var lib = cas ? (LISTE.filter(function (c) { return c[0] === cas; })[0] || [])[1] : '';
        OPX.montrerFactures(l.titre, its, cas ? lib + '.' : l.note);
        setTimeout(function () {
            var modale = document.querySelector('#modal-overlay .modal'), pied = modale && modale.querySelector('.modal-foot'), corps = modale && modale.querySelector('.modal-body');
            if (!modale) return;
            if (pied) [].slice.call(pied.querySelectorAll('button')).forEach(function (b) { if (/^Exporter en Excel/.test(b.textContent.trim())) b.style.display = 'none'; });
            if (pied && !pied.querySelector('.v3-export-lot')) {
                var e = document.createElement('button'); e.type = 'button'; e.className = 'btn btn-ghost btn-sm v3-export-lot'; e.textContent = 'Exporter cette liste (Excel)';
                e.onclick = function () { exporterControle({ code: l.code + (cas ? '-' + cas : ''), items: its }); }; pied.insertBefore(e, pied.firstChild);
            }
            if (l.filtres && corps && !corps.querySelector('.v3-filtre-cas')) {
                var compte = {}; l.its.forEach(function (f) { var k = casCorriger(f, l.cpf); compte[k] = (compte[k] || 0) + 1; });
                var boite = document.createElement('p'); boite.className = 'v3-filtre-cas';
                boite.innerHTML = '<label for="v3-cas-corriger">Filtrer :</label> <select id="v3-cas-corriger" class="v3-circuit-choix"><option value="">Toutes les factures — '
                    + l.its.length.toLocaleString('fr-FR') + '</option>' + LISTE.map(function (c) {
                        return '<option value="' + c[0] + '"' + (c[0] === cas ? ' selected' : '') + (compte[c[0]] ? '' : ' disabled') + '>' + esc(c[1]) + ' — ' + (compte[c[0]] || 0).toLocaleString('fr-FR') + '</option>'; }).join('') + '</select>';
                corps.insertBefore(boite, corps.firstChild);
                boite.querySelector('select').onchange = function () { ouvrirLotCircuit(l, this.value || null); };
            }
        }, 60);
    }

    function carteEdofOperationnel() {
        var st = etat(), OPX = G.LioraOperationnel, hote = $('#v3-op-edof');
        if (!hote || !st || !OPX) return;
        var hp = function (f) { return f.role !== 'sellsy' && (f.presenceRoles || [f.role]).indexOf('payees') < 0; };
        // « Le circuit : » puis une vignette par financement. Le CPF se lit
        // d'après EDOF ; les autres, d'après les étapes du circuit Monday.
        var libelles = {}; (st.rules || R.DEFAULT_ECHEANCE_RULES || []).forEach(function (r) { libelles[r.key] = r.label; });
        var nonReglees = (st.factures || []).filter(function (f) { return hp(f) && !f.paye && !f.groupeTechnique && f.role !== 'technique' && f.role !== 'ignore'; });
        // Payées (EDOF, grand livre, avoir…) mais toujours dans un tableau des non payées : à rectifier dans Monday.
        var payeesADeplacer = (st.factures || []).filter(function (f) { return hp(f) && f.paye && !f.groupeTechnique && f.role !== 'technique' && f.role !== 'ignore'; });
        var parFin = {};
        nonReglees.concat(payeesADeplacer).forEach(function (f) { var k = f.financement || 'INCONNU'; parFin[k] = (parFin[k] || 0) + 1; });
        var fins = Object.keys(parFin).sort(function (a, b) { return (b === 'CPF') - (a === 'CPF') || parFin[b] - parFin[a]; });
        if (fins.indexOf(CIRCUIT_FIN) < 0) CIRCUIT_FIN = fins[0] || 'CPF';
        var nomFin = function (k) { return libelles[k] || (k === 'INCONNU' ? 'Non renseigné' : k); };
        var tete = '<div class="v3-circuit-tete"><h3><label for="v3-circuit-fin">Le circuit :</label></h3><select id="v3-circuit-fin" class="v3-circuit-choix">' + fins.map(function (k) {
            return '<option value="' + esc(k) + '"' + (k === CIRCUIT_FIN ? ' selected' : '') + '>' + esc(nomFin(k)) + ' — ' + parFin[k].toLocaleString('fr-FR') + ' factures</option>'; }).join('') + '</select></div>';
        var brancherTete = function () {
            var choix = hote.querySelector('#v3-circuit-fin'); if (choix) choix.onchange = function () { CIRCUIT_FIN = choix.value; carteEdofOperationnel(); };
            hote.querySelectorAll('[data-edof-lot]').forEach(function (b) { b.onclick = function () { ouvrirLotCircuit(EDOF_LOTS[+b.dataset.edofLot], null); }; });
            hote.querySelectorAll('[data-edof-export]').forEach(function (b) { b.onclick = function () { var l = EDOF_LOTS[+b.dataset.edofExport]; if (l) exporterControle({ code: l.code, items: l.its }); }; });
        };
        var parcours = '';
        {
            EDOF_LOTS = [];
            var its = nonReglees.filter(function (f) { return (f.financement || 'INCONNU') === CIRCUIT_FIN; });
            var payFin = payeesADeplacer.filter(function (f) { return (f.financement || 'INCONNU') === CIRCUIT_FIN; });
            var somme = function (l) { return Math.round(l.reduce(function (t, f) { return t + (f.montant || 0); }, 0)).toLocaleString('fr-FR') + ' €'; };
            var cles = {}; (OPX.CIRCUIT || []).forEach(function (e) { cles[e.k] = e; });
            var dans = function (k) { return its.filter(function (f) { return OPX.etapeDe(f) === k; }); };
            var hors = its.filter(function (f) { return !cles[OPX.etapeDe(f)]; });
            var echue = function (f) { return f.retardJours != null ? f.retardJours > 0 : f.etat === 'En retard'; };
            var nom = nomFin(CIRCUIT_FIN);
            // La règle d'échéance qui fait entrer une facture dans chaque étape, écrite en petit sous l'étape.
            var regleFin = (st.rules || []).filter(function (x) { return x.key === CIRCUIT_FIN; })[0] || {};
            var noteEch = String(regleFin.note || 'échéance calculée').replace(/\s+—.*$/, '');
            var minus = noteEch.charAt(0).toLowerCase() + noteEch.slice(1);
            var regV3 = (G.LioraV3Regles && G.LioraV3Regles.reglages && G.LioraV3Regles.reglages()) || {};
            var jPayable = +((regV3.controle || {}).cpfPayable) > 0 ? +regV3.controle.cpfPayable : 45, jReco = regleFin.jours != null ? regleFin.jours : 60;
            var REGLE_ETAPE = CIRCUIT_FIN === 'CPF'
                ? { ctl: 'avant fin de formation + ' + jPayable + ' jours', adv: 'de fin de formation + ' + jPayable + ' jours à + ' + jReco + ' jours',
                    rec: 'à partir de fin de formation + ' + jReco + ' jours', fin: 'après relance restée sans effet', cor: 'facture payée, ou à rectifier' }
                : { ctl: 'avant l’échéance : ' + minus, adv: 'avant l’échéance, facture à rendre payable', rec: 'après l’échéance : ' + minus,
                    fin: 'après relance restée sans effet', cor: 'facture payée, ou à rectifier' };
            var vignette = function (n, l, titre, quoi, faire, code, classe) {
                EDOF_LOTS.push({ titre: nom + ' — ' + titre, its: l, note: quoi, code: 'circuit-' + CIRCUIT_FIN.toLowerCase() + '-' + code });
                var i = EDOF_LOTS.length - 1;
                return '<div class="v3-edof-tuile ' + (classe || '') + '"><span class="v3-edof-rang">' + n + '</span><span class="v3-edof-nb">'
                    + (l.length ? '<button type="button" class="op-lien" data-edof-lot="' + i + '" title="Voir ces factures"><b>' + l.length.toLocaleString('fr-FR') + '</b></button>' : '<b>0</b>')
                    + '</span><span class="v3-edof-titre">' + esc(titre) + '</span><span class="v3-edof-mt">' + somme(l)
                    + (l.length ? ' <button type="button" class="v3-edof-exp" data-edof-export="' + i + '">exporter</button>' : '') + '</span>'
                    + '<span class="op-pied">' + esc(quoi) + '</span>'
                    + (REGLE_ETAPE[code === 'sous-controle' ? 'ctl' : code] ? '<span class="v3-edof-regle">Règle : ' + esc(REGLE_ETAPE[code === 'sous-controle' ? 'ctl' : code]) + '</span>' : '')
                    + '<span class="v3-edof-faire">→ ' + esc(faire) + '</span></div>';
            };
            var horsEchues = hors.filter(echue), n = 1;
            var tuiles = vignette(n++, hors.filter(function (f) { return !echue(f); }), 'Sous contrôle', 'Avant échéance, dans aucune étape du circuit.', 'rien à faire pour l’instant', 'sous-controle');
            (OPX.CIRCUIT || []).forEach(function (e) {
                var lot = dans(e.k), quoi = 'Groupes Monday de l’étape « ' + e.n + ' » (' + e.svc + ').';
                if (e.k === 'cor' && payFin.length) {
                    quoi = 'Dont ' + payFin.length + ' payées mais pas encore déplacées dans les payées (à rectifier dans Monday), et ' + lot.length + ' dans un groupe Monday du circuit « Corriger ».';
                    lot = lot.concat(payFin);
                }
                tuiles += vignette(n++, lot, e.n, quoi, e.svc + ' · cible ' + e.cible + ' j', e.k, e.k === 'rec' ? 'fort' : '');
                if (e.k === 'cor') { EDOF_LOTS[EDOF_LOTS.length - 1].filtres = true; EDOF_LOTS[EDOF_LOTS.length - 1].cpf = CIRCUIT_FIN === 'CPF' && !!EDOF; }
            });
            parcours = '<p class="pil-note">Les ' + (its.length + payFin.length).toLocaleString('fr-FR') + ' factures ' + esc(nom) + ' encore dans les tableaux Monday des non payées, rangées dans l’ordre du circuit : '
                + its.length.toLocaleString('fr-FR') + ' non réglées' + (payFin.length ? ' et ' + payFin.length.toLocaleString('fr-FR') + ' payées à déplacer (dans « Corriger »)' : '') + '. '
                + 'Chaque nombre ouvre ses factures ; « exporter » en donne la liste Excel. Cette carte ne suit pas les filtres de période.</p>'
                + '<div class="v3-edof-grille">' + tuiles + '</div>'
                + (horsEchues.length ? (function () { EDOF_LOTS.push({ titre: nom + ' — échues, dans aucune étape', its: horsEchues, note: 'Échéance passée, mais le groupe Monday n’est rangé dans aucune étape du circuit.', code: 'circuit-' + CIRCUIT_FIN.toLowerCase() + '-echues-hors-etape' });
                    var i = EDOF_LOTS.length - 1;
                    return '<p class="op-alerte"><button type="button" class="op-lien" data-edof-lot="' + i + '"><b>' + horsEchues.length.toLocaleString('fr-FR') + '</b> factures échues</button> ('
                        + somme(horsEchues) + ') sont encore dans un groupe « en cours », hors de toute étape. <button type="button" class="v3-edof-exp" data-edof-export="' + i + '">exporter</button></p>'; })() : '');
        }
        if (CIRCUIT_FIN !== 'CPF' || !EDOF) {
            hote.innerHTML = '<div class="charts-grid"><div class="chart-card chart-wide">' + tete + parcours + detailGeneral() + '</div></div>';
            brancherTete();
            return;
        }
        // ── Le même niveau de détail que le CPF, pour un financement sans EDOF : retard × étape,
        //    factures payées à corriger, groupes Monday, et facturation à revérifier triée par motif.
        function detailGeneral() {
            var nomF = nomFin(CIRCUIT_FIN);
            var itsF = nonReglees.filter(function (f) { return (f.financement || 'INCONNU') === CIRCUIT_FIN; });
            var payF = payeesADeplacer.filter(function (f) { return (f.financement || 'INCONNU') === CIRCUIT_FIN; });
            var tousF = itsF.concat(payF);
            var e0 = function (l) { return Math.round(l.reduce(function (t, f) { return t + (f.montant || 0); }, 0)).toLocaleString('fr-FR') + ' €'; };
            var pose = function (l, titre, note, code) { EDOF_LOTS.push({ titre: titre, its: l, note: note, code: 'circuit-' + CIRCUIT_FIN.toLowerCase() + '-' + code }); return EDOF_LOTS.length - 1; };
            var nbL = function (l, i) { return l.length ? '<button type="button" class="op-lien" data-edof-lot="' + i + '" title="Voir ces factures"><b>' + l.length.toLocaleString('fr-FR') + '</b></button>' : '<b>0</b>'; };
            var ex = function (l, i) { return l.length ? ' <button type="button" class="v3-edof-exp" data-edof-export="' + i + '">exporter</button>' : ''; };
            var ligne = function (l, lib, note, code) { var i = pose(l, nomF + ' — ' + lib, note, code); return nbL(l, i) + ' ' + esc(lib) + ' <span class="op-pied">· ' + e0(l) + ex(l, i) + '</span>'; };
            var etapeM = function (f) { var k = OPX.etapeDe(f); return cles[k] ? k : 'cours'; };
            var pointee = function (f) { return f.grandLivreSoldee || f.soldeeParAvoir; };

            // 1. Retard × étape du circuit
            var COLS = [{ k: 'ctl', n: 'Sous contrôle' }].concat((OPX.CIRCUIT || []).map(function (e) { return { k: e.k, n: e.n }; })).concat([{ k: 'hors', n: 'Échue, hors étape' }]);
            var colDe = function (f) { if (f.paye) return 'cor'; var k = OPX.etapeDe(f); if (cles[k]) return k; return echue(f) ? 'hors' : 'ctl'; };
            var r = function (f) { return f.retardJours; };
            var LIGNES = [
                { n: '1 · Pas encore échue', faire: 'rien à faire, sauf si elle est déjà relancée', l: itsF.filter(function (f) { return f.dateEcheance && !(r(f) > 0); }), code: 'non-echue' },
                { n: '2 · Échue depuis 1 à 30 jours', faire: 'première relance', l: itsF.filter(function (f) { return r(f) > 0 && r(f) <= 30; }), code: 'retard-1-30' },
                { n: '3 · Échue depuis 31 à 90 jours', faire: 'relance suivie', l: itsF.filter(function (f) { return r(f) > 30 && r(f) <= 90; }), code: 'retard-31-90' },
                { n: '4 · Échue depuis 91 à 360 jours', faire: 'relance ferme, envisager la clôture', l: itsF.filter(function (f) { return r(f) > 90 && r(f) <= 360; }), code: 'retard-91-360' },
                { n: '5 · Échue depuis plus de 360 jours', faire: 'clôture ou contentieux', l: itsF.filter(function (f) { return r(f) > 360; }), code: 'retard-plus-360' },
                { n: '6 · Échéance impossible à calculer', faire: 'compléter la date manquante', l: itsF.filter(function (f) { return !f.dateEcheance; }), code: 'echeance-inconnue' },
                { n: '7a · Payée, pointée en comptabilité', faire: 'rectifier Monday : déplacer dans les payées', l: payF.filter(pointee), code: 'payee-pointee' },
                { n: '7b · Payée, non pointée en comptabilité', faire: 'pointer, puis rectifier Monday', l: payF.filter(function (f) { return !pointee(f); }), code: 'payee-non-pointee' }
            ];
            var cell = function (l, titre, code) { if (!l.length) return '<td class="n v3-vide">—</td>';
                var i = pose(l, titre, 'Ancienneté du retard et étape du circuit Monday croisées.', code);
                return '<td class="n">' + nbL(l, i) + '<br><span class="op-pied">' + e0(l) + '</span></td>'; };
            var matrice = '<div class="table-wrap"><table class="op-t v3-croise"><thead><tr><th>Où en est la facture ↓ &nbsp;/&nbsp; étape du circuit →</th>'
                + COLS.map(function (c) { return '<th class="n">' + esc(c.n) + '</th>'; }).join('') + '<th class="n">Total</th></tr></thead><tbody>'
                + LIGNES.map(function (L) { var i = pose(L.l, nomF + ' — ' + L.n, 'Factures ' + nomF + ' dans cette situation.', L.code);
                    return '<tr><td><b>' + esc(L.n) + '</b><br><span class="op-pied">→ ' + esc(L.faire) + '</span></td>'
                        + COLS.map(function (c) { return cell(L.l.filter(function (f) { return colDe(f) === c.k; }), nomF + ' — ' + L.n + ' × ' + c.n, L.code + '-' + c.k); }).join('')
                        + '<td class="n"><b>' + nbL(L.l, i) + '</b><br><span class="op-pied">' + e0(L.l) + ex(L.l, i) + '</span></td></tr>'; }).join('')
                + '<tr class="total"><td>Total</td>' + COLS.map(function (c) { return cell(tousF.filter(function (f) { return colDe(f) === c.k; }), nomF + ' — ' + c.n, 'total-' + c.k); }).join('')
                + '<td class="n"><b>' + tousF.length.toLocaleString('fr-FR') + '</b></td></tr></tbody></table></div>';

            // 2. Les payées à corriger, et leurs groupes
            var parG = {}; payF.forEach(function (f) { var k = (f.groupe || '—') + '|' + (f.board || ''); (parG[k] = parG[k] || []).push(f); });
            var lignesG = Object.keys(parG).sort(function (a, b) { return parG[b].length - parG[a].length; }).map(function (k) { var l = parG[k], g = k.split('|')[0], t = k.split('|')[1];
                var i = pose(l, nomF + ' payées — ' + g, 'Factures payées encore dans le groupe Monday « ' + g + ' » (' + t + ').', 'payees-' + g.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 30));
                var np = l.filter(function (f) { return !pointee(f); }).length;
                return '<tr><td>' + esc(g) + '<br><span class="op-pied">' + esc(t) + '</span></td><td class="n">' + nbL(l, i) + '</td><td class="n">' + e0(l) + '</td><td class="n">'
                    + (np ? np + ' non pointée' + (np > 1 ? 's' : '') : 'toutes pointées') + '</td><td class="n">' + ex(l, i) + '</td></tr>'; }).join('');
            var blocPayees = payF.length ? '<div class="v3-edof-detail"><div><b>Les ' + payF.length.toLocaleString('fr-FR') + ' factures payées, à corriger</b><ul class="v3-edof-sous">'
                + '<li>' + ligne(payF.filter(pointee), 'pointées en comptabilité → rectifier Monday', 'Payées et lettrées au grand livre (ou annulées par avoir) : il ne reste qu’à les déplacer dans les payées dans Monday.', 'payee-pointee') + '</li>'
                + '<li>' + ligne(payF.filter(function (f) { return !pointee(f); }), 'non pointées → à pointer, puis rectifier Monday', 'Monday les donne payées, mais le grand livre ne les montre pas soldées.', 'payee-non-pointee') + '</li></ul>'
                + '<p class="op-pied">Pointée = lettrée au grand livre arrêté au ' + String((GL_INFO && GL_INFO.arrete) || '').split('-').reverse().join('/') + '.</p></div>'
                + '<div><b>Dans quel groupe Monday elles sont encore</b><div class="pil-defile"><table class="op-t"><thead><tr><th>Groupe Monday</th><th class="n">Factures</th><th class="n">Montant</th>'
                + '<th class="n">Pointage</th><th></th></tr></thead><tbody>' + lignesG + '</tbody></table></div></div></div>' : '';

            // 3. Facturation à revérifier, un motif par facture
            var parNumero = {}; tousF.forEach(function (f) { var k = f.cle || f.numero; if (k) (parNumero[k] = parNumero[k] || []).push(f); });
            var VER = [
                ['Payée, mais encore relancée', 'La facture est réglée ; elle est pourtant dans une étape de relance ou de clôture.',
                    payF.filter(function (f) { var k = etapeM(f); return k === 'rec' || k === 'fin'; }), 'payee-encore-relancee'],
                ['Règlement reçu en comptabilité, non lettré', 'Un règlement non lettré correspond probablement à cette facture : à pointer.',
                    itsF.filter(function (f) { return f.reglementPropose; }), 'reglement-non-lettre'],
                ['Échue, mais encore dans un groupe « en cours »', 'L’échéance est passée et la facture n’est dans aucune étape du circuit : personne ne la suit.',
                    itsF.filter(function (f) { return echue(f) && etapeM(f) === 'cours'; }), 'echue-hors-etape'],
                ['Échue, mais encore dans « Rendre payable »', 'L’échéance est passée : la facture devrait être en recouvrement.',
                    itsF.filter(function (f) { return echue(f) && etapeM(f) === 'adv'; }), 'echue-encore-rendre-payable'],
                ['En recouvrement avant son échéance', 'La facture est dans un groupe de relance alors que son échéance calculée n’est pas passée : arrivée trop tôt, ou date fausse dans Monday.',
                    itsF.filter(function (f) { return etapeM(f) === 'rec' && f.dateEcheance && !echue(f); }), 'recouvrement-trop-tot'],
                ['Plus de 360 jours de retard, pas en clôture', 'Créance très ancienne toujours hors de l’étape « Clôture ».',
                    itsF.filter(function (f) { return r(f) > 360 && etapeM(f) !== 'fin'; }), 'tres-ancienne-hors-cloture'],
                ['Facture saisie deux fois dans Monday', 'La même facture apparaît sur plusieurs lignes ou plusieurs tableaux Monday.',
                    tousF.filter(function (f) { return f.doublonOperationnel || f.doublonPayees; }), 'doublon-monday'],
                ['Échéance impossible à calculer', 'Une date manque (facture, début ou fin de formation) : la facture sort des taux.',
                    itsF.filter(function (f) { return !f.dateEcheance; }), 'echeance-inconnue'],
                ['Montant absent ou nul', 'Sans montant, la facture ne pèse pas dans les indicateurs en euros.',
                    tousF.filter(function (f) { return f.montant == null || f.montant === 0; }), 'montant-absent'],
                ['Facture refaite (ancienne facture connue)', 'L’échéance est calculée sur la date de la facture d’origine : vérifier que l’ancienne facture est bien annulée.',
                    itsF.filter(function (f) { return (f.anciennesFactures || []).length; }), 'facture-refaite']
            ];
            var idDe = function (f) { return f.id || f.cle || f.numero; }, motifs = {}, fact = {};
            VER.forEach(function (v) { v[2].forEach(function (f) { var k = idDe(f); (motifs[k] = motifs[k] || []).push(v[0]); fact[k] = f; }); });
            var toutes = Object.keys(fact).map(function (k) { var f = fact[k]; f.__motif = motifs[k][0]; f.__autresMotifs = motifs[k].slice(1); return f; });
            var rang = {}; VER.forEach(function (v, i) { rang[v[0]] = i; });
            toutes.sort(function (x, y) { return rang[x.__motif] - rang[y.__motif] || (y.montant || 0) - (x.montant || 0); });
            var lignesM = VER.map(function (v) { var l = toutes.filter(function (f) { return f.__motif === v[0]; });
                var i = pose(l, nomF + ' — à revérifier — ' + v[0], v[1], 'a-reverifier-' + v[3]); EDOF_LOTS[i].motifs = true; EDOF_LOTS[i].code = 'a-reverifier-' + CIRCUIT_FIN.toLowerCase() + '-' + v[3];
                var aussi = v[2].length - l.length;
                return '<tr' + (l.length ? '' : ' class="v3-rien"') + '><td><span class="v3-motif">' + esc(v[0]) + '</span><br><span class="op-pied">' + esc(v[1])
                    + (aussi > 0 ? ' ' + aussi + ' autre(s) facture(s) ont aussi ce motif, mais sont rangées sous un motif plus important.' : '') + '</span></td><td class="n">' + nbL(l, i)
                    + '</td><td class="n">' + (l.length ? e0(l) : '—') + '</td><td class="n">' + ex(l, i) + '</td></tr>'; }).join('');
            var iT = pose(toutes, nomF + ' — facturation à revérifier, triée par motif', 'Chaque facture est rangée sous son motif le plus important.', 'x');
            EDOF_LOTS[iT].motifs = true; EDOF_LOTS[iT].code = 'a-reverifier-' + CIRCUIT_FIN.toLowerCase() + '-toutes';
            var aVerif = '<div class="v3-averifier"><h3 class="v3-circuit-sous">Facturation à revérifier <span class="op-cnt">' + toutes.length.toLocaleString('fr-FR') + ' factures</span></h3>'
                + '<p class="pil-note">Les factures ' + esc(nomF) + ' qui posent question, <b>triées par motif</b>. Chaque facture n’est comptée qu’une fois, sous son motif le plus important. '
                + (toutes.length ? '<button type="button" class="btn btn-ghost btn-sm" data-edof-lot="' + iT + '">Voir les ' + toutes.length.toLocaleString('fr-FR') + ' factures triées par motif</button> '
                    + '<button type="button" class="btn btn-ghost btn-sm" data-edof-export="' + iT + '">Exporter le tout (Excel)</button>' : '') + '</p>'
                + '<table class="op-t"><thead><tr><th>Motif</th><th class="n">Factures</th><th class="n">Montant</th><th></th></tr></thead><tbody>' + lignesM
                + '<tr class="total"><td>Total</td><td class="n"><b>' + toutes.length.toLocaleString('fr-FR') + '</b></td><td class="n">' + e0(toutes) + '</td><td></td></tr></tbody></table></div>';

            var regle = (st.rules || []).filter(function (x) { return x.key === CIRCUIT_FIN; })[0];
            return '<div class="chart-header v3-circuit-sep"><h3 class="v3-circuit-sous">' + esc(nomF) + ' — ancienneté du retard croisée avec les étapes du circuit</h3></div>'
                + matrice + blocPayees + aVerif;
        }
        var cpf = (st.factures || []).filter(function (f) { return f.role !== 'sellsy' && (f.financement === 'CPF' || f.edof); });
        var ouvertes = cpf.filter(hp);
        var verse = ouvertes.filter(function (f) { return f.edofVerse; });
        var nonVersees = ouvertes.filter(function (f) { return !f.edofVerse && !f.paye; });
        var an = function (f) { var d = f.dateFacture && R.parseDate(f.dateFacture); return d ? d.getFullYear() : 0; };
        var anneeRef = new Date().getFullYear();
        // Le statut du dossier EDOF, ramené à trois familles.
        var statutDossier = function (f) { var d = f.edofDossier; if (!d) return '';
            if (/annul|refus|non r[ée]alis/i.test(d.statut)) return 'annule';
            if (/service fait/i.test(d.statut)) return 'servicefait';
            return 'encours'; };
        // La session du dossier est-elle terminée à la date d'arrêté ? (fin de session EDOF)
        var jourArrete = (st.filtres && st.filtres.dateRef && R.parseDate(st.filtres.dateRef)) || new Date();
        var sessionFinie = function (f) { var d = f.edofDossier, x = d && d.fin && R.parseDate(d.fin); return !!x && +x < +jourArrete; };
        var lots = {
            rien: nonVersees.filter(function (f) { return !f.edof && !f.edofAvance; }),
            avance: nonVersees.filter(function (f) { return !f.edof && f.edofAvance; }),
            introuvable: nonVersees.filter(function (f) { return !f.edof && !f.edofDossier; }),
            annule: nonVersees.filter(function (f) { return !f.edof && statutDossier(f) === 'annule'; }),
            enFormation: nonVersees.filter(function (f) { return !f.edof && statutDossier(f) === 'encours'; }),
            aDeposer: nonVersees.filter(function (f) { return !f.edof && statutDossier(f) === 'servicefait'; }),
            sessionFinie: nonVersees.filter(function (f) { return !f.edof && statutDossier(f) === 'encours' && sessionFinie(f); }),
            sessionEnCours: nonVersees.filter(function (f) { return !f.edof && statutDossier(f) === 'encours' && !sessionFinie(f); }),
            attente: nonVersees.filter(function (f) { return f.edof && f.edof.statut === 'En attente'; }),
            rejet: nonVersees.filter(function (f) { return f.edof && f.edof.statut === 'Rejeté'; }),
            pointee: verse.filter(function (f) { return f.grandLivreSoldee; }),
            nonPointee: verse.filter(function (f) { return !f.grandLivreSoldee && f.grandLivre; }),
            absente: verse.filter(function (f) { return !f.grandLivre; })
        };
        // POUR UN DOSSIER ANNULÉ OU REFUSÉ : y a-t-il un autre dossier EDOF, ou une autre facture Monday, au nom du même apprenant ?
        var parApprenant = {};
        (st.factures || []).forEach(function (g) { if (g.role === 'sellsy' || !g.apprenant) return; var k = nomCle(g.apprenant); if (k) (parApprenant[k] = parApprenant[k] || []).push(g); });
        var jourFR = function (d) { return String(d || '').split('-').reverse().join('/'); };
        lots.annule.forEach(function (f) {
            var d = f.edofDossier, nom = (EDOF.dossiers[d.numero] || [])[7] || nomCle(f.apprenant);
            f.__autresDossiers = (EDOF.parNom[nom] || []).filter(function (k) { return k !== d.numero && !/annul|refus|non r[ée]alis/i.test(EDOF.dossiers[k][0]); }).map(function (k) {
                var x = EDOF.dossiers[k], fa = (EDOF.parDossier[k] || []).map(function (n) { var l = EDOF_BRUT.factures[n]; return n + ' ' + l[2].toLowerCase(); });
                return k + ' — ' + x[0] + (x[2] ? ', fin de session ' + jourFR(x[2]) : '') + (fa.length ? ', facture EDOF : ' + fa.join(', ') : ', pas de facture EDOF'); });
            f.__autresFactures = (parApprenant[nomCle(f.apprenant)] || []).filter(function (g) { return g !== f && g.cle !== f.cle; }).map(function (g) {
                return (g.numero || '?') + ' — ' + Math.round(g.montant || 0).toLocaleString('fr-FR') + ' €, ' + (g.paye ? 'payée' : 'non payée') + ', ' + (g.groupe || g.board || ''); });
        });
        lots.annuleAutreDossier = lots.annule.filter(function (f) { return f.__autresDossiers.length; });
        lots.annuleAutreFacture = lots.annule.filter(function (f) { return !f.__autresDossiers.length && f.__autresFactures.length; });
        lots.annuleSeul = lots.annule.filter(function (f) { return !f.__autresDossiers.length && !f.__autresFactures.length; });
        var avecAvance = nonVersees.filter(function (f) { return f.edofAvance; });
        var deLAnnee = nonVersees.filter(function (f) { return an(f) === anneeRef; });
        var rangees = cpf.filter(function (f) { return f.edofVerse && !hp(f); }).length;
        var eur0 = function (l) { return Math.round(l.reduce(function (t, f) { return t + (f.montant || 0); }, 0)).toLocaleString('fr-FR') + ' €'; };
        var poser = function (l, titre, note, code) { EDOF_LOTS.push({ titre: titre, its: l, note: note, code: code }); return EDOF_LOTS.length - 1; };
        var nbLien = function (l, i) { return l.length ? '<button type="button" class="op-lien" data-edof-lot="' + i + '" title="Voir ces factures"><b>' + l.length.toLocaleString('fr-FR') + '</b></button>' : '<b>0</b>'; };
        var exp = function (l, i) { return l.length ? ' <button type="button" class="v3-edof-exp" data-edof-export="' + i + '">exporter</button>' : ''; };
        var enLigne = function (l, lib, note, code) { var i = poser(l, 'CPF — ' + lib, note, code); return nbLien(l, i) + ' ' + esc(lib) + ' <span class="op-pied">· ' + eur0(l) + exp(l, i) + '</span>'; };
        var etape = function (n, l, titre, quoi, faire, note, code, classe) {
            var i = poser(l, 'CPF — ' + titre, note, code);
            return '<div class="v3-edof-tuile ' + (classe || '') + '"><span class="v3-edof-rang">' + n + '</span>'
                + '<span class="v3-edof-nb">' + nbLien(l, i) + '</span><span class="v3-edof-titre">' + esc(titre) + '</span>'
                + '<span class="v3-edof-mt">' + eur0(l) + exp(l, i) + '</span><span class="op-pied">' + quoi + '</span>'
                + '<span class="v3-edof-faire">→ ' + faire + '</span></div>';
        };
        // Les versées, groupe Monday par groupe Monday.
        var parGroupe = {};
        verse.forEach(function (f) { var k = (f.groupe || '—') + '|' + (f.board || ''); (parGroupe[k] = parGroupe[k] || []).push(f); });
        var lignesGroupes = Object.keys(parGroupe).sort(function (a, b) { return parGroupe[b].length - parGroupe[a].length; }).map(function (k) {
            var l = parGroupe[k], g = k.split('|')[0], t = k.split('|')[1];
            var i = poser(l, 'CPF versées par EDOF — ' + g, 'Factures « Versé » dans EDOF, encore dans le groupe Monday « ' + g + ' » (' + t + ').', 'edof-verse-' + g.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 30));
            var np = l.filter(function (f) { return !f.grandLivreSoldee; }).length;
            return '<tr><td>' + esc(g) + '<br><span class="op-pied">' + esc(t) + '</span></td><td class="n">' + nbLien(l, i) + '</td><td class="n">' + eur0(l) + '</td>'
                + '<td class="n">' + (np ? np + ' non pointée' + (np > 1 ? 's' : '') : 'toutes pointées') + '</td><td class="n">' + exp(l, i) + '</td></tr>';
        }).join('');
        var jour = function (d) { return String(d || '').split('-').reverse().join('/'); }, p = EDOF.periodes;
        // ── Les factures payées (versées par EDOF) vont dans « Corriger », en trois cas selon leur pointage.
        // Pennylane : pointée = lettrée au grand livre. Sellsy : d'après l'export Sellsy s'il est déposé,
        // sinon d'après le groupe Monday qui le dit (2.2.9 « sellsy pointé », 2.2.10 « non remonté sur Sellsy »).
        var sellsyParCle = (st.sellsy && (st.sellsy.lignes || []).length) ? true : null;
        var payees = {
            a: verse.filter(function (f) { return f.grandLivreSoldee && sellsyPointe(f) === 'oui'; }),
            b: verse.filter(function (f) { return f.grandLivreSoldee && sellsyPointe(f) !== 'oui'; }),
            c: verse.filter(function (f) { return !f.grandLivreSoldee; })
        };
        var sellsyInconnu = verse.filter(function (f) { return sellsyPointe(f) === 'inconnu'; }).length;
        // ── EDOF × circuit : chaque facture a une étape EDOF (ligne) et une étape du circuit Monday (colonne).
        var COLS = [{ k: 'ctl', n: 'Sous contrôle' }].concat((OPX.CIRCUIT || []).map(function (e) { return { k: e.k, n: e.n }; })).concat([{ k: 'hors', n: 'Échue, hors étape' }]);
        var autresPayees = ouvertes.filter(function (f) { return f.paye && !f.edofVerse; });
        var colDe = function (f) { if (f.edofVerse || f.paye) return 'cor'; var k = OPX.etapeDe(f); if (cles[k]) return k; return echue(f) ? 'hors' : 'ctl'; };
        var LIGNES = [
            { n: '0 · Dossier introuvable dans EDOF', faire: 'vérifier le numéro de dossier ou le nom de l’apprenant', l: lots.introuvable, code: 'edof-0-dossier-introuvable' },
            { n: '1a · Dossier annulé ou refusé, mais un autre dossier EDOF existe pour l’apprenant', faire: 'rattacher la facture au bon dossier', l: lots.annuleAutreDossier, code: 'edof-1a-annule-autre-dossier' },
            { n: '1b · Dossier annulé ou refusé, une autre facture existe dans Monday pour l’apprenant', faire: 'vérifier si la facture a été refaite, puis annuler le doublon', l: lots.annuleAutreFacture, code: 'edof-1b-annule-autre-facture' },
            { n: '1c · Dossier annulé ou refusé, rien d’autre au nom de l’apprenant', faire: 'annuler la facture, ou la refaire hors CPF', l: lots.annuleSeul, code: 'edof-1c-annule-seul' },
            { n: '2 · Dossier en formation, session en cours', faire: 'normal : attendre la fin de la session', l: lots.sessionEnCours, code: 'edof-2-session-en-cours' },
            { n: '2a · Session terminée, service fait pas encore validé', faire: 'déclarer la sortie de formation sur EDOF', l: lots.sessionFinie, code: 'edof-2a-service-fait-a-declarer' },
            { n: '2b · Service fait validé, facture pas déposée', faire: 'déposer la facture sur EDOF', l: lots.aDeposer, code: 'edof-2b-a-deposer' },
            { n: '3 · Déposée, en attente de règlement', faire: 'attendre le versement', l: lots.attente, code: 'edof-3-attente' },
            { n: '4 · Rejetée par EDOF', faire: 'corriger et redéposer', l: lots.rejet, code: 'edof-4-rejet' },
            { n: '5a · Payée, pointée sur Sellsy et Pennylane', faire: 'rectifier Monday : déplacer dans les payées', l: payees.a, code: 'edof-5a-pointee-rectifier-monday' },
            { n: '5b · Payée, pointée sur Pennylane, pas sur Sellsy', faire: 'rectifier Sellsy, puis Monday', l: payees.b, code: 'edof-5b-rectifier-sellsy-et-monday' },
            { n: '5c · Payée, non pointée', faire: 'pointer sur Pennylane et Sellsy, puis rectifier Monday', l: payees.c, code: 'edof-5c-a-pointer' },
            { n: '6 · Réglée ou annulée en comptabilité, sans versement EDOF connu', faire: 'vérifier, puis rectifier Monday', l: autresPayees, code: 'edof-6-reglee-hors-edof' }
        ];
        var cellule = function (l, titre, code) { if (!l.length) return '<td class="n v3-vide">—</td>';
            var i = poser(l, titre, 'Étape EDOF et étape du circuit Monday croisées.', code);
            return '<td class="n">' + nbLien(l, i) + '<br><span class="op-pied">' + eur0(l) + '</span></td>'; };
        var matrice = '<div class="table-wrap"><table class="op-t v3-croise"><thead><tr><th>Étape dans EDOF ↓ &nbsp;/&nbsp; étape du circuit →</th>'
            + COLS.map(function (c) { return '<th class="n">' + esc(c.n) + '</th>'; }).join('') + '<th class="n">Total</th></tr></thead><tbody>'
            + LIGNES.map(function (L) {
                var i = poser(L.l, 'CPF — ' + L.n, 'Factures CPF à cette étape EDOF.', L.code);
                return '<tr><td><b>' + esc(L.n) + '</b><br><span class="op-pied">→ ' + esc(L.faire) + '</span></td>'
                    + COLS.map(function (c) { return cellule(L.l.filter(function (f) { return colDe(f) === c.k; }), 'CPF — ' + L.n + ' × ' + c.n, L.code + '-' + c.k); }).join('')
                    + '<td class="n"><b>' + nbLien(L.l, i) + '</b><br><span class="op-pied">' + eur0(L.l) + exp(L.l, i) + '</span></td></tr>'; }).join('')
            + '<tr class="total"><td>Total</td>' + COLS.map(function (c) { var l = ouvertes.filter(function (f) { return colDe(f) === c.k; });
                    return cellule(l, 'CPF — ' + c.n, 'edof-circuit-' + c.k); }).join('')
            + '<td class="n"><b>' + ouvertes.length.toLocaleString('fr-FR') + '</b></td></tr></tbody></table></div>';

        // ── Facturation à revérifier : doublons, absences d'EDOF qui étonnent, incohérences.
        var norm = function (x) { return String(x || '').replace(/\s+/g, ''); };
        var tous = nonVersees.concat(verse), parDossier = {};
        tous.forEach(function (f) { var d = norm(f.numeroDossier || (f.edof && f.edof.dossier)); if (d) (parDossier[d] = parDossier[d] || []).push(f); });
        var enRelance = function (f) { var k = OPX.etapeDe(f); return k === 'rec' || k === 'fin'; };
        // La règle CPF : la facture passe en recouvrement à fin de formation + 60 jours
        // (le délai suit la règle d'échéance CPF de l'onglet Règles d'application).
        var regleCpf = (st.rules || []).filter(function (r) { return r.key === 'CPF'; })[0] || {};
        var delaiCpf = regleCpf.jours != null ? regleCpf.jours : 60;
        var reglagesV3 = (G.LioraV3Regles && G.LioraV3Regles.reglages && G.LioraV3Regles.reglages()) || {};
        var delaiPayable = +((reglagesV3.controle || {}).cpfPayable) > 0 ? +reglagesV3.controle.cpfPayable : 45;
        var jourRef = (st.filtres && st.filtres.dateRef && R.parseDate(st.filtres.dateRef)) || new Date();
        // L'étape attendue d'après la date de fin de formation : sous contrôle, puis rendre payable, puis recouvrement.
        var attendue = function (f) { var fin = f.dateFinFormation && R.parseDate(f.dateFinFormation); if (!fin) return null;
            var j = Math.floor((+jourRef - +fin) / 86400000); return j < delaiPayable ? 'ctl' : j < delaiCpf ? 'adv' : 'rec'; };
        var etapeMonday = function (f) { var k = OPX.etapeDe(f); return cles[k] ? k : 'cours'; };
        var VERIFS = [
            ['Dans « Rendre payable » avant fin de formation + ' + delaiPayable + ' jours', 'La facture est déjà dans un groupe « Rendre payable » alors que la fin de formation + ' + delaiPayable + ' jours n’est pas atteinte.',
                nonVersees.filter(function (f) { return etapeMonday(f) === 'adv' && attendue(f) === 'ctl'; }), 'payable-trop-tot'],
            ['Fin de formation + ' + delaiPayable + ' jours dépassée, mais pas encore dans « Rendre payable »', 'La facture devrait être en cours de dépôt (Rendre payable) : elle est encore dans un groupe « en cours ».',
                nonVersees.filter(function (f) { return attendue(f) === 'adv' && etapeMonday(f) === 'cours'; }), 'payable-en-retard'],
            ['En recouvrement avant fin de formation + ' + delaiCpf + ' jours', 'La facture est dans un groupe de relance alors que la fin de formation + ' + delaiCpf + ' jours n’est pas atteinte.',
                nonVersees.filter(function (f) { var a = attendue(f); return etapeMonday(f) === 'rec' && a && a !== 'rec'; }), 'recouvrement-trop-tot'],
            ['Fin de formation + ' + delaiCpf + ' jours dépassée, mais pas passée en recouvrement', 'La facture devrait être en recouvrement : elle est encore dans un groupe « en cours » ou dans « Rendre payable ».',
                nonVersees.filter(function (f) { var k = etapeMonday(f); return attendue(f) === 'rec' && (k === 'cours' || k === 'adv'); }), 'echue-pas-en-recouvrement'],
            ['Date de fin de formation manquante', 'Sans date de fin de formation, impossible de savoir quand la facture doit passer en recouvrement.',
                nonVersees.filter(function (f) { return !f.dateFinFormation; }), 'fin-de-formation-manquante'],
            ['Même dossier CPF sur plusieurs factures non payées', 'Plusieurs factures Monday portent le même numéro de dossier : doublon possible, ou facture refaite sans annuler l’ancienne.',
                tous.filter(function (f) { var d = norm(f.numeroDossier || (f.edof && f.edof.dossier)); return d && parDossier[d].length > 1; }), 'doublon-dossier'],
            ['Facture saisie deux fois dans Monday', 'La même facture apparaît sur plusieurs lignes ou plusieurs tableaux Monday.',
                tous.filter(function (f) { return f.doublonOperationnel || f.doublonPayees; }), 'doublon-monday'],
            ['Dossier déjà facturé dans EDOF sous un autre numéro', 'EDOF connaît une facture pour ce dossier, mais avec un autre numéro que celui de Monday : facture refaite, ou numéro mal saisi.',
                nonVersees.filter(function (f) { var d = norm(f.numeroDossier); return !f.edof && d && EDOF.parDossier[d]; }), 'autre-numero-edof'],
            ['Dossier annulé ou refusé — un autre dossier EDOF existe pour le même apprenant', 'La facture porte sur un dossier annulé ou refusé, mais l’apprenant a un autre dossier valide dans EDOF : la facture est probablement à rattacher à ce dossier. Les dossiers trouvés sont dans la liste et dans l’export.',
                lots.annuleAutreDossier, 'dossier-annule-autre-dossier'],
            ['Dossier annulé ou refusé — une autre facture existe dans Monday pour le même apprenant', 'La facture porte sur un dossier annulé ou refusé, et Monday contient une autre facture au nom du même apprenant : elle a peut-être été refaite. Les factures trouvées sont dans la liste et dans l’export.',
                lots.annuleAutreFacture, 'dossier-annule-autre-facture'],
            ['Dossier annulé ou refusé — aucune autre facture ni autre dossier', 'EDOF indique que le dossier est annulé, refusé ou non réalisé, et rien d’autre n’existe au nom de l’apprenant : la facture ne sera pas payée par le CPF.',
                lots.annuleSeul, 'dossier-annule-seul'],
            ['Service fait validé, facture pas déposée sur EDOF', 'Le dossier est facturable dans EDOF, mais aucune facture n’y a été déposée sous ce numéro.', lots.aDeposer, 'service-fait-non-depose'],
            ['Relancée, alors que la session n’est pas terminée dans EDOF', 'La facture est dans une étape de relance, mais la session du dossier EDOF est encore en cours : rien n’est dû pour l’instant.',
                lots.sessionEnCours.filter(enRelance), 'relance-session-en-cours'],
            ['Relancée, session terminée mais service fait pas validé dans EDOF', 'La session est terminée, mais le dossier est toujours « en formation » dans EDOF : tant que la sortie de formation n’est pas déclarée, la facture ne peut pas être déposée ni payée.',
                lots.sessionFinie.filter(enRelance), 'relance-service-fait-a-declarer'],
            ['Session terminée, service fait pas validé dans EDOF', 'Même situation, pour une facture qui n’est pas encore relancée : la sortie de formation est à déclarer sur EDOF.',
                lots.sessionFinie.filter(function (f) { return !enRelance(f); }), 'service-fait-a-declarer'],
            ['Montant de la facture différent du montant facturable EDOF', 'Le montant de la facture Monday s’écarte de plus d’un euro du montant facturable du dossier EDOF (avance déduite ou non).',
                nonVersees.filter(function (f) { var d = f.edofDossier, m = f.montant || 0; if (!d || d.montantFacturable == null || !m) return false;
                    var av = f.edofAvance ? f.edofAvance.montant : 0; return Math.abs(m - d.montantFacturable) > 1 && Math.abs(m - (d.montantFacturable - av)) > 1; }), 'ecart-montant-facturable'],
            ['Date de fin de formation différente entre Monday et EDOF', 'Plus de 7 jours d’écart entre la fin de formation saisie dans Monday et la fin de session du dossier EDOF : l’échéance calculée peut être fausse.',
                tous.filter(function (f) { var d = f.edofDossier, x = f.dateFinFormation && R.parseDate(f.dateFinFormation), y = d && d.fin && R.parseDate(d.fin);
                    return x && y && !f.datesViennentEdof && Math.abs(+x - +y) > 7 * 86400000; }), 'ecart-date-fin'],
            ['Versée par EDOF, mais encore relancée', 'EDOF a versé la facture ; elle est pourtant dans une étape de relance ou de clôture.',
                verse.filter(enRelance), 'versee-encore-relancee'],
            ['Montant versé différent du montant de la facture', 'Le règlement EDOF, avance comprise, s’écarte de plus d’un euro du montant de la facture Monday.',
                verse.filter(function (f) { var m = f.montant || 0, v = f.edof.montant, av = f.edofAvance ? f.edofAvance.montant : 0; return m > 0 && Math.abs(v - m) > 1 && Math.abs(v + av - m) > 1; }), 'ecart-montant'],
            ['Rejetée par EDOF', 'Statut « Rejeté » dans EDOF : à corriger et redéposer.', lots.rejet, 'rejet'],
            ['Dossier en contrôle dans EDOF', 'EDOF signale un contrôle sur le dossier.', tous.filter(function (f) { return (f.edof && f.edof.controle) || (f.edofDossier && f.edofDossier.controle); }), 'dossier-en-controle'],
            ['Dossier introuvable dans EDOF', 'Ni le numéro de dossier ni le nom de l’apprenant ne permettent de retrouver le dossier dans EDOF.', lots.introuvable, 'dossier-introuvable']
        ];
        // UNE FACTURE, UN MOTIF. Chaque facture est rangée sous son motif le plus important (l'ordre ci-dessous) ;
        // ses autres motifs éventuels sont gardés à côté. Les nombres s'additionnent donc sans doublon.
        var ORDRE = ['versee-encore-relancee', 'rejet', 'dossier-annule-autre-dossier', 'dossier-annule-autre-facture', 'dossier-annule-seul', 'service-fait-non-depose', 'relance-session-en-cours', 'relance-service-fait-a-declarer', 'service-fait-a-declarer', 'echue-pas-en-recouvrement', 'recouvrement-trop-tot', 'payable-en-retard',
            'payable-trop-tot', 'autre-numero-edof', 'doublon-dossier', 'doublon-monday', 'ecart-montant', 'ecart-montant-facturable', 'ecart-date-fin', 'dossier-en-controle', 'fin-de-formation-manquante', 'dossier-introuvable'];
        VERIFS.sort(function (x, y) { return ORDRE.indexOf(x[3]) - ORDRE.indexOf(y[3]); });
        var idDe = function (f) { return f.id || f.cle || f.numero; }, motifsDe = {}, factDe = {};
        VERIFS.forEach(function (v) { v[2].forEach(function (f) { var k = idDe(f); (motifsDe[k] = motifsDe[k] || []).push(v[0]); factDe[k] = f; }); });
        var toutes = Object.keys(factDe).map(function (k) { var f = factDe[k]; f.__motif = motifsDe[k][0]; f.__autresMotifs = motifsDe[k].slice(1); return f; });
        var rangMotif = {}; VERIFS.forEach(function (v, i) { rangMotif[v[0]] = i; });
        toutes.sort(function (x, y) { return rangMotif[x.__motif] - rangMotif[y.__motif] || (y.montant || 0) - (x.montant || 0); });
        var lignesMotifs = VERIFS.map(function (v) {
            var l = toutes.filter(function (f) { return f.__motif === v[0]; });
            var i = poser(l, 'À revérifier — ' + v[0], v[1], 'a-reverifier-' + v[3]); EDOF_LOTS[i].motifs = true;
            var aussi = v[2].length - l.length;
            return '<tr' + (l.length ? '' : ' class="v3-rien"') + '><td><span class="v3-motif">' + esc(v[0]) + '</span><br><span class="op-pied">' + esc(v[1])
                + (aussi > 0 ? ' ' + aussi + ' autre(s) facture(s) ont aussi ce motif, mais sont rangées sous un motif plus important.' : '') + '</span></td><td class="n">' + nbLien(l, i)
                + '</td><td class="n">' + (l.length ? eur0(l) : '—') + '</td><td class="n">' + exp(l, i) + '</td></tr>'; }).join('');
        var iToutes = poser(toutes, 'Facturation à revérifier — toutes les factures, triées par motif', 'Chaque facture est rangée sous son motif le plus important.', 'a-reverifier-toutes');
        EDOF_LOTS[iToutes].motifs = true;
        var aVerifier = '<div class="v3-averifier"><h3 class="v3-circuit-sous">Facturation à revérifier <span class="op-cnt">' + toutes.length.toLocaleString('fr-FR') + ' factures</span></h3>'
            + '<p class="pil-note">Les factures CPF qui posent question, <b>triées par motif</b>. Chaque facture n’est comptée qu’une fois, sous son motif le plus important ; '
            + 'ses autres motifs apparaissent dans la liste et dans l’export. '
            + '<button type="button" class="btn btn-ghost btn-sm" data-edof-lot="' + iToutes + '">Voir les ' + toutes.length.toLocaleString('fr-FR') + ' factures triées par motif</button> '
            + '<button type="button" class="btn btn-ghost btn-sm" data-edof-export="' + iToutes + '">Exporter le tout (Excel)</button></p>'
            + '<table class="op-t"><thead><tr><th>Motif</th><th class="n">Factures</th><th class="n">Montant</th><th></th></tr></thead><tbody>'
            + lignesMotifs
            + '<tr class="total"><td>Total</td><td class="n"><b>' + toutes.length.toLocaleString('fr-FR') + '</b></td><td class="n">' + eur0(toutes) + '</td><td></td></tr>'
            + '</tbody></table></div>';

        hote.innerHTML = '<div class="charts-grid"><div class="chart-card chart-wide">' + tete + parcours
            + '<div class="chart-header v3-circuit-sep"><h3 class="v3-circuit-sous">CPF — étapes EDOF croisées avec les étapes du circuit</h3>'
            + '<span class="pil-coin">export EDOF jusqu’au ' + jour(p.length && p[p.length - 1][1]) + ' · grand livre au ' + jour(GL_INFO && GL_INFO.arrete) + '</span></div>'
            + matrice
            + (verse.length ? '<div class="v3-edof-detail"><div><b>Étape 5 — les ' + verse.length.toLocaleString('fr-FR') + ' factures payées, à corriger</b><ul class="v3-edof-sous">'
                + '<li>' + enLigne(payees.a, 'pointées sur Sellsy et Pennylane → rectifier Monday', 'Payées (EDOF), lettrées au grand livre et pointées sur Sellsy : il ne reste qu’à les déplacer dans les payées dans Monday.', 'edof-5a-pointee-rectifier-monday') + '</li>'
                + '<li>' + enLigne(payees.b, 'pointées sur Pennylane, pas sur Sellsy → rectifier Sellsy et Monday', 'Payées (EDOF) et lettrées au grand livre, mais Sellsy ne les montre pas réglées, ou son état n’est pas connu.', 'edof-5b-rectifier-sellsy-et-monday') + '</li>'
                + '<li>' + enLigne(payees.c, 'non pointées → à pointer sur Pennylane et Sellsy', 'Payées (EDOF), mais pas lettrées au grand livre : ' + lots.nonPointee.length + ' y sont encore ouvertes, ' + lots.absente.length + ' n’y figurent pas (extrait arrêté au ' + jour(GL_INFO && GL_INFO.arrete) + ').', 'edof-5c-a-pointer') + '</li></ul>'
                + '<p class="op-pied">Pennylane : pointée = lettrée au grand livre. Sellsy : '
                + (sellsyParCle ? 'd’après votre export Sellsy' : 'd’après le groupe Monday (2.2.9, 2.2.10) — déposez l’export Sellsy dans Données pour un état exact')
                + (sellsyInconnu ? ' ; état Sellsy inconnu pour ' + sellsyInconnu + ' factures, comptées comme « pas sur Sellsy » ou « non pointées »' : '') + '.</p></div>'
                + '<div><b>Étape 5 — dans quel groupe Monday elles sont encore</b><div class="pil-defile"><table class="op-t"><thead><tr><th>Groupe Monday</th><th class="n">Factures</th>'
                + '<th class="n">Montant</th><th class="n">Pointage</th><th></th></tr></thead><tbody>' + lignesGroupes + '</tbody></table></div></div></div>' : '')
            + aVerifier
            + '</div></div>';
        brancherTete();
    }
    function brancherEdofOperationnel() { /* la carte est posée par l'onglet Opérationnel lui-même, à chaque rendu */ }

    async function lireJson(chemin) {
        try {
            var r = await fetch(chemin, { cache: 'no-cache' });
            return r.ok ? await r.json() : null;
        } catch (e) { return null; }
    }
    async function chargerComplements() {
        var res = await Promise.all([lireJson('donnees/reglements.json'), lireJson('donnees/anciennes-factures.json'), lireJson('donnees/rapprochements.json')]);
        var edof = await lireJson('donnees/edof.json');
        EDOF_BRUT = { factures: {}, avances: {}, periodes: [], dossiers: {} };
        if (edof && (edof.factures || edof.dossiers)) fusionnerEdof(edof);
        try { var garde = await S.get(CLE_EDOF, null); if (garde && (garde.factures || garde.dossiers)) { fusionnerEdof(garde); EDOF_IMPORT = garde; } } catch (e) { /* pas d'import gardé */ }
        poserEdof();
        if (res[2] && res[2].factures) {
            RAPPRO = {}; RAPPRO_INFO = res[2];
            Object.keys(res[2].factures).forEach(function (n) { RAPPRO[I.factureKey(n)] = res[2].factures[n]; });
        }
        var regl = res[0], anc = res[1];
        if (regl && regl.factures) {
            GL = Object.keys(regl.factures).map(function (numero) {
                var v = regl.factures[numero];
                return { numero: numero, cle: I.factureKey(numero),
                         soldee: v[0] !== 'o', parAvoir: v[0] === 'a',
                         datePaiement: v[0] === 'r' ? v[1] : null, dateAvoir: v[0] === 'a' ? v[1] : null,
                         montant: v[2] || null, dateFacture: v[3] || null };
            });
            GL_INFO = { arrete: regl.arrete, nb: GL.length };
            var parCle = {};
            GL.forEach(function (l) { parCle[l.cle] = l; });
            GL_INFO.parCle = parCle;
        }
        if (anc && anc.factures) {
            ANCIENNES = {};
            Object.keys(anc.factures).forEach(function (n) { ANCIENNES[I.factureKey(n)] = anc.factures[n]; });
        }
    }
    /** Date d'une ancienne facture : la pièce au grand livre, sinon le mois que porte son numéro. */
    function dateAncienne(numero) {
        var l = GL_INFO && GL_INFO.parCle[I.factureKey(numero)];
        var d = l && l.dateFacture && R.parseDate(l.dateFacture);
        if (d) return { date: d, sure: true };
        var m = /(\d{2})(\d{2})-\d+$/.exec(String(numero));
        if (m && +m[2] >= 1 && +m[2] <= 12) return { date: new Date(2000 + (+m[1]), +m[2], 0), sure: false };
        return null;
    }
    function appliquerAnciennes(factures) {
        var n = 0, sansDate = 0;
        if (!ANCIENNES) return;
        factures.forEach(function (f) {
            var anciens = f.cle && ANCIENNES[f.cle];
            if (!anciens) return;
            f.anciennesFactures = anciens;
            var meilleure = null;
            anciens.forEach(function (num) {
                var d = dateAncienne(num);
                if (d && (!meilleure || d.date < meilleure.date)) meilleure = { date: d.date, sure: d.sure, numero: num };
            });
            if (!meilleure) { sansDate++; return; }
            var actuelle = f.dateFactureRefaite || f.dateFacture;
            if (actuelle && +meilleure.date >= +R.parseDate(actuelle)) return;
            if (!f.dateFactureRefaite) f.dateFactureRefaite = f.dateFacture || null;
            f.dateFacture = meilleure.date;
            f.dateFactureVientAncienne = meilleure.numero;
            f.dateAncienneEstimee = !meilleure.sure;
            n++;
        });
        BILAN.anciennes = n; BILAN.anciennesSansDate = sansDate;
    }
    /**
     * POUR LE CPF, EDOF FAIT FOI. Une facture « Versé » dans l'export EDOF est
     * payée, à la date de règlement EDOF — avant le grand livre, avant Monday.
     * « Rejeté » et « En attente » sont signalés sans rien changer au calcul.
     * Une avance versée sur le dossier est notée sur la facture encore ouverte.
     */
    function appliquerEdof(factures) {
        var n = 0, nDossiers = 0, nDates = 0;
        BILAN.edof = 0; BILAN.edofDossiers = 0; BILAN.edofDates = 0;
        if (!EDOF) return;
        factures.forEach(function (f) {
            var e = f.cle && EDOF.factures[f.cle];
            f.edof = null;
            if (e) {
                f.edof = { montant: e[0], date: e[1], statut: e[2], dossier: e[3], controle: !!e[5] };
                if (e[2] === 'Versé') {
                    var d = R.parseDate(e[1]);
                    if (f.datePaiement && d && +R.parseDate(f.datePaiement) !== +d && !f.datePaiementMonday) f.datePaiementAvantEdof = f.datePaiement;
                    f.paye = true; f.edofVerse = true; f.soldeeParAvoir = false;
                    if (d) { f.datePaiement = d; f.dateVientDuGL = false; }
                    f.originePaiement = 'EDOF — versé';
                    n++;
                }
            }
            // Le dossier EDOF de la facture : par son numéro, sinon par le nom de l'apprenant quand il n'y a pas d'ambiguïté.
            var dossier = String(f.numeroDossier || (f.edof && f.edof.dossier) || '').replace(/\s+/g, '');
            var estCpf = f.financement === 'CPF' || /cpf/i.test(String(f.board || '')) || !!f.edof;
            if (estCpf && (!dossier || !EDOF.dossiers[dossier]) && f.apprenant) {
                var cands = EDOF.parNom[nomCle(f.apprenant)] || [];
                if (cands.length > 1 && f.montant) { var memeMontant = cands.filter(function (k) { var x = EDOF.dossiers[k]; return Math.abs((x[4] != null ? x[4] : x[3] || 0) - f.montant) <= 1; }); if (memeMontant.length === 1) cands = memeMontant; }
                if (cands.length === 1) { dossier = cands[0]; if (!f.numeroDossier) { f.numeroDossier = dossier; f.dossierVientEdof = true; nDossiers++; } }
            }
            var dd = dossier && EDOF.dossiers[dossier];
            f.edofDossier = dd ? { numero: dossier, statut: dd[0], debut: dd[1], fin: dd[2], montantFormation: dd[3], montantFacturable: dd[4], derniereAction: dd[5], controle: !!dd[6] } : null;
            if (dd && estCpf) {
                // Les dates de session EDOF complètent Monday ; elles ne remplacent pas une date déjà saisie.
                if (!f.dateFinFormation && dd[2]) { f.dateFinFormation = R.parseDate(dd[2]); f.datesViennentEdof = true; nDates++; }
                if (!f.dateDebutFormation && dd[1]) { f.dateDebutFormation = R.parseDate(dd[1]); f.datesViennentEdof = true; }
            }
            var a = dossier && EDOF.avances[dossier];
            f.edofAvance = (a && a[2] === 'Versé') ? { montant: a[0], date: a[1] } : null;
        });
        BILAN.edofDossiers = nDossiers; BILAN.edofDates = nDates;
        BILAN.edof = n;
    }
    function appliquerMontantsDossiers(factures, st) {
        var lignes = (st.dossiers && st.dossiers.lignes) || [];
        var parCle = {}, parDossier = {}, n = 0;
        lignes.forEach(function (l) {
            if (!l.montant) return;
            if (l.cle && parCle[l.cle] == null) parCle[l.cle] = l.montant;
            // Un dossier qui porte plusieurs montants ne permet pas de choisir.
            if (l.dossier) parDossier[l.dossier] = (parDossier[l.dossier] == null || parDossier[l.dossier] === l.montant) ? l.montant : false;
        });
        factures.forEach(function (f) {
            if (f.montant != null && f.montant !== 0) return;
            var m = (f.cle && parCle[f.cle]) || null;
            if (!m && f.numeroDossier) m = parDossier[R.norm(f.numeroDossier).replace(/\s+/g, '')] || null;
            if (m) { f.montant = m; f.montantVientDuDossier = true; n++; }
        });
        BILAN.montantsDossier = n;
    }
    function ecarterSellsyAberrantes(factures) {
        var ecartees = [];
        for (var i = factures.length - 1; i >= 0; i--) {
            var f = factures[i];
            if (f.source !== 'sellsy' && f.role !== 'sellsy') continue;
            var m = Number(f.montant) || 0;
            if (m < 0 || Math.abs(m) > PLAFOND_SELLSY) { ecartees.push({ numero: f.numero, client: f.client, montant: m }); factures.splice(i, 1); }
        }
        BILAN.sellsyEcartees = ecartees;
    }
    function brancherComplements() {
        var lireOrigine = I.lireDossiers;
        I.lireDossiers = function (rows) {
            var lu = lireOrigine.apply(this, arguments);
            try {
                var col = lu && lu.mapping && (lu.mapping.montant || lu.mapping.montantHT);
                if (col) (rows || []).forEach(function (r) {
                    var montant = I.parseMontant(r[col]);
                    if (!montant) return;
                    var v = function (champ) { var c = lu.mapping[champ]; return c == null || r[c] == null ? '' : String(r[c]).trim(); };
                    var numero = v('numero'), cle = /\d/.test(numero) ? I.factureKey(numero) : '';
                    var dossier = R.norm(v('numeroDossier')).replace(/\s+/g, '');
                    if (!cle && !dossier) return;
                    // Ligne d'appoint : elle ne porte que le montant, aucune date.
                    lu.lignes.push({ dossier: dossier, cle: cle, numero: numero, personne: '', client: v('client'),
                                     dateDebutFormation: null, dateFinFormation: null, montant: montant });
                });
            } catch (e) { /* le fichier garde son usage d'origine : les dates */ }
            return lu;
        };
        // Contrôle ajouté : la comptabilité dit « réglée », Monday la garde parmi
        // les non payées. Ce sont des lignes à déplacer vers les factures payées.
        var MX = G.LioraMetrics;
        if (MX && MX.qualite) {
            var qualiteOrigine = MX.qualite;
            MX.qualite = function (factures) {
                var liste = qualiteOrigine.apply(this, arguments) || [];
                try {
                    var its = (factures || []).filter(function (f) {
                        return f.grandLivreSoldee && f.role !== 'sellsy' && (f.presenceRoles || [f.role]).indexOf('payees') < 0;
                    });
                    if (its.length) {
                        var par = {};
                        its.forEach(function (f) { var k = f.financement || 'non identifié'; par[k] = (par[k] || 0) + 1; });
                        var detail = Object.keys(par).sort(function (a, b) { return par[b] - par[a]; })
                            .map(function (k) { return k + ' — ' + par[k]; }).join(' · ');
                        liste.unshift({ code: 'GL_SOLDEE_NON_PAYEES', titre: 'Réglée au grand livre, encore sur un tableau Monday des non payées',
                            gravite: 'haute', nb: its.length, euros: its.reduce(function (t, f) { return t + (f.montant || 0); }, 0), items: its,
                            conseil: 'Le grand livre solde ces factures par un règlement lettré, mais Monday ne les a pas déplacées dans '
                                + '« 0.1. ALL - Factures payées ». Elles sont comptées comme réglées dans les indicateurs ; reste à les déplacer dans Monday. '
                                + 'Par financement : ' + detail + '. Pour n’en voir qu’un (CPF par exemple), choisissez-le dans le filtre « Financement ».' });
                    }
                    var horsPayees = function (f) { return f.role !== 'sellsy' && (f.presenceRoles || [f.role]).indexOf('payees') < 0; };
                    var ev = (factures || []).filter(function (f) { return f.edofVerse && horsPayees(f); });
                    if (ev.length) liste.unshift({ code: 'EDOF_VERSE_NON_PAYEES', titre: 'CPF : versée selon EDOF, encore sur un tableau Monday des non payées',
                        gravite: 'haute', nb: ev.length, euros: ev.reduce(function (t, f) { return t + (f.montant || 0); }, 0), items: ev,
                        conseil: 'EDOF indique « Versé » pour ces factures : elles sont payées, et comptées comme telles dans les indicateurs. '
                            + 'Il reste à les déplacer dans « 0.1. ALL - Factures payées » dans Monday. L’export donne la date et le montant du règlement EDOF. '
                            + 'Par groupe : ' + (function () { var g = {}; ev.forEach(function (f) { g[f.groupe] = (g[f.groupe] || 0) + 1; });
                                return Object.keys(g).sort(function (a, b) { return g[b] - g[a]; }).map(function (k) { return k + ' — ' + g[k]; }).join(' · '); })() + '.' });
                    var er = (factures || []).filter(function (f) { return f.edof && f.edof.statut !== 'Versé'; });
                    if (er.length) liste.splice(ev.length ? 1 : 0, 0, { code: 'EDOF_REJETE', titre: 'CPF : règlement rejeté ou en attente dans EDOF',
                        gravite: 'haute', nb: er.length, euros: er.reduce(function (t, f) { return t + (f.montant || 0); }, 0), items: er,
                        conseil: 'EDOF n’a pas versé ces factures : statut « Rejeté » ou « En attente ». Le statut figure dans l’export.' });
                    var prob = (factures || []).filter(function (f) {
                        return f.reglementPropose && !f.paye && f.role !== 'sellsy' && (f.presenceRoles || [f.role]).indexOf('payees') < 0;
                    });
                    if (prob.length) {
                        var pf = {}, entier = 0;
                        prob.forEach(function (f) { var k = f.financement || 'non identifié'; pf[k] = (pf[k] || 0) + 1;
                            if (f.reglementPropose.montant >= f.reglementPropose.reste - 1) entier++; });
                        var na = (RAPPRO_INFO && RAPPRO_INFO.nonAttribues) || {};
                        liste.splice(its.length ? 1 : 0, 0, { code: 'GL_REGLEMENT_PROPOSE', titre: 'Probablement réglée : un règlement non lettré lui correspond au grand livre',
                            gravite: 'haute', nb: prob.length, euros: prob.reduce(function (t, f) { return t + (f.montant || 0); }, 0), items: prob,
                            conseil: 'Un règlement a été reçu en comptabilité mais n’est pas lettré avec la facture ; la balance âgée propose ce rapprochement '
                                + '(fiabilité : certaine, forte, probable ou à vérifier — elle figure dans l’export). ' + entier + ' sont couvertes en entier. '
                                + 'Ces factures restent comptées comme non payées tant que le lettrage n’est pas fait. Par financement : '
                                + Object.keys(pf).sort(function (a, b) { return pf[b] - pf[a]; }).map(function (k) { return k + ' — ' + pf[k]; }).join(' · ') + '. '
                                + (na.CPF ? 'Il reste en plus ' + Math.round(na.CPF).toLocaleString('fr-FR') + ' € de règlements CPF reçus pour lesquels aucune facture ne peut être proposée.' : '') });
                    }
                } catch (e) { /* les contrôles d'origine restent */ }
                CONTROLES = liste;
                return liste;
            };
        }
        var enrichirOrigine = I.enrichir;
        I.enrichir = function (factures, opts) {
            var st = etat() || {};
            try {
                ecarterSellsyAberrantes(factures);
                if (GL && !(st.grandLivre || []).length) {
                    BILAN.gl = I.appliquerGrandLivre(factures, GL);
                    st.glStats = BILAN.gl;
                } else BILAN.gl = null;
                appliquerMontantsDossiers(factures, st);
                appliquerEdof(factures);
                appliquerAnciennes(factures);
                if (RAPPRO) factures.forEach(function (f) { var x = f.cle && RAPPRO[f.cle];
                    f.reglementPropose = x ? { montant: x[0], reste: x[1], fiabilite: x[2], date: x[3] } : null; });
            } catch (e) { if (G.console) console.warn('Compléments v3 :', e); }
            var r = enrichirOrigine.apply(this, arguments);
            setTimeout(majSourceGL, 0);
            return r;
        };
    }
    /** Un bouton « Exporter » à côté de chaque « Voir les factures » des contrôles. */
    function exporterControle(a) {
        var X = G.XLSX;
        if (!X) { dire('L’export Excel n’est pas disponible.', 'error', 4000); return; }
        var d = function (v) { var x = v && R.parseDate(v); return x ? jourLocal(x).split('-').reverse().join('/') : ''; };
        var lignes = (a.items || []).map(function (f) {
            var o = {}; if (a.items && f.__motif && /a-reverifier/.test(String(a.code || ''))) { o['Motif'] = f.__motif; o['Autres motifs'] = (f.__autresMotifs || []).join(' ; '); }
            Object.assign(o, { 'Facture': f.numero || '', 'Client': f.client || '', 'Apprenant': f.apprenant || '', 'Financement': f.financement || '',
                'Tableau Monday': f.board || '', 'Groupe Monday': f.groupe || '', 'Montant': f.montant == null ? '' : f.montant,
                'Date de facture': d(f.dateFacture), 'Échéance calculée': d(f.dateEcheance), 'Jours de retard': f.retardJours == null ? '' : f.retardJours,
                'État': f.etat || '', 'Payée': f.paye ? 'oui' : 'non', 'Date de paiement': d(f.datePaiement), 'Origine du paiement': f.originePaiement || f.motifPaye || '' });
            if (f.reglementPropose) { o['Règlement proposé'] = f.reglementPropose.montant; o['Reste dû au grand livre'] = f.reglementPropose.reste;
                o['Fiabilité du rapprochement'] = f.reglementPropose.fiabilite; o['Date du règlement'] = d(f.reglementPropose.date); }
            if (f.edof) { o['EDOF — statut'] = f.edof.statut; o['EDOF — montant réglé'] = f.edof.montant; o['EDOF — date de règlement'] = d(f.edof.date);
                o['EDOF — dossier'] = f.edof.dossier; o['EDOF — dossier en contrôle'] = f.edof.controle ? 'oui' : 'non'; }
            if (f.edofDossier) { o['EDOF — n° de dossier'] = f.edofDossier.numero; o['EDOF — statut du dossier'] = f.edofDossier.statut; o['EDOF — début de session'] = d(f.edofDossier.debut);
                o['EDOF — fin de session'] = d(f.edofDossier.fin); o['EDOF — montant facturable'] = f.edofDossier.montantFacturable == null ? '' : f.edofDossier.montantFacturable;
                o['EDOF — dossier trouvé par le nom'] = f.dossierVientEdof ? 'oui' : ''; }
            if (f.__autresDossiers) o['Autre dossier EDOF du même apprenant'] = f.__autresDossiers.join(' | ');
            if (f.__autresFactures) o['Autres factures Monday du même apprenant'] = f.__autresFactures.join(' | ');
            if (f.edofAvance) { o['EDOF — avance versée'] = f.edofAvance.montant; o['EDOF — date de l’avance'] = d(f.edofAvance.date); }
            if (f.anciennesFactures) o['Ancienne facture'] = f.anciennesFactures.join(', ');
            return o;
        });
        var wb = X.utils.book_new();
        X.utils.book_append_sheet(wb, X.utils.json_to_sheet(lignes), 'Factures');
        X.writeFile(wb, 'controle-' + String(a.code || 'factures').toLowerCase().replace(/_/g, '-') + '-' + jourLocal(new Date()) + '.xlsx');
    }
    function poserExports() {
        var hote = $('#quality-list');
        if (!hote || !CONTROLES.length) return;
        hote.querySelectorAll('button').forEach(function (b) {
            if (!/voir les factures/i.test(b.textContent) || b.dataset.v3Export) return;
            var carte = b; while (carte.parentNode && carte.parentNode !== hote) carte = carte.parentNode;
            var texte = carte.textContent || '';
            var a = CONTROLES.filter(function (c) { return c.titre && texte.indexOf(c.titre) >= 0; })
                .sort(function (x, y) { return y.titre.length - x.titre.length; })[0];
            b.dataset.v3Export = '1';
            if (!a) return;
            var e = document.createElement('button');
            e.type = 'button'; e.className = b.className; e.textContent = 'Exporter (Excel)'; e.style.marginLeft = '0.4rem';
            e.addEventListener('click', function (ev) { ev.stopPropagation(); var c = CONTROLES.filter(function (x) { return x.code === a.code; })[0] || a; exporterControle(c); });
            b.parentNode.insertBefore(e, b.nextSibling);
        });
    }
    setInterval(poserExports, 1200);

    function majSourceGL() {
        var hote = $('#v3-ligne-monday');
        if (!hote) return;
        var el = $('#v3-source-gl');
        if (!el) { el = document.createElement('small'); el.id = 'v3-source-gl'; el.className = 'v3-source-gl'; hote.parentNode.insertBefore(el, hote.nextSibling); }
        var st = etat() || {}, t = [];
        if ((st.grandLivre || []).length) t.push('Règlements : votre grand livre déposé');
        else if (BILAN.gl && GL_INFO) {
            var j = String(GL_INFO.arrete || '').split('-').reverse().join('/');
            t.push('Règlements : grand livre arrêté au ' + j);
        }
        if (EDOF && EDOF.periodes.length) t.push('CPF : EDOF fait foi (factures émises du '
            + EDOF.periodes[0][0].split('-').reverse().join('/') + ' au ' + EDOF.periodes[EDOF.periodes.length - 1][1].split('-').reverse().join('/') + ')');
        if (BILAN.sellsyEcartees.length) t.push(BILAN.sellsyEcartees.length + ' ligne(s) Sellsy écartée(s) : montant négatif ou aberrant');
        el.textContent = t.join(' · ');
        el.title = BILAN.sellsyEcartees.slice(0, 30).map(function (e) { return (e.numero || '?') + ' : ' + Math.round(e.montant).toLocaleString('fr-FR') + ' €'; }).join('\n');
    }

    // ══════════════════════════════════════════════
    //  Période du tableau de bord : les mêmes noms que dans Pilotage
    // ══════════════════════════════════════════════
    var PERIODES = [['exercice', 'Exercice courant'], ['exercice-1', 'Exercice précédent'], ['mois', 'Mois en cours'],
                    ['mois-1', 'Mois dernier'], ['trimestre', 'Trimestre en cours'], ['annee', 'Année en cours'],
                    ['annee-1', 'Année dernière'], ['douze', 'Douze derniers mois']];
    function bornesPeriode(k, ref) {
        var a = ref.getFullYear(), m = ref.getMonth(), cle = function (y, mo) { var d = new Date(y, mo, 1); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); };
        var ex = m >= 6 ? a : a - 1;   // l'exercice court du 1er juillet au 30 juin
        switch (k) {
            case 'exercice': return [cle(ex, 6), cle(ex + 1, 5)];
            case 'exercice-1': return [cle(ex - 1, 6), cle(ex, 5)];
            case 'mois': return [cle(a, m), cle(a, m)];
            case 'mois-1': return [cle(a, m - 1), cle(a, m - 1)];
            case 'trimestre': { var t = Math.floor(m / 3) * 3; return [cle(a, t), cle(a, t + 2)]; }
            case 'annee': return [cle(a, 0), cle(a, 11)];
            case 'annee-1': return [cle(a - 1, 0), cle(a - 1, 11)];
            default: return [cle(a, m - 11), cle(a, m)];
        }
    }
    function appliquerMois(de, a, quoi) {
        var st = etat();
        if (!st || !st.filtres) return false;
        var voulus = (st.moisDispo || []).filter(function (mk) { return mk >= de && mk <= a; });
        if (!voulus.length) { dire('Aucune facture sur cette période (' + quoi + ').', 'info', 4000); return false; }
        // Le dernier mois est coché par un vrai clic : c'est lui qui relance l'affichage.
        var dernier = voulus[voulus.length - 1];
        st.filtres.mois = new Set(voulus.slice(0, -1));
        var bouton = document.querySelector('#dd-periode .date-month-btn[data-month="' + dernier + '"]');
        if (bouton) bouton.click();
        return true;
    }
    function choisirPeriode(k) {
        var st = etat();
        if (!st || !st.filtres) return;
        if (k === 'tout') { var t = $('#dd-periode [data-action="tous"]'); if (t) t.click(); return; }
        var ref = (st.filtres.dateRef && R.parseDate(st.filtres.dateRef)) || new Date();
        var b = bornesPeriode(k, ref), lib = PERIODES.filter(function (p) { return p[0] === k; })[0];
        appliquerMois(b[0], b[1], lib ? lib[1] : k);
    }
    /**
     * Le filtre « Période » est le même que celui du Pilotage : une liste
     * déroulante avec les mêmes choix, et deux dates pour « Date personnalisée ».
     * L'ancien déroulé à pastilles de mois reste dans la page, masqué : c'est
     * lui qui applique le choix.
     */
    function brancherPeriode() {
        var boite = $('#dd-periode');
        if (!boite || $('#v3-periode')) return;
        boite.style.display = 'none';
        var hote = document.createElement('span');
        hote.className = 'v3-periode';
        hote.innerHTML = '<select id="v3-periode" aria-label="Période"><option value="tout">Toute la période</option>'
            + PERIODES.map(function (p) { return '<option value="' + p[0] + '">' + p[1] + '</option>'; }).join('')
            + '<option value="libre">Date personnalisée</option></select>'
            + '<span id="v3-periode-dates" hidden><input type="date" id="v3-periode-du" aria-label="Du"> '
            + '<input type="date" id="v3-periode-au" aria-label="Au"></span>';
        boite.parentNode.insertBefore(hote, boite);
        var sel = $('#v3-periode'), dates = $('#v3-periode-dates'), du = $('#v3-periode-du'), au = $('#v3-periode-au');
        sel.addEventListener('change', function () {
            dates.hidden = sel.value !== 'libre';
            if (sel.value !== 'libre') choisirPeriode(sel.value);
            else if (du.value && au.value) libre();
        });
        function libre() {
            if (!du.value || !au.value) return;
            var a = du.value <= au.value ? [du.value, au.value] : [au.value, du.value];
            appliquerMois(a[0].slice(0, 7), a[1].slice(0, 7), 'du ' + a[0].split('-').reverse().join('/') + ' au ' + a[1].split('-').reverse().join('/'));
        }
        du.addEventListener('change', libre); au.addEventListener('change', libre);
        var aide = boite.parentNode.querySelector('.aide-ligne');
        if (aide) aide.textContent = 'Les mêmes choix que dans le Pilotage. Les factures sont retenues d’après le mois de leur échéance.';
        // « Réinitialiser » ou une pastille retirée ailleurs : la liste suit.
        setInterval(function () {
            var st = etat();
            if (st && st.filtres && !st.filtres.mois && sel.value !== 'tout' && document.activeElement !== sel) { sel.value = 'tout'; dates.hidden = true; }
        }, 1500);
    }

    // ══════════════════════════════════════════════
    //  Démarrage
    // ══════════════════════════════════════════════
    /**
     * À la deuxième visite, l'application retrouve ses données mais s'arrête
     * sur l'écran d'accueil, derrière un bouton « Reprendre les données
     * enregistrées ». La version 3 l'ouvre directement : on vient pour lire
     * les chiffres, pas pour confirmer qu'on veut les voir.
     */
    function reprendreSiPossible() {
        var vus = 0, essais = 0;
        var t = setInterval(function () {
            essais++;
            var accueil = $('#welcome-screen'), bouton = $('#btn-open-saved');
            var surAccueil = accueil && accueil.classList.contains('active');
            if (!surAccueil) { vus = 0; if ($('#app-screen.active') || essais > 60) clearInterval(t); return; }
            if (bouton && !bouton.hidden) vus++; else vus = 0;
            if (vus >= 3) { clearInterval(t); bouton.click(); }
            else if (essais > 60) clearInterval(t);
        }, 500);
    }

    async function demarrer() {
        try { DATES = (await S.get(CLE_DATES, {})) || {}; } catch (e) { DATES = {}; }
        await preparer();
        // Les règles modifiées à la main se reposent avant le premier calcul.
        try { if (G.LioraV3Regles) await G.LioraV3Regles.pret; } catch (e) { /* règles d'origine */ }
        try { await chargerComplements(); brancherComplements(); } catch (e) { /* la page s'ouvre sans ces compléments */ }
        await lancerApplication();
        if (G.LioraV3Regles) G.LioraV3Regles.brancher();
        reprendreSiPossible();
        suivreOnglets();
        suivreAide();
        brancherMonday();
        brancherPeriode();
        brancherEdof();
        brancherEdofOperationnel();
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', demarrer);
    else demarrer();
})(window);
