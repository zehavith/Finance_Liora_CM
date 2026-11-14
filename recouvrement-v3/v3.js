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
                  bilan: function () { return BILAN; }, grandLivre: function () { return GL_INFO; } };

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
    var GL = null, GL_INFO = null, ANCIENNES = null;
    var BILAN = { gl: null, anciennes: 0, anciennesSansDate: 0, montantsDossier: 0, sellsyEcartees: [] };
    var PLAFOND_SELLSY = 500000;

    async function lireJson(chemin) {
        try {
            var r = await fetch(chemin, { cache: 'no-cache' });
            return r.ok ? await r.json() : null;
        } catch (e) { return null; }
    }
    async function chargerComplements() {
        var res = await Promise.all([lireJson('donnees/reglements.json'), lireJson('donnees/anciennes-factures.json')]);
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
                appliquerAnciennes(factures);
            } catch (e) { if (G.console) console.warn('Compléments v3 :', e); }
            var r = enrichirOrigine.apply(this, arguments);
            setTimeout(majSourceGL, 0);
            return r;
        };
    }
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
    function choisirPeriode(k) {
        var st = etat();
        if (!st || !st.filtres) return;
        var ref = (st.filtres.dateRef && R.parseDate(st.filtres.dateRef)) || new Date();
        var b = bornesPeriode(k, ref);
        var voulus = (st.moisDispo || []).filter(function (mk) { return mk >= b[0] && mk <= b[1]; });
        var boite = $('#dd-periode');
        if (!voulus.length) {
            dire('Aucune facture sur cette période (' + k.replace('-1', ' précédent') + ').', 'info', 4000);
            return;
        }
        // Le dernier mois est coché par un vrai clic : c'est lui qui relance l'affichage.
        var dernier = voulus[voulus.length - 1];
        st.filtres.mois = new Set(voulus.slice(0, -1));
        var bouton = boite && boite.querySelector('.date-month-btn[data-month="' + dernier + '"]');
        if (bouton) bouton.click();
        var lib = PERIODES.filter(function (p) { return p[0] === k; })[0];
        setTimeout(function () { var r = $('#periode-resume'); if (r && lib) r.textContent = lib[1] + ' — ' + r.textContent; }, 60);
    }
    function brancherPeriode() {
        var actions = $('#dd-periode .dd-actions');
        if (!actions || actions.dataset.v3) return;
        actions.dataset.v3 = '1';
        actions.querySelectorAll('button').forEach(function (b) {
            if (b.dataset.action === 'tous') b.textContent = 'Toute la période';
            else b.remove();
        });
        PERIODES.forEach(function (p) {
            var b = document.createElement('button');
            b.type = 'button'; b.className = 'btn btn-ghost btn-sm'; b.dataset.v3Periode = p[0]; b.textContent = p[1];
            b.addEventListener('click', function (e) { e.stopPropagation(); choisirPeriode(p[0]); });
            actions.appendChild(b);
        });
        var note = document.createElement('div');
        note.className = 'v3-periode-note';
        note.textContent = 'Date personnalisée : cochez les mois voulus ci-dessous.';
        actions.parentNode.insertBefore(note, actions.nextSibling);
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
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', demarrer);
    else demarrer();
})(window);
