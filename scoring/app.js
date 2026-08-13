/* ============================
   Liora Scoring Entreprises
   Interface applicative
   v1.0.0

   Application autonome : elle ne partage ni code, ni base de données, ni
   configuration avec le Cash Flow Analyzer situé à la racine du dépôt.
   ============================ */

(function () {
    'use strict';

    const S = window.LioraScoring;
    const A = window.LioraApi;

    /* ── État ── */
    let portefeuille = [];        // [{ siren, nom, fiche, resultat, ajouteLe, majLe }]
    let poids = Object.assign({}, S.DEFAULT_WEIGHTS);
    let resultatsRecherche = [];
    let ficheCourante = null;
    let resultatsImport = [];

    const CLE_PORTEFEUILLE = 'portefeuille';
    const CLE_POIDS = 'poids';

    /* ══════════════════════════════════════════════════════════
       Utilitaires DOM
       ══════════════════════════════════════════════════════════ */

    const $ = sel => document.querySelector(sel);
    const $$ = sel => Array.prototype.slice.call(document.querySelectorAll(sel));

    /** Échappe le texte issu des API avant toute injection dans le HTML. */
    function esc(v) {
        if (v === null || v === undefined) return '';
        return String(v)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function toast(message, type) {
        const t = $('#toast');
        t.textContent = message;
        t.className = 'toast toast-visible' + (type ? ' toast-' + type : '');
        clearTimeout(toast._timer);
        toast._timer = setTimeout(() => { t.className = 'toast'; }, 3600);
    }

    function statut(selecteur, message, type) {
        const el = $(selecteur);
        if (!el) return;
        el.innerHTML = message ? `<span class="status-${type || 'info'}">${esc(message)}</span>` : '';
    }

    function fmtSiren(siren) {
        const s = String(siren || '');
        return s.length === 9 ? `${s.slice(0, 3)} ${s.slice(3, 6)} ${s.slice(6)}` : s;
    }

    function fmtDate(iso) { return S.formatDate(iso); }

    function fmtDateCourte(iso) {
        if (!iso) return '—';
        const d = new Date(iso);
        if (isNaN(d.getTime())) return '—';
        return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit' });
    }

    /* ══════════════════════════════════════════════════════════
       Persistance
       ══════════════════════════════════════════════════════════ */

    async function chargerEtat() {
        try {
            const pf = await A.idbGet(CLE_PORTEFEUILLE);
            if (Array.isArray(pf)) portefeuille = pf;
        } catch (e) { console.warn('[Scoring] Portefeuille illisible', e); }
        try {
            const p = await A.idbGet(CLE_POIDS);
            if (p && typeof p === 'object') poids = Object.assign({}, S.DEFAULT_WEIGHTS, p);
        } catch (e) { console.warn('[Scoring] Pondérations illisibles', e); }
    }

    async function sauverPortefeuille() {
        try { await A.idbSet(CLE_PORTEFEUILLE, portefeuille); }
        catch (e) { toast('Échec de l’enregistrement du portefeuille', 'error'); }
    }

    /* ══════════════════════════════════════════════════════════
       Onglets
       ══════════════════════════════════════════════════════════ */

    function initOnglets() {
        $$('.nav-tab').forEach(btn => {
            btn.addEventListener('click', () => {
                $$('.nav-tab').forEach(b => b.classList.remove('active'));
                $$('.tab-content').forEach(c => c.classList.remove('active'));
                btn.classList.add('active');
                $('#tab-' + btn.dataset.tab).classList.add('active');
                if (btn.dataset.tab === 'portefeuille') rendrePortefeuille();
                if (btn.dataset.tab === 'reglages') rafraichirStatsReglages();
                window.scrollTo({ top: 0, behavior: 'smooth' });
            });
        });
    }

    /* ══════════════════════════════════════════════════════════
       Indicateur réseau
       ══════════════════════════════════════════════════════════ */

    function initReseau() {
        function maj() {
            const enLigne = navigator.onLine !== false;
            const el = $('#net-status');
            el.classList.toggle('offline', !enLigne);
            el.querySelector('.net-label').textContent = enLigne ? 'En ligne' : 'Hors ligne';
            el.title = enLigne
                ? 'Connecté — les fiches sont récupérées auprès des API publiques'
                : 'Hors ligne — seules les fiches déjà en cache sont consultables';
        }
        window.addEventListener('online', maj);
        window.addEventListener('offline', maj);
        maj();
    }

    /* ══════════════════════════════════════════════════════════
       Recherche
       ══════════════════════════════════════════════════════════ */

    function initRecherche() {
        // Liste des secteurs alimentée depuis la table du moteur de score.
        const select = $('#filter-section');
        Object.keys(S.SECTION_NAF).forEach(lettre => {
            const opt = document.createElement('option');
            opt.value = lettre;
            opt.textContent = lettre + ' — ' + S.SECTION_NAF[lettre][0];
            select.appendChild(opt);
        });

        $('#search-form').addEventListener('submit', e => {
            e.preventDefault();
            lancerRecherche();
        });

        $('#filters-reset').addEventListener('click', () => {
            $('#filter-dept').value = '';
            $('#filter-section').value = '';
            $('#filter-etat').value = '';
        });
    }

    async function lancerRecherche() {
        const q = $('#search-input').value.trim();
        if (!q) { toast('Saisissez un nom, un SIREN ou un SIRET'); return; }

        const btn = $('#search-btn');
        btn.disabled = true;
        btn.textContent = 'Recherche…';
        $('#fiche').classList.add('hidden');
        $('#search-results').innerHTML = '';
        statut('#search-status', 'Interrogation de l’API Recherche d’Entreprises…', 'info');

        // Saisie d'un identifiant : on ouvre directement la fiche complète.
        const siren = A.extraireSiren(q);
        if (siren) {
            if (!A.sirenValide(siren)) {
                statut('#search-status', `Le SIREN ${fmtSiren(siren)} est syntaxiquement invalide (clé de contrôle incorrecte). Recherche lancée quand même.`, 'warn');
            }
            try {
                const { fiche, origine } = await A.obtenirFiche(siren);
                resultatsRecherche = [fiche];
                rendreResultats([fiche]);
                await ouvrirFiche(siren, origine);
                statut('#search-status', '');
                return;
            } catch (e) {
                statut('#search-status', messageErreur(e), 'error');
                return;
            } finally {
                btn.disabled = false;
                btn.textContent = 'Rechercher';
            }
        }

        try {
            if (navigator.onLine === false) {
                statut('#search-status', 'Hors ligne : la recherche par nom nécessite une connexion. Le portefeuille et les fiches en cache restent consultables.', 'warn');
                return;
            }
            const res = await A.rechercher(q, {
                perPage: 12,
                departement: $('#filter-dept').value.trim() || undefined,
                sectionNaf: $('#filter-section').value || undefined,
                etat: $('#filter-etat').value || undefined
            });
            resultatsRecherche = res.results;
            if (!res.results.length) {
                statut('#search-status', 'Aucune entreprise ne correspond à cette recherche.', 'warn');
            } else {
                statut('#search-status', `${res.total.toLocaleString('fr-FR')} résultat(s) — ${res.results.length} affiché(s).`, 'info');
            }
            rendreResultats(res.results);
        } catch (e) {
            statut('#search-status', messageErreur(e), 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Rechercher';
        }
    }

    function messageErreur(e) {
        if (!e) return 'Erreur inconnue.';
        if (e.horsLigne) return e.message;
        if (e.name === 'AbortError') return 'L’API n’a pas répondu dans le délai imparti. Réessayez.';
        if (e.status === 429) return 'Quota de l’API publique atteint (limite de requêtes par minute). Patientez quelques instants.';
        if (e.status >= 500) return 'L’API publique est momentanément indisponible (' + e.status + ').';
        if (e instanceof TypeError) return 'Impossible de joindre l’API : vérifiez votre connexion réseau.';
        return e.message || String(e);
    }

    function rendreResultats(liste) {
        const wrap = $('#search-results');
        if (!liste.length) { wrap.innerHTML = ''; return; }

        wrap.innerHTML = liste.map(f => {
            const r = S.scorer(f, { weights: poids });
            const suivi = portefeuille.some(p => p.siren === f.siren);
            // Les résultats de recherche n'ont pas encore été confrontés au BODACC :
            // le score n'est définitif qu'une fois la fiche complète ouverte.
            const definitif = f.proceduresStatut === 'ok';
            return `
            <article class="result-card" data-siren="${esc(f.siren)}">
                <div class="result-main">
                    <h3 class="result-name">${esc(f.nom)}</h3>
                    <div class="result-meta">
                        <span>${esc(fmtSiren(f.siren))}</span>
                        <span>·</span>
                        <span>${esc(f.siege.commune || '—')}${f.siege.codePostal ? ' (' + esc(f.siege.codePostal) + ')' : ''}</span>
                        <span>·</span>
                        <span>${esc(f.libelleActivite || f.activitePrincipale || 'Activité non précisée')}</span>
                    </div>
                    <div class="result-badges">
                        ${f.etatAdministratif === 'C'
                    ? '<span class="badge badge-danger">Cessée</span>'
                    : '<span class="badge badge-success">Active</span>'}
                        ${f.categorieEntreprise ? `<span class="badge">${esc(f.categorieEntreprise)}</span>` : ''}
                        ${f.dateCreation ? `<span class="badge">Créée en ${esc(String(f.dateCreation).slice(0, 4))}</span>` : ''}
                        ${suivi ? '<span class="badge badge-accent">Suivie</span>' : ''}
                    </div>
                </div>
                <div class="result-score">
                    <div class="mini-grade grade-${r.grade}">${r.grade}</div>
                    <div class="mini-score">${r.score}<span>/100</span></div>
                    <span class="mini-hint">${definitif ? 'score vérifié' : 'estimation'}</span>
                </div>
            </article>`;
        }).join('');

        $$('#search-results .result-card').forEach(card => {
            card.addEventListener('click', () => ouvrirFiche(card.dataset.siren));
        });
    }

    /* ══════════════════════════════════════════════════════════
       Fiche entreprise
       ══════════════════════════════════════════════════════════ */

    async function ouvrirFiche(siren, origineConnue) {
        const cible = $('#fiche');
        cible.classList.remove('hidden');
        cible.innerHTML = '<div class="loader">Récupération de la fiche complète…</div>';
        cible.scrollIntoView({ behavior: 'smooth', block: 'start' });

        try {
            const { fiche, origine } = await A.obtenirFiche(siren);
            ficheCourante = fiche;
            const resultat = S.scorer(fiche, { weights: poids });
            cible.innerHTML = gabaritFiche(fiche, resultat, origineConnue || origine);
            brancherActionsFiche(fiche, resultat);
        } catch (e) {
            cible.innerHTML = `<div class="fiche-error">${esc(messageErreur(e))}</div>`;
        }
    }

    function gabaritFiche(f, r, origine) {
        const suivi = portefeuille.some(p => p.siren === f.siren);
        const badgeOrigine = origine === 'cache' ? 'Données en cache'
            : origine === 'cache-perime' ? 'Cache (hors ligne)'
                : 'Données à jour';

        return `
        <div class="fiche-inner">
            <button class="fiche-close" id="fiche-close" aria-label="Fermer la fiche">&times;</button>

            <header class="fiche-head">
                <div>
                    <h2 class="fiche-name">${esc(f.nom)}</h2>
                    <div class="fiche-sub">
                        SIREN ${esc(fmtSiren(f.siren))}${f.siret ? ' · SIRET siège ' + esc(f.siret) : ''}
                    </div>
                    <div class="result-badges">
                        ${f.etatAdministratif === 'C'
                ? '<span class="badge badge-danger">Entreprise cessée</span>'
                : '<span class="badge badge-success">Entreprise active</span>'}
                        ${f.categorieEntreprise ? `<span class="badge">${esc(f.categorieEntreprise)}</span>` : ''}
                        ${f.labels.estEss ? '<span class="badge">ESS</span>' : ''}
                        ${f.labels.estRge ? '<span class="badge">RGE</span>' : ''}
                        ${f.labels.estQualiopi ? '<span class="badge">Qualiopi</span>' : ''}
                        <span class="badge badge-muted">${esc(badgeOrigine)}</span>
                    </div>
                </div>
                <div class="fiche-actions">
                    <button class="btn ${suivi ? 'btn-ghost' : 'btn-primary'} btn-sm" id="fiche-suivi">
                        ${suivi ? 'Retirer du portefeuille' : 'Ajouter au portefeuille'}
                    </button>
                    <button class="btn btn-ghost btn-sm" id="fiche-refresh">Rafraîchir</button>
                </div>
            </header>

            <section class="score-panel">
                ${gabaritJauge(r)}
                <div class="score-side">
                    <div class="score-line">
                        <span>Niveau de risque</span>
                        <strong class="risk-${r.grade}">${esc(r.risque)}</strong>
                    </div>
                    <div class="score-line">
                        <span>Indice de confiance</span>
                        <strong>${r.confiance} %</strong>
                    </div>
                    <div class="confiance-bar"><div style="width:${r.confiance}%"></div></div>
                    <p class="confiance-note">${r.confiance < 55
                ? 'Peu de données publiques disponibles : le score repose en partie sur des valeurs neutres.'
                : 'La majorité des piliers est documentée par les données publiques.'}</p>
                    ${r.plafonne ? `
                    <div class="cap-notice">
                        Score plafonné : la moyenne pondérée atteignait ${r.scoreBrut}/100, mais une règle
                        éliminatoire s’applique.
                    </div>` : ''}
                    ${r.encours ? `
                    <div class="encours">
                        <span>Plafond d’encours indicatif</span>
                        <strong>${esc(S.fmtEuro(r.encours.montant))}</strong>
                        <small>${r.encours.montant > 0
                    ? `soit ${Math.round(r.encours.coef * 100)} % d’un mois de chiffre d’affaires (${esc(S.fmtEuro(r.encours.base))})`
                    : 'aucun encours recommandé au vu du score'}</small>
                    </div>` : `
                    <div class="encours encours-vide">
                        <span>Plafond d’encours indicatif</span>
                        <small>non calculable : chiffre d’affaires non publié</small>
                    </div>`}
                </div>
            </section>

            ${r.drapeaux.length ? `
            <section class="fiche-block">
                <h3 class="block-title">Points de vigilance</h3>
                <ul class="flag-list">
                    ${r.drapeaux.map(d => `
                    <li class="flag flag-${esc(d.gravite)}">
                        <strong>${esc(d.titre)}</strong>
                        <span>${esc(d.detail)}</span>
                    </li>`).join('')}
                </ul>
            </section>` : `
            <section class="fiche-block">
                <h3 class="block-title">Points de vigilance</h3>
                <p class="empty-inline">Aucun signal négatif détecté dans les données publiques.</p>
            </section>`}

            ${r.forces.length ? `
            <section class="fiche-block">
                <h3 class="block-title">Points forts</h3>
                <ul class="force-list">${r.forces.map(x => `<li>${esc(x)}</li>`).join('')}</ul>
            </section>` : ''}

            <section class="fiche-block">
                <h3 class="block-title">Détail par pilier</h3>
                <div class="pillars">
                    ${r.piliers.map(p => `
                    <div class="pillar">
                        <div class="pillar-head">
                            <span class="pillar-name">${esc(p.libelle)}</span>
                            <span class="pillar-weight">poids ${p.poids}</span>
                            <span class="pillar-note ${classeNote(p.note)}">${p.note}</span>
                        </div>
                        <div class="pillar-bar"><div class="${classeNote(p.note)}" style="width:${p.note}%"></div></div>
                        <ul class="pillar-details">
                            ${p.details.map(d => `<li>${esc(d)}</li>`).join('')}
                            ${p.confiance === 0 ? '<li class="detail-warn">Donnée absente : valeur neutre appliquée</li>' : ''}
                        </ul>
                    </div>`).join('')}
                </div>
            </section>

            <section class="fiche-block">
                <h3 class="block-title">Comptes annuels déposés</h3>
                ${f.exercices.length ? gabaritFinances(f.exercices) : `
                <p class="empty-inline">
                    Aucun compte annuel n’est disponible pour cette entreprise. De nombreuses PME demandent la
                    confidentialité de leurs comptes, ce qui est légal mais limite la vérification de solvabilité.
                </p>`}
            </section>

            <section class="fiche-block">
                <h3 class="block-title">Procédures collectives (BODACC)</h3>
                ${gabaritProcedures(f)}
            </section>

            <section class="fiche-block">
                <h3 class="block-title">Identité</h3>
                <div class="kv-grid">
                    <div class="kv"><span>Raison sociale</span><strong>${esc(f.raisonSociale || f.nom)}</strong></div>
                    <div class="kv"><span>Sigle</span><strong>${esc(f.sigle || '—')}</strong></div>
                    <div class="kv"><span>Date de création</span><strong>${esc(fmtDate(f.dateCreation))}</strong></div>
                    <div class="kv"><span>Forme juridique</span><strong>${esc(libelleJuridique(f.natureJuridique))}</strong></div>
                    <div class="kv"><span>Code NAF</span><strong>${esc(f.activitePrincipale || '—')}</strong></div>
                    <div class="kv"><span>Activité</span><strong>${esc(f.libelleActivite || libelleSection(f) || '—')}</strong></div>
                    <div class="kv"><span>Effectif salarié</span><strong>${esc(libelleEffectif(f.trancheEffectif))}</strong></div>
                    <div class="kv"><span>Catégorie</span><strong>${esc(f.categorieEntreprise || '—')}</strong></div>
                    <div class="kv"><span>Établissements</span><strong>${f.etablissementsOuverts !== null ? esc(f.etablissementsOuverts + ' ouvert(s)') : '—'}${f.etablissementsTotal !== null ? esc(' sur ' + f.etablissementsTotal) : ''}</strong></div>
                    <div class="kv kv-wide"><span>Adresse du siège</span><strong>${esc([f.siege.adresse, f.siege.codePostal, f.siege.commune].filter(Boolean).join(', ') || '—')}</strong></div>
                    <div class="kv"><span>Diffusion</span><strong>${f.statutDiffusion === 'P' ? 'Non diffusible' : 'Publique'}</strong></div>
                    <div class="kv"><span>Mise à jour SIRENE</span><strong>${esc(fmtDate(f.dateMiseAJour))}</strong></div>
                </div>
            </section>

            ${f.dirigeants.length ? `
            <section class="fiche-block">
                <h3 class="block-title">Dirigeants</h3>
                <div class="table-wrapper">
                    <table class="data-table">
                        <thead><tr><th>Nom</th><th>Qualité</th><th>Année de naissance</th></tr></thead>
                        <tbody>
                            ${f.dirigeants.map(d => `
                            <tr>
                                <td>${esc(d.nom)}</td>
                                <td>${esc(d.qualite || '—')}</td>
                                <td>${esc(d.anneeNaissance || '—')}</td>
                            </tr>`).join('')}
                        </tbody>
                    </table>
                </div>
            </section>` : ''}

            <footer class="fiche-foot">
                Score calculé le ${esc(fmtDate(r.calculeLe))} à partir des données publiques
                (SIRENE / comptes annuels / BODACC). Outil d’aide à la décision : ne constitue pas
                une notation financière réglementée.
            </footer>
        </div>`;
    }

    /** Jauge circulaire SVG — aucune librairie de graphique n'est nécessaire. */
    function gabaritJauge(r) {
        const rayon = 62, circ = 2 * Math.PI * rayon;
        const offset = circ * (1 - r.score / 100);
        return `
        <div class="gauge-wrap">
            <svg class="gauge" viewBox="0 0 160 160" role="img" aria-label="Score ${r.score} sur 100">
                <circle class="gauge-track" cx="80" cy="80" r="${rayon}"></circle>
                <circle class="gauge-value grade-stroke-${r.grade}" cx="80" cy="80" r="${rayon}"
                        stroke-dasharray="${circ.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}"></circle>
            </svg>
            <div class="gauge-center">
                <div class="gauge-score">${r.score}</div>
                <div class="gauge-max">/ 100</div>
                <div class="gauge-grade grade-${r.grade}">${r.grade}</div>
            </div>
        </div>`;
    }

    /** Histogramme SVG du chiffre d'affaires et du résultat net par exercice. */
    function gabaritFinances(exercices) {
        const ex = exercices.slice().sort((a, b) => a.annee - b.annee);
        const valeurs = ex.flatMap(e => [e.ca, e.resultatNet]).filter(v => v !== null && v !== undefined);
        const max = Math.max.apply(null, valeurs.map(Math.abs).concat([1]));

        const largeur = 100 / Math.max(ex.length, 1);
        const barres = ex.map((e, i) => {
            const x = i * largeur;
            const hCa = e.ca !== null ? Math.abs(e.ca) / max * 100 : 0;
            const hRn = e.resultatNet !== null ? Math.abs(e.resultatNet) / max * 100 : 0;
            const rnNegatif = (e.resultatNet || 0) < 0;
            return `
            <div class="fin-col" style="width:${largeur}%">
                <div class="fin-bars">
                    <div class="fin-bar fin-ca" style="height:${hCa}%" title="CA ${S.fmtEuro(e.ca)}"></div>
                    <div class="fin-bar ${rnNegatif ? 'fin-rn-neg' : 'fin-rn'}" style="height:${hRn}%" title="Résultat net ${S.fmtEuro(e.resultatNet)}"></div>
                </div>
                <div class="fin-year">${e.annee}</div>
            </div>`;
        }).join('');

        return `
        <div class="fin-legend">
            <span><i class="dot dot-ca"></i>Chiffre d’affaires</span>
            <span><i class="dot dot-rn"></i>Résultat net (positif)</span>
            <span><i class="dot dot-rn-neg"></i>Résultat net (perte)</span>
        </div>
        <div class="fin-chart">${barres}</div>
        <div class="table-wrapper">
            <table class="data-table">
                <thead><tr><th>Exercice</th><th class="num">Chiffre d’affaires</th><th class="num">Résultat net</th><th class="num">Marge nette</th></tr></thead>
                <tbody>
                    ${ex.slice().reverse().map(e => {
            const marge = (e.ca && e.ca > 0 && e.resultatNet !== null)
                ? ((e.resultatNet / e.ca) * 100).toFixed(1).replace('.', ',') + ' %' : '—';
            return `<tr>
                            <td>${e.annee}</td>
                            <td class="num">${esc(S.fmtEuro(e.ca))}</td>
                            <td class="num ${(e.resultatNet || 0) < 0 ? 'neg' : 'pos'}">${esc(S.fmtEuro(e.resultatNet))}</td>
                            <td class="num">${esc(marge)}</td>
                        </tr>`;
        }).join('')}
                </tbody>
            </table>
        </div>`;
    }

    function gabaritProcedures(f) {
        if (f.proceduresStatut === 'indisponible') {
            return `<p class="empty-inline warn">
                La vérification BODACC n’a pas pu aboutir (API injoignable ou hors ligne). L’absence de procédure
                affichée ne vaut donc pas confirmation. Rafraîchissez la fiche une fois la connexion rétablie.
            </p>`;
        }
        if (f.proceduresStatut === 'non-verifie') {
            return `<p class="empty-inline warn">
                Vérification BODACC non effectuée pour cette fiche. Rafraîchissez-la pour lancer le contrôle.
            </p>`;
        }
        if (!f.procedures || !f.procedures.length) {
            return `<p class="empty-inline">
                Aucune annonce de procédure collective au BODACC pour ce SIREN.
            </p>`;
        }
        return `
        <ul class="proc-list">
            ${f.procedures.map(p => `
            <li class="proc">
                <span class="proc-date">${esc(fmtDate(p.date))}</span>
                <span class="proc-label">${esc(p.libelle)}</span>
                ${p.tribunal ? `<span class="proc-trib">${esc(p.tribunal)}</span>` : ''}
            </li>`).join('')}
        </ul>`;
    }

    function classeNote(n) {
        return n >= 75 ? 'note-good' : n >= 55 ? 'note-ok' : n >= 40 ? 'note-warn' : 'note-bad';
    }

    function libelleEffectif(code) {
        const e = S.EFFECTIF[code];
        return e ? e[0] : 'Non renseigné';
    }

    function libelleJuridique(code) {
        const c = String(code || '');
        if (!c) return '—';
        const exact = S.NATURE_JURIDIQUE[c];
        if (exact) return exact[0] + ' (' + c + ')';
        const fam = S.NATURE_JURIDIQUE_FAMILLE[c.charAt(0)];
        return fam ? fam[0] + ' (' + c + ')' : 'Code ' + c;
    }

    function libelleSection(f) {
        const s = f.sectionNaf || S.sectionDepuisNaf(f.activitePrincipale);
        return s && S.SECTION_NAF[s] ? S.SECTION_NAF[s][0] : null;
    }

    function brancherActionsFiche(f, r) {
        const close = $('#fiche-close');
        if (close) close.addEventListener('click', () => $('#fiche').classList.add('hidden'));

        const suivi = $('#fiche-suivi');
        if (suivi) suivi.addEventListener('click', async () => {
            const idx = portefeuille.findIndex(p => p.siren === f.siren);
            if (idx >= 0) {
                portefeuille.splice(idx, 1);
                toast('Retirée du portefeuille');
            } else {
                portefeuille.push(entreePortefeuille(f, r));
                toast('Ajoutée au portefeuille', 'success');
            }
            await sauverPortefeuille();
            majBadgePortefeuille();
            await ouvrirFiche(f.siren);
            rendreResultats(resultatsRecherche);
        });

        const refresh = $('#fiche-refresh');
        if (refresh) refresh.addEventListener('click', async () => {
            refresh.disabled = true;
            refresh.textContent = 'Rafraîchissement…';
            try {
                const { fiche } = await A.obtenirFiche(f.siren, { forcerRafraichissement: true });
                const nouveau = S.scorer(fiche, { weights: poids });
                const idx = portefeuille.findIndex(p => p.siren === f.siren);
                if (idx >= 0) {
                    portefeuille[idx] = entreePortefeuille(fiche, nouveau, portefeuille[idx].ajouteLe);
                    await sauverPortefeuille();
                }
                await ouvrirFiche(f.siren, 'reseau');
                toast('Fiche mise à jour', 'success');
            } catch (e) {
                toast(messageErreur(e), 'error');
                refresh.disabled = false;
                refresh.textContent = 'Rafraîchir';
            }
        });
    }

    function entreePortefeuille(fiche, resultat, ajouteLe) {
        return {
            siren: fiche.siren,
            nom: fiche.nom,
            fiche,
            resultat,
            ajouteLe: ajouteLe || new Date().toISOString(),
            majLe: new Date().toISOString()
        };
    }

    /* ══════════════════════════════════════════════════════════
       Portefeuille
       ══════════════════════════════════════════════════════════ */

    function initPortefeuille() {
        $('#pf-search').addEventListener('input', rendrePortefeuille);
        $('#pf-sort').addEventListener('change', rendrePortefeuille);
        $('#pf-grade').addEventListener('change', rendrePortefeuille);
        $('#pf-export').addEventListener('click', exporterPortefeuille);
        $('#pf-refresh').addEventListener('click', rafraichirPortefeuille);
        $('#pf-clear').addEventListener('click', async () => {
            if (!portefeuille.length) return;
            if (!confirm(`Retirer les ${portefeuille.length} entreprises du portefeuille ? Le cache des fiches est conservé.`)) return;
            portefeuille = [];
            await sauverPortefeuille();
            majBadgePortefeuille();
            rendrePortefeuille();
            toast('Portefeuille vidé');
        });
    }

    function portefeuilleFiltre() {
        const q = $('#pf-search').value.trim().toLowerCase();
        const grade = $('#pf-grade').value;
        let liste = portefeuille.slice();

        if (q) liste = liste.filter(p =>
            (p.nom || '').toLowerCase().includes(q) || String(p.siren).includes(q.replace(/\D/g, '')));
        if (grade) liste = liste.filter(p => p.resultat && p.resultat.grade === grade);

        const tri = $('#pf-sort').value;
        liste.sort((a, b) => {
            const sa = a.resultat ? a.resultat.score : 0, sb = b.resultat ? b.resultat.score : 0;
            if (tri === 'score-asc') return sa - sb;
            if (tri === 'score-desc') return sb - sa;
            if (tri === 'nom') return (a.nom || '').localeCompare(b.nom || '', 'fr');
            return new Date(b.ajouteLe) - new Date(a.ajouteLe);
        });
        return liste;
    }

    function rendrePortefeuille() {
        const liste = portefeuilleFiltre();
        const tbody = $('#pf-tbody');
        const vide = $('#pf-empty');

        $('#pf-summary').innerHTML = gabaritSyntheseportefeuille();

        if (!portefeuille.length) {
            tbody.innerHTML = '';
            vide.style.display = 'block';
            vide.textContent = 'Aucune entreprise suivie pour l’instant. Recherchez une entreprise puis cliquez sur « Ajouter au portefeuille ».';
            return;
        }
        vide.style.display = liste.length ? 'none' : 'block';
        if (!liste.length) vide.textContent = 'Aucune entreprise ne correspond à ce filtre.';

        tbody.innerHTML = liste.map(p => {
            const r = p.resultat || {};
            const f = p.fiche || {};
            return `
            <tr data-siren="${esc(p.siren)}">
                <td class="cell-name">
                    <strong>${esc(p.nom)}</strong>
                    ${f.etatAdministratif === 'C' ? '<span class="badge badge-danger badge-xs">Cessée</span>' : ''}
                </td>
                <td>${esc(fmtSiren(p.siren))}</td>
                <td>${esc(libelleSection(f) || '—')}</td>
                <td class="num"><span class="${classeNote(r.score || 0)}">${r.score !== undefined ? r.score : '—'}</span></td>
                <td><span class="grade-chip grade-${esc(r.grade || 'E')}">${esc(r.grade || '—')}</span></td>
                <td>${esc(r.risque || '—')}</td>
                <td class="num">${r.encours ? esc(S.fmtEuro(r.encours.montant)) : '—'}</td>
                <td>${esc(fmtDateCourte(p.majLe))}</td>
                <td class="cell-actions">
                    <button class="link-btn" data-action="open">Ouvrir</button>
                    <button class="link-btn link-danger" data-action="remove">Retirer</button>
                </td>
            </tr>`;
        }).join('');

        $$('#pf-tbody tr').forEach(tr => {
            tr.querySelector('[data-action="open"]').addEventListener('click', () => {
                $$('.nav-tab').forEach(b => b.classList.remove('active'));
                $$('.tab-content').forEach(c => c.classList.remove('active'));
                document.querySelector('.nav-tab[data-tab="recherche"]').classList.add('active');
                $('#tab-recherche').classList.add('active');
                ouvrirFiche(tr.dataset.siren);
            });
            tr.querySelector('[data-action="remove"]').addEventListener('click', async () => {
                const idx = portefeuille.findIndex(p => p.siren === tr.dataset.siren);
                if (idx >= 0) {
                    portefeuille.splice(idx, 1);
                    await sauverPortefeuille();
                    majBadgePortefeuille();
                    rendrePortefeuille();
                    toast('Entreprise retirée');
                }
            });
        });
    }

    function gabaritSyntheseportefeuille() {
        if (!portefeuille.length) return '';
        const scores = portefeuille.map(p => (p.resultat && p.resultat.score) || 0);
        const moyenne = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
        const parGrade = { A: 0, B: 0, C: 0, D: 0, E: 0 };
        portefeuille.forEach(p => { if (p.resultat && parGrade[p.resultat.grade] !== undefined) parGrade[p.resultat.grade]++; });
        const risquees = parGrade.D + parGrade.E;

        return `
        <div class="kpi-row">
            <div class="kpi">
                <span class="kpi-label">Entreprises suivies</span>
                <span class="kpi-value">${portefeuille.length}</span>
            </div>
            <div class="kpi">
                <span class="kpi-label">Score moyen</span>
                <span class="kpi-value ${classeNote(moyenne)}">${moyenne}<small>/100</small></span>
            </div>
            <div class="kpi">
                <span class="kpi-label">À surveiller (D ou E)</span>
                <span class="kpi-value ${risquees ? 'note-bad' : 'note-good'}">${risquees}</span>
            </div>
            <div class="kpi kpi-wide">
                <span class="kpi-label">Répartition par grade</span>
                <div class="grade-dist">
                    ${['A', 'B', 'C', 'D', 'E'].map(g => `
                    <div class="dist-seg grade-bg-${g}" style="flex:${parGrade[g] || 0}" title="${parGrade[g]} entreprise(s) en ${g}"></div>`).join('')}
                </div>
                <div class="grade-dist-legend">
                    ${['A', 'B', 'C', 'D', 'E'].map(g => `<span><i class="dot grade-bg-${g}"></i>${g} : ${parGrade[g]}</span>`).join('')}
                </div>
            </div>
        </div>`;
    }

    async function rafraichirPortefeuille() {
        if (!portefeuille.length) { toast('Portefeuille vide'); return; }
        if (navigator.onLine === false) { toast('Hors ligne : rafraîchissement impossible', 'error'); return; }

        const btn = $('#pf-refresh');
        btn.disabled = true;
        let ok = 0, ko = 0;
        for (let i = 0; i < portefeuille.length; i++) {
            const p = portefeuille[i];
            btn.textContent = `Rafraîchissement ${i + 1}/${portefeuille.length}…`;
            statut('#pf-status', `Mise à jour de ${p.nom}…`, 'info');
            try {
                const { fiche } = await A.obtenirFiche(p.siren, { forcerRafraichissement: true });
                portefeuille[i] = entreePortefeuille(fiche, S.scorer(fiche, { weights: poids }), p.ajouteLe);
                ok++;
            } catch (e) {
                ko++;
            }
            // Les API publiques sont limitées en débit : on espace les appels.
            await pause(220);
        }
        await sauverPortefeuille();
        btn.disabled = false;
        btn.textContent = 'Rafraîchir tout';
        statut('#pf-status', `${ok} fiche(s) mise(s) à jour${ko ? `, ${ko} en échec` : ''}.`, ko ? 'warn' : 'info');
        rendrePortefeuille();
    }

    function pause(ms) { return new Promise(r => setTimeout(r, ms)); }

    function majBadgePortefeuille() {
        $('#badge-portefeuille').textContent = portefeuille.length;
    }

    /* ══════════════════════════════════════════════════════════
       Export CSV
       ══════════════════════════════════════════════════════════ */

    function csvEchappe(v) {
        const s = v === null || v === undefined ? '' : String(v);
        return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }

    function telechargerCsv(nomFichier, lignes) {
        // Point-virgule + BOM : Excel en configuration française ouvre le fichier correctement.
        const contenu = '﻿' + lignes.map(l => l.map(csvEchappe).join(';')).join('\r\n');
        const blob = new Blob([contenu], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = nomFichier;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function lignesCsv(entrees) {
        const entete = [
            'SIREN', 'Dénomination', 'Score', 'Grade', 'Risque', 'Confiance (%)',
            'État', 'Date de création', 'Forme juridique', 'Code NAF', 'Secteur',
            'Effectif', 'Catégorie', 'Commune', 'Code postal',
            'Dernier exercice', 'CA (€)', 'Résultat net (€)',
            'Encours indicatif (€)', 'Procédure collective', 'Points de vigilance', 'Mis à jour le'
        ];
        const lignes = entrees.map(p => {
            const f = p.fiche || {}, r = p.resultat || {};
            const ex = (f.exercices || []).slice().sort((a, b) => a.annee - b.annee);
            const dernier = ex[ex.length - 1] || {};
            return [
                f.siren || p.siren,
                f.nom || p.nom,
                r.score !== undefined ? r.score : '',
                r.grade || '',
                r.risque || '',
                r.confiance !== undefined ? r.confiance : '',
                f.etatAdministratif === 'C' ? 'Cessée' : 'Active',
                f.dateCreation || '',
                libelleJuridique(f.natureJuridique),
                f.activitePrincipale || '',
                libelleSection(f) || '',
                libelleEffectif(f.trancheEffectif),
                f.categorieEntreprise || '',
                (f.siege && f.siege.commune) || '',
                (f.siege && f.siege.codePostal) || '',
                dernier.annee || '',
                dernier.ca !== undefined && dernier.ca !== null ? dernier.ca : '',
                dernier.resultatNet !== undefined && dernier.resultatNet !== null ? dernier.resultatNet : '',
                r.encours ? r.encours.montant : '',
                r.procedure ? r.procedure.libelle : 'Aucune',
                (r.drapeaux || []).map(d => d.titre).join(' | '),
                p.majLe || ''
            ];
        });
        return [entete].concat(lignes);
    }

    function exporterPortefeuille() {
        if (!portefeuille.length) { toast('Portefeuille vide'); return; }
        const date = new Date().toISOString().slice(0, 10);
        telechargerCsv(`liora_scoring_portefeuille_${date}.csv`, lignesCsv(portefeuilleFiltre()));
        toast('Export CSV généré', 'success');
    }

    /* ══════════════════════════════════════════════════════════
       Import en masse
       ══════════════════════════════════════════════════════════ */

    function initImport() {
        const drop = $('#import-drop');
        const input = $('#import-file');

        drop.addEventListener('click', () => input.click());
        drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('dragover'); });
        drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
        drop.addEventListener('drop', e => {
            e.preventDefault();
            drop.classList.remove('dragover');
            if (e.dataTransfer.files.length) lireFichierImport(e.dataTransfer.files[0]);
        });
        input.addEventListener('change', () => {
            if (input.files.length) lireFichierImport(input.files[0]);
        });

        $('#import-run').addEventListener('click', lancerImport);
        $('#import-export').addEventListener('click', () => {
            const reussis = resultatsImport.filter(r => r.fiche);
            if (!reussis.length) { toast('Aucun résultat à exporter'); return; }
            const date = new Date().toISOString().slice(0, 10);
            telechargerCsv(`liora_scoring_import_${date}.csv`, lignesCsv(reussis.map(r => ({
                siren: r.siren, nom: r.fiche.nom, fiche: r.fiche, resultat: r.resultat, majLe: new Date().toISOString()
            }))));
            toast('Export CSV généré', 'success');
        });
    }

    function lireFichierImport(file) {
        const reader = new FileReader();
        reader.onload = () => {
            $('#import-text').value = String(reader.result || '');
            const n = extraireSirens(String(reader.result || '')).length;
            statut('#import-status', `${file.name} chargé — ${n} identifiant(s) détecté(s).`, 'info');
        };
        reader.onerror = () => statut('#import-status', 'Lecture du fichier impossible.', 'error');
        reader.readAsText(file, 'UTF-8');
    }

    /** Extrait les SIREN/SIRET d'un texte libre (CSV, liste collée, colonne Excel). */
    function extraireSirens(texte) {
        const jetons = String(texte || '').split(/[\s,;|"']+/);
        const vus = new Set();
        const out = [];
        jetons.forEach(j => {
            const siren = A.extraireSiren(j);
            if (siren && !vus.has(siren)) { vus.add(siren); out.push(siren); }
        });
        return out;
    }

    async function lancerImport() {
        const sirens = extraireSirens($('#import-text').value);
        if (!sirens.length) {
            statut('#import-status', 'Aucun SIREN (9 chiffres) ni SIRET (14 chiffres) détecté dans la saisie.', 'warn');
            return;
        }
        if (navigator.onLine === false) {
            statut('#import-status', 'Hors ligne : impossible de récupérer les fiches. Reconnectez-vous puis relancez.', 'error');
            return;
        }

        const ajouterAuPf = $('#import-add-pf').checked;
        const btn = $('#import-run');
        btn.disabled = true;
        btn.textContent = 'Scoring en cours…';
        resultatsImport = [];
        $('#import-tbody').innerHTML = '';
        $('#import-progress-wrap').classList.remove('hidden');
        $('#import-export').classList.add('hidden');
        statut('#import-status', `${sirens.length} identifiant(s) à traiter.`, 'info');

        for (let i = 0; i < sirens.length; i++) {
            const siren = sirens[i];
            majProgression(i, sirens.length);
            let entree;
            try {
                const { fiche } = await A.obtenirFiche(siren);
                const resultat = S.scorer(fiche, { weights: poids });
                entree = { siren, fiche, resultat, statut: 'ok' };
                if (ajouterAuPf) {
                    const idx = portefeuille.findIndex(p => p.siren === siren);
                    const nouvelle = entreePortefeuille(fiche, resultat, idx >= 0 ? portefeuille[idx].ajouteLe : null);
                    if (idx >= 0) portefeuille[idx] = nouvelle; else portefeuille.push(nouvelle);
                }
            } catch (e) {
                entree = { siren, statut: 'erreur', message: messageErreur(e) };
            }
            resultatsImport.push(entree);
            ajouterLigneImport(entree);
            await pause(220); // respect du débit des API publiques
        }

        majProgression(sirens.length, sirens.length);
        if (ajouterAuPf) {
            await sauverPortefeuille();
            majBadgePortefeuille();
        }

        const ok = resultatsImport.filter(r => r.statut === 'ok').length;
        const ko = resultatsImport.length - ok;
        statut('#import-status', `Terminé : ${ok} entreprise(s) scorée(s)${ko ? `, ${ko} en échec` : ''}${ajouterAuPf && ok ? ' — ajoutées au portefeuille' : ''}.`, ko ? 'warn' : 'info');
        btn.disabled = false;
        btn.textContent = 'Lancer le scoring';
        if (ok) $('#import-export').classList.remove('hidden');
    }

    function majProgression(fait, total) {
        const pct = total ? Math.round(fait / total * 100) : 0;
        $('#import-progress').style.width = pct + '%';
        $('#import-progress-label').textContent = `${fait} / ${total}`;
    }

    function ajouterLigneImport(e) {
        const tr = document.createElement('tr');
        if (e.statut === 'ok') {
            tr.innerHTML = `
                <td>${esc(fmtSiren(e.siren))}</td>
                <td>${esc(e.fiche.nom)}</td>
                <td class="num"><span class="${classeNote(e.resultat.score)}">${e.resultat.score}</span></td>
                <td><span class="grade-chip grade-${esc(e.resultat.grade)}">${esc(e.resultat.grade)}</span></td>
                <td><span class="status-ok">Scorée</span></td>`;
        } else {
            tr.innerHTML = `
                <td>${esc(fmtSiren(e.siren))}</td>
                <td class="muted">—</td>
                <td class="num">—</td>
                <td>—</td>
                <td><span class="status-error" title="${esc(e.message)}">Échec</span></td>`;
        }
        $('#import-tbody').appendChild(tr);
    }

    /* ══════════════════════════════════════════════════════════
       Réglages
       ══════════════════════════════════════════════════════════ */

    function initReglages() {
        rendrePoids();

        $('#weights-save').addEventListener('click', async () => {
            try {
                await A.idbSet(CLE_POIDS, poids);
                rescorerTout();
                toast('Pondérations enregistrées — portefeuille rescoré', 'success');
            } catch (e) {
                toast('Enregistrement impossible', 'error');
            }
        });

        $('#weights-reset').addEventListener('click', async () => {
            poids = Object.assign({}, S.DEFAULT_WEIGHTS);
            rendrePoids();
            await A.idbSet(CLE_POIDS, poids);
            rescorerTout();
            toast('Pondérations réinitialisées');
        });

        $('#cache-clear').addEventListener('click', async () => {
            const n = await A.viderCache();
            await rafraichirStatsReglages();
            toast(`${n} fiche(s) supprimée(s) du cache`);
        });

        $('#pf-backup').addEventListener('click', () => {
            const contenu = JSON.stringify({
                version: 1,
                exporteLe: new Date().toISOString(),
                poids,
                portefeuille
            }, null, 2);
            const blob = new Blob([contenu], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `liora_scoring_sauvegarde_${new Date().toISOString().slice(0, 10)}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            toast('Sauvegarde générée', 'success');
        });

        $('#pf-restore').addEventListener('change', e => {
            const file = e.target.files && e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = async () => {
                try {
                    const data = JSON.parse(String(reader.result));
                    if (!Array.isArray(data.portefeuille)) throw new Error('Format inattendu');
                    if (!confirm(`Restaurer ${data.portefeuille.length} entreprise(s) ? Le portefeuille actuel sera remplacé.`)) return;
                    portefeuille = data.portefeuille;
                    if (data.poids) poids = Object.assign({}, S.DEFAULT_WEIGHTS, data.poids);
                    await sauverPortefeuille();
                    await A.idbSet(CLE_POIDS, poids);
                    rendrePoids();
                    majBadgePortefeuille();
                    rendrePortefeuille();
                    await rafraichirStatsReglages();
                    toast('Sauvegarde restaurée', 'success');
                } catch (err) {
                    toast('Fichier de sauvegarde illisible', 'error');
                } finally {
                    e.target.value = '';
                }
            };
            reader.readAsText(file, 'UTF-8');
        });
    }

    /* ── Diagnostic des API ── */

    let dernierDiagnostic = null;

    function initDiagnostic() {
        $('#diag-run').addEventListener('click', lancerDiagnostic);
        $('#diag-copy').addEventListener('click', () => {
            if (!dernierDiagnostic) return;
            const texte = A.rapportTexte(dernierDiagnostic);
            // navigator.clipboard est indisponible en origine file:// sur certains
            // navigateurs : on retombe sur une zone de texte sélectionnable.
            const copier = navigator.clipboard && navigator.clipboard.writeText
                ? navigator.clipboard.writeText(texte)
                : Promise.reject(new Error('presse-papiers indisponible'));
            copier.then(() => toast('Rapport copié dans le presse-papiers', 'success'))
                .catch(() => {
                    const zone = $('#diag-fallback');
                    if (zone) {
                        zone.classList.remove('hidden');
                        zone.value = texte;
                        zone.select();
                        toast('Sélectionnez puis copiez le texte affiché');
                    }
                });
        });
    }

    async function lancerDiagnostic() {
        const btn = $('#diag-run');
        btn.disabled = true;
        btn.textContent = 'Diagnostic en cours…';
        $('#diag-copy').classList.add('hidden');
        $('#diag-result').innerHTML = '<p class="empty-inline">Interrogation des deux API…</p>';

        try {
            const r = await A.diagnostiquer($('#diag-siren').value);
            dernierDiagnostic = r;
            $('#diag-result').innerHTML = gabaritDiagnostic(r);
            $('#diag-copy').classList.remove('hidden');
        } catch (e) {
            $('#diag-result').innerHTML = `<p class="empty-inline warn">${esc(messageErreur(e))}</p>`;
        } finally {
            btn.disabled = false;
            btn.textContent = 'Lancer le diagnostic';
        }
    }

    function gabaritDiagnostic(r) {
        const rech = r.recherche || {};
        const bod = r.bodacc || {};
        const m = rech.mapping || {};
        const critiques = (m.manquants || []).filter(x => x.critique);
        const autres = (m.manquants || []).filter(x => !x.critique);

        function ligne(ok, titre, detail) {
            return `<div class="diag-line ${ok ? 'diag-ok' : 'diag-ko'}">
                <span class="diag-mark">${ok ? '✓' : '✗'}</span>
                <span class="diag-title">${esc(titre)}</span>
                <span class="diag-detail">${esc(detail)}</span>
            </div>`;
        }

        const blocs = [];

        blocs.push(ligne(!!rech.ok, 'API Recherche d’Entreprises',
            rech.ok ? `${rech.ms} ms · ${rech.totalResultats || 0} résultat(s)`
                : (rech.erreur || 'échec')));

        if (rech.ok) {
            blocs.push(ligne(critiques.length === 0, 'Champs critiques du mapping',
                critiques.length === 0
                    ? `les ${m.presents} champs attendus sont présents`
                    : `manquants : ${critiques.map(x => x.champ).join(', ')}`));

            blocs.push(ligne((m.exercices || 0) > 0, 'Comptes annuels',
                m.exercices > 0 ? `${m.exercices} exercice(s) lisible(s)`
                    : 'aucun exercice lu — normal si l’entreprise ne publie pas ses comptes'));

            if (autres.length) {
                blocs.push(ligne(true, 'Champs optionnels absents',
                    autres.map(x => x.champ).join(', ')));
            }
            if ((m.nonMappes || []).length) {
                blocs.push(ligne(true, 'Champs renvoyés mais non exploités',
                    m.nonMappes.join(', ')));
            }
        }

        blocs.push(ligne(!!bod.ok, 'BODACC — procédures collectives',
            bod.ok ? `${bod.ms} ms · stratégie « ${bod.strategie} » · ${bod.annonces} annonce(s)`
                : (bod.erreur || 'échec')));

        const toutOk = rech.ok && bod.ok && critiques.length === 0;
        const verdict = toutOk
            ? { classe: 'diag-verdict-ok', texte: 'Tout est opérationnel : les deux API répondent et le mapping est complet.' }
            : rech.ok
                ? { classe: 'diag-verdict-warn', texte: 'L’application fonctionne, mais un écart a été détecté (voir ci-dessus). Copiez le rapport pour le transmettre.' }
                : { classe: 'diag-verdict-ko', texte: 'L’API principale est injoignable depuis ce navigateur. Vérifiez la connexion, un éventuel proxy d’entreprise ou un bloqueur de scripts.' };

        return `
        <div class="diag-lines">${blocs.join('')}</div>
        <p class="diag-verdict ${verdict.classe}">${esc(verdict.texte)}</p>
        <textarea id="diag-fallback" class="hidden" rows="10" readonly aria-label="Rapport de diagnostic"></textarea>
        ${rech.brut ? `
        <details class="diag-raw">
            <summary>Réponse brute de l’API (JSON)</summary>
            <pre>${esc(JSON.stringify(rech.brut, null, 2))}</pre>
        </details>` : ''}`;
    }

    function rendrePoids() {
        const wrap = $('#weights-list');
        wrap.innerHTML = Object.keys(S.DEFAULT_WEIGHTS).map(cle => `
        <div class="weight-row">
            <label for="w-${cle}">${esc(S.PILLAR_LABELS[cle])}</label>
            <input type="range" id="w-${cle}" data-cle="${cle}" min="0" max="50" step="1" value="${poids[cle]}">
            <output id="wo-${cle}">${poids[cle]}</output>
        </div>`).join('');

        $$('#weights-list input[type="range"]').forEach(input => {
            input.addEventListener('input', () => {
                const cle = input.dataset.cle;
                poids[cle] = parseInt(input.value, 10);
                $('#wo-' + cle).textContent = input.value;
                majTotalPoids();
            });
        });
        majTotalPoids();
    }

    function majTotalPoids() {
        const total = Object.keys(S.DEFAULT_WEIGHTS).reduce((a, c) => a + (poids[c] || 0), 0);
        const el = $('#weights-total');
        el.textContent = total;
        el.className = total === 0 ? 'note-bad' : '';
    }

    /** Recalcule les scores du portefeuille avec les pondérations courantes. */
    function rescorerTout() {
        portefeuille = portefeuille.map(p => p.fiche
            ? Object.assign({}, p, { resultat: S.scorer(p.fiche, { weights: poids }) })
            : p);
        sauverPortefeuille();
        rendrePortefeuille();
        if (ficheCourante) ouvrirFiche(ficheCourante.siren);
        if (resultatsRecherche.length) rendreResultats(resultatsRecherche);
    }

    async function rafraichirStatsReglages() {
        try { $('#cache-count').textContent = await A.tailleCache(); }
        catch (e) { $('#cache-count').textContent = '—'; }
        $('#pf-count').textContent = portefeuille.length;
    }

    /* ══════════════════════════════════════════════════════════
       Démarrage
       ══════════════════════════════════════════════════════════ */

    async function demarrer() {
        // Le stockage persistant évite que le navigateur évince le portefeuille.
        if (navigator.storage && navigator.storage.persist) {
            navigator.storage.persist().catch(() => { });
        }
        await chargerEtat();
        initOnglets();
        initReseau();
        initRecherche();
        initPortefeuille();
        initImport();
        initReglages();
        initDiagnostic();
        majBadgePortefeuille();
        rendrePortefeuille();
        await rafraichirStatsReglages();
        $('#search-input').focus();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', demarrer);
    } else {
        demarrer();
    }
})();
