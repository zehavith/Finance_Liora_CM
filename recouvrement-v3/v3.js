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
    var CLE_EDOF = 'rec_v3_edof', EDOF_BRUT = { factures: {}, avances: {}, periodes: [] }, EDOF_IMPORT = null;
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
    }
    function poserEdof() {
        if (!Object.keys(EDOF_BRUT.factures).length && !Object.keys(EDOF_BRUT.avances).length) { EDOF = null; return; }
        EDOF = { factures: {}, avances: EDOF_BRUT.avances, periodes: EDOF_BRUT.periodes };
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
                EDOF_IMPORT = EDOF_IMPORT || { factures: {}, avances: {}, periodes: [] };
                Object.assign(EDOF_IMPORT.factures, lot.factures); Object.assign(EDOF_IMPORT.avances, lot.avances);
                EDOF_IMPORT.periodes = EDOF_IMPORT.periodes.concat(lot.periodes);
                recus += lot.periodes[0][2]; noms.push(fichiers[i].name);
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
            + Object.keys(EDOF_BRUT.avances).length.toLocaleString('fr-FR') + ' avances. Factures déposées du ' + jour(p[0] && p[0][0]) + ' au ' + jour(p.length && p[p.length - 1][1]) + '. '
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
            + 'Fichier attendu : l’export « Factures » d’EDOF, au format CSV, tel qu’il est téléchargé. Plusieurs fichiers peuvent être choisis d’un coup ; '
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
    function carteEdofOperationnel() {
        var st = etat(), OPX = G.LioraOperationnel, hote = $('#v3-op-edof');
        if (!hote || !st || !OPX) return;
        var hp = function (f) { return f.role !== 'sellsy' && (f.presenceRoles || [f.role]).indexOf('payees') < 0; };
        // « Le circuit : » puis une vignette par financement. Le CPF se lit
        // d'après EDOF ; les autres, d'après les étapes du circuit Monday.
        var libelles = {}; (st.rules || R.DEFAULT_ECHEANCE_RULES || []).forEach(function (r) { libelles[r.key] = r.label; });
        var nonReglees = (st.factures || []).filter(function (f) { return hp(f) && !f.paye && !f.groupeTechnique && f.role !== 'technique' && f.role !== 'ignore'; });
        var parFin = {};
        nonReglees.forEach(function (f) { var k = f.financement || 'INCONNU'; parFin[k] = (parFin[k] || 0) + 1; });
        var fins = Object.keys(parFin).sort(function (a, b) { return (b === 'CPF') - (a === 'CPF') || parFin[b] - parFin[a]; });
        if (fins.indexOf(CIRCUIT_FIN) < 0) CIRCUIT_FIN = fins[0] || 'CPF';
        var nomFin = function (k) { return libelles[k] || (k === 'INCONNU' ? 'Non renseigné' : k); };
        var tete = '<div class="v3-circuit-tete"><h3><label for="v3-circuit-fin">Le circuit :</label></h3><select id="v3-circuit-fin" class="v3-circuit-choix">' + fins.map(function (k) {
            return '<option value="' + esc(k) + '"' + (k === CIRCUIT_FIN ? ' selected' : '') + '>' + esc(nomFin(k)) + ' — ' + parFin[k].toLocaleString('fr-FR') + ' factures non réglées</option>'; }).join('') + '</select></div>';
        var brancherTete = function () {
            var choix = hote.querySelector('#v3-circuit-fin'); if (choix) choix.onchange = function () { CIRCUIT_FIN = choix.value; carteEdofOperationnel(); };
            hote.querySelectorAll('[data-edof-lot]').forEach(function (b) { b.onclick = function () { var l = EDOF_LOTS[+b.dataset.edofLot];
                if (!l || !OPX.montrerFactures) return;
                OPX.montrerFactures(l.titre, l.its, l.note);
                // La fenêtre porte son propre bouton d'export : la liste affichée, en entier.
                setTimeout(function () { var pied = document.querySelector('#modal-overlay .modal-foot'); if (!pied || pied.querySelector('.v3-export-lot')) return;
                    var e = document.createElement('button'); e.type = 'button'; e.className = 'btn btn-ghost btn-sm v3-export-lot'; e.textContent = 'Exporter cette liste (Excel)';
                    e.onclick = function () { exporterControle({ code: l.code, items: l.its }); }; pied.insertBefore(e, pied.firstChild); }, 60); }; });
            hote.querySelectorAll('[data-edof-export]').forEach(function (b) { b.onclick = function () { var l = EDOF_LOTS[+b.dataset.edofExport]; if (l) exporterControle({ code: l.code, items: l.its }); }; });
        };
        var parcours = '';
        {
            EDOF_LOTS = [];
            var its = nonReglees.filter(function (f) { return (f.financement || 'INCONNU') === CIRCUIT_FIN; });
            var somme = function (l) { return Math.round(l.reduce(function (t, f) { return t + (f.montant || 0); }, 0)).toLocaleString('fr-FR') + ' €'; };
            var cles = {}; (OPX.CIRCUIT || []).forEach(function (e) { cles[e.k] = e; });
            var dans = function (k) { return its.filter(function (f) { return OPX.etapeDe(f) === k; }); };
            var hors = its.filter(function (f) { return !cles[OPX.etapeDe(f)]; });
            var echue = function (f) { return f.retardJours != null ? f.retardJours > 0 : f.etat === 'En retard'; };
            var nom = nomFin(CIRCUIT_FIN);
            var vignette = function (n, l, titre, quoi, faire, code, classe) {
                EDOF_LOTS.push({ titre: nom + ' — ' + titre, its: l, note: quoi, code: 'circuit-' + CIRCUIT_FIN.toLowerCase() + '-' + code });
                var i = EDOF_LOTS.length - 1;
                return '<div class="v3-edof-tuile ' + (classe || '') + '"><span class="v3-edof-rang">' + n + '</span><span class="v3-edof-nb">'
                    + (l.length ? '<button type="button" class="op-lien" data-edof-lot="' + i + '" title="Voir ces factures"><b>' + l.length.toLocaleString('fr-FR') + '</b></button>' : '<b>0</b>')
                    + '</span><span class="v3-edof-titre">' + esc(titre) + '</span><span class="v3-edof-mt">' + somme(l)
                    + (l.length ? ' <button type="button" class="v3-edof-exp" data-edof-export="' + i + '">exporter</button>' : '') + '</span>'
                    + '<span class="op-pied">' + esc(quoi) + '</span><span class="v3-edof-faire">→ ' + esc(faire) + '</span></div>';
            };
            var horsEchues = hors.filter(echue), n = 1;
            var tuiles = vignette(n++, hors.filter(function (f) { return !echue(f); }), 'Sous contrôle', 'Avant échéance, dans aucune étape du circuit.', 'rien à faire pour l’instant', 'sous-controle');
            (OPX.CIRCUIT || []).forEach(function (e) {
                tuiles += vignette(n++, dans(e.k), e.n, 'Groupes Monday de l’étape « ' + e.n + ' » (' + e.svc + ').', e.svc + ' · cible ' + e.cible + ' j', e.k, e.k === 'rec' ? 'fort' : '');
            });
            parcours = '<p class="pil-note">Les ' + its.length.toLocaleString('fr-FR') + ' factures ' + esc(nom) + ' non réglées, rangées dans l’ordre du circuit. '
                + 'Chaque nombre ouvre ses factures ; « exporter » en donne la liste Excel. Cette carte ne suit pas les filtres de période.</p>'
                + '<div class="v3-edof-grille">' + tuiles + '</div>'
                + (horsEchues.length ? (function () { EDOF_LOTS.push({ titre: nom + ' — échues, dans aucune étape', its: horsEchues, note: 'Échéance passée, mais le groupe Monday n’est rangé dans aucune étape du circuit.', code: 'circuit-' + CIRCUIT_FIN.toLowerCase() + '-echues-hors-etape' });
                    var i = EDOF_LOTS.length - 1;
                    return '<p class="op-alerte"><button type="button" class="op-lien" data-edof-lot="' + i + '"><b>' + horsEchues.length.toLocaleString('fr-FR') + '</b> factures échues</button> ('
                        + somme(horsEchues) + ') sont encore dans un groupe « en cours », hors de toute étape. <button type="button" class="v3-edof-exp" data-edof-export="' + i + '">exporter</button></p>'; })() : '');
        }
        if (CIRCUIT_FIN !== 'CPF' || !EDOF) {
            hote.innerHTML = '<div class="charts-grid"><div class="chart-card chart-wide">' + tete + parcours + '</div></div>';
            brancherTete();
            return;
        }
        var cpf = (st.factures || []).filter(function (f) { return f.role !== 'sellsy' && (f.financement === 'CPF' || f.edof); });
        var ouvertes = cpf.filter(hp);
        var verse = ouvertes.filter(function (f) { return f.edofVerse; });
        var nonVersees = ouvertes.filter(function (f) { return !f.edofVerse && !f.paye; });
        var an = function (f) { var d = f.dateFacture && R.parseDate(f.dateFacture); return d ? d.getFullYear() : 0; };
        var anneeRef = new Date().getFullYear();
        var lots = {
            rien: nonVersees.filter(function (f) { return !f.edof && !f.edofAvance; }),
            avance: nonVersees.filter(function (f) { return !f.edof && f.edofAvance; }),
            attente: nonVersees.filter(function (f) { return f.edof && f.edof.statut === 'En attente'; }),
            rejet: nonVersees.filter(function (f) { return f.edof && f.edof.statut === 'Rejeté'; }),
            pointee: verse.filter(function (f) { return f.grandLivreSoldee; }),
            nonPointee: verse.filter(function (f) { return !f.grandLivreSoldee && f.grandLivre; }),
            absente: verse.filter(function (f) { return !f.grandLivre; })
        };
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
        // ── EDOF × circuit : chaque facture a une étape EDOF (ligne) et une étape du circuit Monday (colonne).
        var COLS = [{ k: 'ctl', n: 'Sous contrôle' }].concat((OPX.CIRCUIT || []).map(function (e) { return { k: e.k, n: e.n }; })).concat([{ k: 'hors', n: 'Échue, hors étape' }]);
        var colDe = function (f) { var k = OPX.etapeDe(f); if (cles[k]) return k; return echue(f) ? 'hors' : 'ctl'; };
        var LIGNES = [
            { n: '1 · Pas encore dans EDOF', faire: 'déposer la facture', l: lots.rien, code: 'edof-1-aucune-trace' },
            { n: '2 · Avance versée, solde à facturer', faire: 'déposer la facture de solde', l: lots.avance, code: 'edof-2-avance-seule' },
            { n: '3 · Déposée, en attente de règlement', faire: 'attendre le versement', l: lots.attente, code: 'edof-3-attente' },
            { n: '4 · Rejetée par EDOF', faire: 'corriger et redéposer', l: lots.rejet, code: 'edof-4-rejet' },
            { n: '5 · Versée par EDOF', faire: 'pointer, puis déplacer dans les payées', l: verse, code: 'edof-5-versee' }
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
            + '<tr class="total"><td>Total</td>' + COLS.map(function (c) { var l = ouvertes.filter(function (f) { return (f.edofVerse || !f.paye) && colDe(f) === c.k; });
                    return cellule(l, 'CPF — ' + c.n, 'edof-circuit-' + c.k); }).join('')
            + '<td class="n"><b>' + (nonVersees.length + verse.length).toLocaleString('fr-FR') + '</b></td></tr></tbody></table></div>';

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
            ['Relancée ou en clôture, mais absente d’EDOF', 'La facture est dans une étape de relance alors qu’EDOF ne connaît ni la facture ni une avance : elle n’a peut-être jamais été déposée.',
                lots.rien.filter(enRelance), 'relance-sans-edof'],
            ['Versée par EDOF, mais encore relancée', 'EDOF a versé la facture ; elle est pourtant dans une étape de relance ou de clôture.',
                verse.filter(enRelance), 'versee-encore-relancee'],
            ['Montant versé différent du montant de la facture', 'Le règlement EDOF, avance comprise, s’écarte de plus d’un euro du montant de la facture Monday.',
                verse.filter(function (f) { var m = f.montant || 0, v = f.edof.montant, av = f.edofAvance ? f.edofAvance.montant : 0; return m > 0 && Math.abs(v - m) > 1 && Math.abs(v + av - m) > 1; }), 'ecart-montant'],
            ['Rejetée par EDOF', 'Statut « Rejeté » dans EDOF : à corriger et redéposer.', lots.rejet, 'rejet'],
            ['Dossier en contrôle dans EDOF', 'EDOF signale un contrôle sur le dossier.', tous.filter(function (f) { return f.edof && f.edof.controle; }), 'dossier-en-controle'],
            ['Sans numéro de dossier dans Monday', 'Impossible de rapprocher la facture d’une avance EDOF sans numéro de dossier.',
                lots.rien.filter(function (f) { return !norm(f.numeroDossier); }), 'sans-numero-dossier']
        ];
        var dejaVu = {}, nbUniques = 0;
        VERIFS.forEach(function (v) { v[2].forEach(function (f) { if (!dejaVu[f.id || f.cle || f.numero]) { dejaVu[f.id || f.cle || f.numero] = 1; nbUniques++; } }); });
        var aVerifier = '<div class="v3-averifier"><h3 class="v3-circuit-sous">Facturation à revérifier <span class="op-cnt">' + nbUniques.toLocaleString('fr-FR') + ' factures</span></h3>'
            + '<p class="pil-note">Les factures CPF qui posent question : doublons, absentes d’EDOF alors qu’elles sont relancées, ou incohérentes. Une même facture peut figurer dans plusieurs lignes.</p>'
            + '<table class="op-t"><thead><tr><th>Ce qui est à revérifier</th><th class="n">Factures</th><th class="n">Montant</th><th></th></tr></thead><tbody>'
            + VERIFS.map(function (v) { var i = poser(v[2], 'À revérifier — ' + v[0], v[1], 'a-reverifier-' + v[3]);
                return '<tr' + (v[2].length ? '' : ' class="v3-rien"') + '><td><b>' + esc(v[0]) + '</b><br><span class="op-pied">' + esc(v[1]) + '</span></td><td class="n">' + nbLien(v[2], i)
                    + '</td><td class="n">' + (v[2].length ? eur0(v[2]) : '—') + '</td><td class="n">' + exp(v[2], i) + '</td></tr>'; }).join('')
            + '</tbody></table></div>';

        hote.innerHTML = '<div class="charts-grid"><div class="chart-card chart-wide">' + tete + parcours
            + '<div class="chart-header v3-circuit-sep"><h3 class="v3-circuit-sous">CPF — étapes EDOF croisées avec les étapes du circuit</h3>'
            + '<span class="pil-coin">export EDOF jusqu’au ' + jour(p.length && p[p.length - 1][1]) + ' · grand livre au ' + jour(GL_INFO && GL_INFO.arrete) + '</span></div>'
            + '<p class="pil-note"><b>Règle CPF :</b> « Rendre payable » commence à fin de formation + ' + delaiPayable + ' jours, et le recouvrement (« Relancer ») à fin de formation + ' + delaiCpf + ' jours. '
            + 'Les factures dont le groupe Monday ne correspond pas à cette règle sont dans « Facturation à revérifier ». '
            + 'En ligne, où en est la facture dans EDOF ; en colonne, dans quelle étape du circuit elle se trouve dans Monday. '
            + 'Les factures versées par EDOF sont comptées payées : elles ne sont plus dans les vignettes du dessus, mais restent ici tant qu’elles ne sont pas déplacées. '
            + rangees.toLocaleString('fr-FR') + ' autres factures versées sont déjà rangées dans les payées.</p>'
            + matrice
            + (verse.length ? '<div class="v3-edof-detail"><div><b>Étape 5 — pointage en comptabilité</b><ul class="v3-edof-sous">'
                + '<li>' + enLigne(lots.nonPointee, 'non pointées : ouvertes au grand livre', 'Versées par EDOF, mais le grand livre les montre encore ouvertes : le règlement n’est pas lettré avec la facture.', 'edof-5-non-pointees') + '</li>'
                + '<li>' + enLigne(lots.absente, 'introuvables au grand livre', 'Versées par EDOF, mais le numéro de facture n’apparaît pas dans le grand livre : pointage impossible à vérifier.', 'edof-5-absentes-grand-livre') + '</li>'
                + '<li>' + enLigne(lots.pointee, 'pointées : il reste à les déplacer', 'Versées par EDOF et lettrées au grand livre : il ne reste qu’à les déplacer dans Monday.', 'edof-5-pointees') + '</li></ul></div>'
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
        EDOF_BRUT = { factures: {}, avances: {}, periodes: [] };
        if (edof && edof.factures) fusionnerEdof(edof);
        try { var garde = await S.get(CLE_EDOF, null); if (garde && garde.factures) { fusionnerEdof(garde); EDOF_IMPORT = garde; } } catch (e) { /* pas d'import gardé */ }
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
        var n = 0;
        BILAN.edof = 0;
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
            var dossier = String(f.numeroDossier || (f.edof && f.edof.dossier) || '').replace(/\s+/g, '');
            var a = dossier && EDOF.avances[dossier];
            f.edofAvance = (a && a[2] === 'Versé') ? { montant: a[0], date: a[1] } : null;
        });
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
            var o = { 'Facture': f.numero || '', 'Client': f.client || '', 'Apprenant': f.apprenant || '', 'Financement': f.financement || '',
                'Tableau Monday': f.board || '', 'Groupe Monday': f.groupe || '', 'Montant': f.montant == null ? '' : f.montant,
                'Date de facture': d(f.dateFacture), 'Échéance calculée': d(f.dateEcheance), 'Jours de retard': f.retardJours == null ? '' : f.retardJours,
                'État': f.etat || '', 'Payée': f.paye ? 'oui' : 'non', 'Date de paiement': d(f.datePaiement), 'Origine du paiement': f.originePaiement || f.motifPaye || '' };
            if (f.reglementPropose) { o['Règlement proposé'] = f.reglementPropose.montant; o['Reste dû au grand livre'] = f.reglementPropose.reste;
                o['Fiabilité du rapprochement'] = f.reglementPropose.fiabilite; o['Date du règlement'] = d(f.reglementPropose.date); }
            if (f.edof) { o['EDOF — statut'] = f.edof.statut; o['EDOF — montant réglé'] = f.edof.montant; o['EDOF — date de règlement'] = d(f.edof.date);
                o['EDOF — dossier'] = f.edof.dossier; o['EDOF — dossier en contrôle'] = f.edof.controle ? 'oui' : 'non'; }
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
