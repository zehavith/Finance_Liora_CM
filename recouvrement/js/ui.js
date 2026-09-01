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

    function modal(title, bodyHtml, actions) {
        $('#modal-title').textContent = title;
        $('#modal-body').innerHTML = bodyHtml;
        const foot = $('#modal-foot');
        foot.innerHTML = '';
        (actions || []).forEach(a => {
            const b = document.createElement('button');
            b.className = 'btn ' + (a.primary ? 'btn-primary' : 'btn-ghost');
            b.textContent = a.label;
            b.addEventListener('click', () => { if (a.onClick) a.onClick(); if (a.close !== false) closeModal(); });
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
        retard: '#ef4444',
        payeRetard: '#f59e0b',
        paye: '#84cc16',
        nonEchue: '#3b82f6',
        inconnu: '#6b7280',
        accent: '#F47458',
        indigo: '#6366f1',
    };

    const palette = ['#F47458', '#6366f1', '#84cc16', '#f59e0b', '#3b82f6', '#ec4899',
        '#14b8a6', '#8b5cf6', '#f97316', '#06b6d4', '#eab308', '#f43f5e', '#10b981', '#d946ef'];

    function initChartDefaults() {
        if (!global.Chart) return;
        Chart.defaults.color = '#8b92a5';
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

    const grille = { color: 'rgba(99, 102, 241, 0.08)' };

    global.LioraUI = {
        $, $$, euros, eurosCourt, nombre, pourcent, jours, dateFR, moisLabel, escapeHtml,
        etatClass, toast, modal, closeModal, table, bindTable, barre, pastilleRetard,
        couleurs, palette, initChartDefaults, chart, destroyCharts, grille,
    };
})(window);
