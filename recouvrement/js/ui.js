/* ==========================================================
   Liora — Suivi Recouvrement
   ui.js — Briques d'interface : formatage, tables, graphiques,
           notifications et modale.
   ========================================================== */

(function (global) {
    'use strict';

    const $  = (sel, root) => (root || document).querySelector(sel);
    const $$ = (sel, root) => [...(root || document).querySelectorAll(sel)];

    // ──────────────────────────────────────────────
    //  Formatage
    // ──────────────────────────────────────────────

    const nfEUR = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', minimumFractionDigits: 0, maximumFractionDigits: 0 });
    const nfEUR2 = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const nfNum = new Intl.NumberFormat('fr-FR');

    /**
     * @param {number} v
     * @param {boolean} [precis]  true = deux décimales. Le test est strict :
     *   euros est parfois passé directement comme formateur de colonne, qui
     *   reçoit la ligne en second argument — un objet ne doit pas activer
     *   l'affichage détaillé.
     */
    function euros(v, precis) {
        if (v == null || !isFinite(v)) return '—';
        return (precis === true ? nfEUR2 : nfEUR).format(v);
    }
    /** Format compact pour les axes et les tuiles : 1,2 M€ / 340 k€. */
    function eurosCourt(v) {
        if (v == null || !isFinite(v)) return '—';
        const a = Math.abs(v), s = v < 0 ? '-' : '';
        if (a >= 1e6) return s + (a / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace('.', ',') + ' M€';
        if (a >= 1e3) return s + Math.round(a / 1e3) + ' k€';
        return s + Math.round(a) + ' €';
    }
    function nombre(v) { return (v == null || !isFinite(v)) ? '—' : nfNum.format(Math.round(v)); }
    function pourcent(v, dec) {
        if (v == null || !isFinite(v)) return '—';
        return v.toFixed(dec == null ? 1 : dec).replace('.', ',') + ' %';
    }
    function jours(v) {
        if (v == null || !isFinite(v)) return '—';
        const r = Math.round(v);
        return nfNum.format(r) + ' j';
    }
    function dateFR(d) {
        if (!d || !(d instanceof Date) || isNaN(d.getTime())) return '—';
        return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
    }
    function moisLabel(mk, court) {
        if (!mk) return '—';
        const [y, m] = mk.split('-');
        return new Date(+y, +m - 1).toLocaleDateString('fr-FR', { month: 'short', year: court ? '2-digit' : 'numeric' });
    }
    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    /** Classe CSS d'un état de facture. */
    function etatClass(etat) {
        switch (etat) {
            case 'En retard': return 'st-retard';
            case 'Payée en retard': return 'st-paye-retard';
            case 'Payée': return 'st-paye';
            case 'Non échue': return 'st-non-echue';
            case 'Annulée par avoir': return 'st-annulee';
            default: return 'st-inconnu';
        }
    }

    // ──────────────────────────────────────────────
    //  Notifications & modale
    // ──────────────────────────────────────────────

    function toast(message, type, duree) {
        const stack = $('#toast-stack');
        if (!stack) return;
        const el = document.createElement('div');
        el.className = 'toast toast-' + (type || 'info');
        el.innerHTML = escapeHtml(message);
        stack.appendChild(el);
        requestAnimationFrame(() => el.classList.add('show'));
        setTimeout(() => {
            el.classList.remove('show');
            setTimeout(() => el.remove(), 300);
        }, duree || 4500);
    }

    function modal(title, bodyHtml, actions, opts) {
        const cadre = $('#modal-overlay .modal');
        // Chaque ouverture repart d'une fenêtre de taille normale : seule
        // celle qui le demande s'élargit.
        if (cadre) cadre.classList.toggle('modal-large', !!(opts && opts.large));
        $('#modal-title').textContent = title;
        $('#modal-body').innerHTML = bodyHtml;
        const foot = $('#modal-foot');
        foot.innerHTML = '';
        (actions || []).forEach(a => {
            const b = document.createElement('button');
            b.className = 'btn ' + (a.primary ? 'btn-primary' : 'btn-ghost');
            b.textContent = a.label;
            // UNE ACTION QUI ÉCHOUE NE DOIT PAS PASSER POUR FAITE.
            //
            // L'action était appelée sans être attendue et sans que son rejet
            // soit attrapé : « Tout effacer » est asynchrone, et un échec
            // d'écriture refermait la fenêtre en laissant croire que c'était
            // fait. Le rejet est maintenant dit, et la fenêtre se referme
            // quand même — l'action a eu lieu ou pas, mais la fenêtre n'a
            // plus rien à montrer.
            b.addEventListener('click', () => {
                try {
                    Promise.resolve(a.onClick && a.onClick()).catch(e =>
                        toast('Opération impossible : ' + (e && e.message || e), 'error', 10000));
                } catch (e) {
                    toast('Opération impossible : ' + (e && e.message || e), 'error', 10000);
                }
                if (a.close !== false) closeModal();
            });
            foot.appendChild(b);
        });
        $('#modal-overlay').hidden = false;
        return $('#modal-body');
    }
    function closeModal() { $('#modal-overlay').hidden = true; }

    // ──────────────────────────────────────────────
    //  Tables
    // ──────────────────────────────────────────────

    /**
     * Construit une table HTML.
     * @param {Array} cols  [{ key, label, align, format(v,row), cls, width, sortable }]
     * @param {Array} rows
     * @param {Object} opts { tri:{key,sens}, onSort, onRowClick, rowClass, vide, total }
     */
    function table(cols, rows, opts) {
        const o = opts || {};
        let h = '<table class="data-table"><thead><tr>';
        for (const c of cols) {
            const sortable = c.sortable !== false && o.onSort;
            const actif = o.tri && o.tri.key === c.key;
            const fleche = actif ? (o.tri.sens === 'asc' ? ' ▲' : ' ▼') : '';
            h += `<th class="${c.align === 'right' ? 'ta-r' : c.align === 'center' ? 'ta-c' : ''}${sortable ? ' sortable' : ''}${actif ? ' sorted' : ''}"`
               + (sortable ? ` data-sort="${escapeHtml(c.key)}"` : '')
               + (c.width ? ` style="width:${c.width}"` : '')
               + (c.title ? ` title="${escapeHtml(c.title)}"` : '')
               + `>${escapeHtml(c.label)}${fleche}</th>`;
        }
        h += '</tr></thead><tbody>';

        if (!rows.length) {
            h += `<tr><td colspan="${cols.length}" class="table-empty">${escapeHtml(o.vide || 'Aucune donnée pour ces filtres.')}</td></tr>`;
        } else {
            rows.forEach((row, i) => {
                const rc = o.rowClass ? o.rowClass(row, i) : '';
                h += `<tr class="${rc}"${o.onRowClick ? ` data-row="${i}"` : ''}>`;
                for (const c of cols) {
                    const raw = typeof c.key === 'function' ? c.key(row) : row[c.key];
                    const val = c.format ? c.format(raw, row) : escapeHtml(raw == null ? '—' : raw);
                    const cls = [c.align === 'right' ? 'ta-r' : c.align === 'center' ? 'ta-c' : '',
                                 typeof c.cls === 'function' ? c.cls(raw, row) : (c.cls || '')].filter(Boolean).join(' ');
                    h += `<td class="${cls}">${val}</td>`;
                }
                h += '</tr>';
            });
        }
        h += '</tbody>';
        if (o.total) {
            h += '<tfoot><tr>';
            for (const c of cols) {
                const v = o.total[c.key];
                h += `<td class="${c.align === 'right' ? 'ta-r' : ''}">${v == null ? '' : v}</td>`;
            }
            h += '</tr></tfoot>';
        }
        h += '</table>';
        return h;
    }

    /** Branche le tri et le clic-ligne sur une table déjà injectée. */
    function bindTable(container, rows, opts) {
        const o = opts || {};
        if (o.onSort) {
            $$('th.sortable', container).forEach(th => {
                th.addEventListener('click', () => o.onSort(th.dataset.sort));
            });
        }
        if (o.onRowClick) {
            $$('tbody tr[data-row]', container).forEach(tr => {
                tr.classList.add('row-clickable');
                tr.addEventListener('click', (ev) => o.onRowClick(rows[+tr.dataset.row], ev));
            });
        }
    }

    /** Petite barre horizontale de proportion, utilisée dans les tables. */
    function barre(valeur, max, couleur) {
        const p = max > 0 ? Math.max(0, Math.min(100, (valeur / max) * 100)) : 0;
        return `<span class="bar-cell"><span class="bar-fill" style="width:${p.toFixed(1)}%;background:${couleur || 'var(--accent)'}"></span></span>`;
    }

    /** Pastille colorée selon le niveau de retard. */
    function pastilleRetard(j) {
        if (j == null) return '<span class="pill pill-muted">—</span>';
        let cls = 'pill-ok';
        if (j > 180) cls = 'pill-danger';
        else if (j > 60) cls = 'pill-warn';
        else if (j > 0) cls = 'pill-soft';
        return `<span class="pill ${cls}">${j > 0 ? '+' : ''}${nombre(j)} j</span>`;
    }

    // ──────────────────────────────────────────────
    //  Graphiques (Chart.js)
    // ──────────────────────────────────────────────

    const couleurs = {
        retard: '#B8352A',
        payeRetard: '#A86A06',
        paye: '#1D7F55',
        nonEchue: '#2B5DB8',
        inconnu: '#6b7280',
        accent: '#D9532E',
        indigo: '#2B5DB8',
    };

    // LA PALETTE DE LA CHARTE LIORA, VALIDÉE ET NON RECOPIÉE, 12/11/2026.
    //
    // « tu peux mettre le code couleur liora sur mon appli suivi recouv ? »
    //
    // Les quatorze teintes d'avant étaient celles d'un thème sombre, et elles
    // n'avaient jamais été contrôlées. Sur fond clair, deux d'entre elles se
    // lisaient comme du gris et une troisième n'atteignait pas trois contre un
    // de contraste. Celles de la version 2 échouent aussi : son turquoise
    // #178A82 tombe sous le seuil de chroma, son or #D4970F plafonne à 2,48.
    //
    // Ces dix-là passent les cinq contrôles sur la surface claire : bande de
    // luminosité, chroma, séparation en vision déficiente, séparation en
    // vision normale, contraste. Les six premières SONT celles de la charte,
    // à l'or et au turquoise près, recalés pour passer. L'ordre est fixe : une
    // série garde sa couleur quand un filtre en retire une autre.
    //
    // Aucune ne reprend une couleur d'état — le vert, le rouge et l'ambre sont
    // réservés à ce qui va bien, mal ou presque mal, et ne désignent jamais un
    // financeur.
    const palette = ['#A8750B', '#2B5DB8', '#D9532E', '#0A8F82', '#7B4DB3',
        '#8E2A21', '#A33C86', '#4E7A1F', '#0E6F9E', '#C2410C'];

    function initChartDefaults() {
        if (!global.Chart) return;
        Chart.defaults.color = '#5C5750';
        Chart.defaults.font.family = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";
        Chart.defaults.font.size = 11;
        Chart.defaults.plugins.legend.labels.usePointStyle = true;
        Chart.defaults.plugins.legend.labels.boxWidth = 8;
        Chart.defaults.plugins.legend.labels.padding = 14;
        Chart.defaults.plugins.tooltip.backgroundColor = 'rgba(11, 14, 26, 0.95)';
        Chart.defaults.plugins.tooltip.borderColor = 'rgba(99, 102, 241, 0.25)';
        Chart.defaults.plugins.tooltip.borderWidth = 1;
        Chart.defaults.plugins.tooltip.padding = 10;
        Chart.defaults.plugins.tooltip.cornerRadius = 8;
        Chart.defaults.maintainAspectRatio = false;
    }

    const registre = {};
    /** Crée ou remplace un graphique sur un canvas donné. */
    function chart(canvasId, config) {
        const el = document.getElementById(canvasId);
        if (!el || !global.Chart) return null;
        if (registre[canvasId]) { registre[canvasId].destroy(); delete registre[canvasId]; }
        registre[canvasId] = new Chart(el.getContext('2d'), config);
        return registre[canvasId];
    }
    function destroyCharts() {
        Object.keys(registre).forEach(k => { registre[k].destroy(); delete registre[k]; });
    }

    const grille = { color: 'rgba(30, 28, 26, 0.07)' };

    global.LioraUI = {
        $, $$, euros, eurosCourt, nombre, pourcent, jours, dateFR, moisLabel, escapeHtml,
        etatClass, toast, modal, closeModal, table, bindTable, barre, pastilleRetard,
        couleurs, palette, initChartDefaults, chart, destroyCharts, grille,
    };
})(window);
