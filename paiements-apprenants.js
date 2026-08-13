/* ==========================================================
   Liora — Paiements Apprenants
   Recherche du compte d'un apprenant (nom / n° de compte /
   n° de facture) à partir d'un export Pennylane.
   Version 1.0.0
   ========================================================== */

(function () {
    'use strict';

    const $ = (sel, root) => (root || document).querySelector(sel);
    const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

    const IDB_NAME = 'liora_paiements';
    const IDB_VERSION = 1;
    const IDB_STORE = 'imports';
    const IDB_KEY = 'current';

    // Application state
    const state = {
        headers: [],
        rows: [],
        colMap: {},
        invertSign: false,
        fileName: '',
        importedAt: null,
        accounts: [],
        currentAccount: null,
        highlightPiece: null,
    };

    // ══════════════════════════════════════════════
    //  UTILITIES
    // ══════════════════════════════════════════════

    /** Lowercase, accent-free, punctuation-free form used for all matching. */
    function norm(value) {
        return String(value == null ? '' : value)
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, ' ')
            .trim();
    }

    /** Same as norm() but keeps no spaces — used for account / invoice numbers. */
    function normId(value) {
        return norm(value).replace(/\s+/g, '');
    }

    /** Parses "1 234,56", "1,234.56", "(1 234,56)", "1 234,56 €" → Number. */
    function parseNumber(value) {
        if (typeof value === 'number') return isFinite(value) ? value : 0;
        let str = String(value == null ? '' : value).trim();
        if (!str) return 0;

        let negative = false;
        if (/^\(.*\)$/.test(str)) { negative = true; str = str.slice(1, -1); }

        str = str.replace(/[\s\u00a0\u202f]/g, '').replace(/[€$£]/g, '');
        if (/-\s*$/.test(str)) { negative = true; str = str.replace(/-\s*$/, ''); }
        if (/^-/.test(str)) { negative = true; str = str.slice(1); }
        if (!/[0-9]/.test(str)) return 0;

        const lastComma = str.lastIndexOf(',');
        const lastDot = str.lastIndexOf('.');
        if (lastComma > -1 && lastDot > -1) {
            // The right-most separator is the decimal one
            if (lastComma > lastDot) str = str.replace(/\./g, '').replace(',', '.');
            else str = str.replace(/,/g, '');
        } else if (lastComma > -1) {
            // A comma with 3 trailing digits and other groups is a thousands separator
            str = /^\d{1,3}(,\d{3})+$/.test(str) ? str.replace(/,/g, '') : str.replace(',', '.');
        }

        const out = parseFloat(str.replace(/[^0-9.]/g, ''));
        if (!isFinite(out)) return 0;
        return negative ? -out : out;
    }

    /** Accepts Date, Excel serial number, dd/mm/yyyy, yyyy-mm-dd, dd-mm-yy… */
    function parseDate(value) {
        if (value instanceof Date && !isNaN(value)) return value;
        if (typeof value === 'number' && isFinite(value) && value > 20000 && value < 60000) {
            // Excel serial (1900 date system)
            return new Date(Math.round((value - 25569) * 86400 * 1000));
        }
        const str = String(value == null ? '' : value).trim();
        if (!str) return null;

        let m = str.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/);
        if (m) {
            let year = parseInt(m[3], 10);
            if (year < 100) year += year < 50 ? 2000 : 1900;
            const d = new Date(year, parseInt(m[2], 10) - 1, parseInt(m[1], 10));
            return isNaN(d) ? null : d;
        }
        m = str.match(/^(\d{4})[\/.\-](\d{1,2})[\/.\-](\d{1,2})/);
        if (m) {
            const d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
            return isNaN(d) ? null : d;
        }
        const fallback = new Date(str);
        return isNaN(fallback) ? null : fallback;
    }

    function formatDate(date) {
        if (!date) return '—';
        return date.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
    }

    function formatMoney(amount) {
        return (amount || 0).toLocaleString('fr-FR', {
            style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2,
        });
    }

    function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

    function daysBetween(from, to) {
        return Math.floor((to - from) / 86400000);
    }

    function escapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function startOfToday() {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        return d;
    }

    // ══════════════════════════════════════════════
    //  PERSISTENCE (IndexedDB)
    // ══════════════════════════════════════════════

    function openDB() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(IDB_NAME, IDB_VERSION);
            req.onupgradeneeded = () => {
                if (!req.result.objectStoreNames.contains(IDB_STORE)) req.result.createObjectStore(IDB_STORE);
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    async function saveImport() {
        try {
            const db = await openDB();
            const tx = db.transaction(IDB_STORE, 'readwrite');
            tx.objectStore(IDB_STORE).put({
                headers: state.headers,
                rows: state.rows,
                colMap: state.colMap,
                invertSign: state.invertSign,
                fileName: state.fileName,
                importedAt: state.importedAt,
            }, IDB_KEY);
            await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
        } catch (err) {
            console.warn('Sauvegarde impossible :', err);
        }
    }

    async function loadImport() {
        try {
            const db = await openDB();
            const tx = db.transaction(IDB_STORE, 'readonly');
            const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
            return await new Promise((res, rej) => {
                req.onsuccess = () => res(req.result || null);
                req.onerror = () => rej(req.error);
            });
        } catch {
            return null;
        }
    }

    async function purgeImport() {
        try {
            const db = await openDB();
            const tx = db.transaction(IDB_STORE, 'readwrite');
            tx.objectStore(IDB_STORE).delete(IDB_KEY);
            await new Promise((res) => { tx.oncomplete = res; });
        } catch (err) {
            console.warn('Purge impossible :', err);
        }
    }

    // ══════════════════════════════════════════════
    //  COLUMN DETECTION
    // ══════════════════════════════════════════════

    // Order matters: the most specific fields claim their header first
    // (« date d'échéance » must not be swallowed by « date »).
    const FIELD_DEFS = [
        { key: 'echeance', label: 'Date d\'échéance', hints: ['date echeance', 'echeance', 'date de echeance', 'date d echeance', 'due date'] },
        { key: 'compte', label: 'N° de compte (411)', hints: ['numero de compte auxiliaire', 'compte auxiliaire', 'numero de compte', 'n compte', 'code auxiliaire', 'auxiliaire', 'compte client', 'compte', 'numero client', 'code client'] },
        { key: 'nom', label: 'Nom / intitulé du compte', hints: ['libelle du compte', 'intitule du compte', 'nom du compte', 'nom du client', 'nom de l apprenant', 'apprenant', 'stagiaire', 'raison sociale', 'client', 'tiers', 'nom', 'libelle compte'] },
        { key: 'prenom', label: 'Prénom (si séparé)', hints: ['prenom', 'first name'] },
        { key: 'piece', label: 'N° de facture / pièce', hints: ['numero de facture', 'n facture', 'numero facture', 'numero de piece', 'n piece', 'numero de document', 'reference facture', 'facture', 'piece', 'reference', 'invoice number'] },
        { key: 'date', label: 'Date', hints: ['date de facture', 'date facture', 'date d ecriture', 'date ecriture', 'date de la piece', 'date piece', 'date operation', 'date'] },
        { key: 'libelle', label: 'Libellé', hints: ['libelle ecriture', 'libelle de l ecriture', 'libelle', 'designation', 'description', 'objet', 'intitule'] },
        { key: 'debit', label: 'Débit', hints: ['debit', 'montant debit', 'total debit'] },
        { key: 'credit', label: 'Crédit', hints: ['credit', 'montant credit', 'total credit', 'montant regle', 'montant paye'] },
        { key: 'montant', label: 'Montant (si pas de débit/crédit)', hints: ['montant ttc', 'montant total', 'montant', 'total ttc', 'amount'] },
        { key: 'lettrage', label: 'Lettrage / rapprochement', hints: ['code lettrage', 'lettrage', 'lettre', 'rapprochement', 'matching'] },
        { key: 'journal', label: 'Journal', hints: ['code journal', 'journal'] },
        { key: 'statut', label: 'Statut', hints: ['statut', 'status', 'etat'] },
    ];

    function detectColumns(headers) {
        const normalized = headers.map((h) => norm(h));
        const used = new Set();
        const map = {};

        // Pass 1 — exact match, then pass 2 — substring match
        [true, false].forEach((exact) => {
            FIELD_DEFS.forEach((field) => {
                if (map[field.key]) return;
                for (const hint of field.hints) {
                    const idx = normalized.findIndex((h, i) => {
                        if (used.has(i) || !h) return false;
                        return exact ? h === hint : h.includes(hint);
                    });
                    if (idx > -1) { map[field.key] = headers[idx]; used.add(idx); return; }
                }
            });
        });
        return map;
    }

    // ══════════════════════════════════════════════
    //  FILE READING
    // ══════════════════════════════════════════════

    const HEADER_KEYWORDS = ['compte', 'debit', 'credit', 'montant', 'date', 'libelle', 'facture',
        'piece', 'client', 'nom', 'tiers', 'journal', 'echeance', 'reference', 'lettrage'];

    /** Finds the real header row (Pennylane exports often start with title lines). */
    function findHeaderRow(matrix) {
        const limit = Math.min(matrix.length, 25);
        let best = -1, bestScore = 0;
        for (let i = 0; i < limit; i++) {
            const cells = (matrix[i] || []).map((c) => norm(c)).filter(Boolean);
            if (cells.length < 2) continue;
            const score = cells.filter((c) => HEADER_KEYWORDS.some((k) => c.includes(k))).length;
            if (score > bestScore) { bestScore = score; best = i; }
            if (bestScore >= 4) break;
        }
        if (best > -1 && bestScore >= 2) return best;
        return matrix.findIndex((r) => (r || []).filter((c) => String(c).trim()).length >= 2);
    }

    /** Turns a raw matrix into { headers, rows } objects. */
    function matrixToRecords(matrix) {
        const headerIdx = findHeaderRow(matrix);
        if (headerIdx < 0) return { headers: [], rows: [] };

        const seen = new Map();
        const headers = (matrix[headerIdx] || []).map((cell, i) => {
            let name = String(cell == null ? '' : cell).trim() || `Colonne ${i + 1}`;
            if (seen.has(name)) {
                const count = seen.get(name) + 1;
                seen.set(name, count);
                name = `${name} (${count})`;
            } else seen.set(name, 1);
            return name;
        });

        const rows = [];
        for (let i = headerIdx + 1; i < matrix.length; i++) {
            const raw = matrix[i] || [];
            if (!raw.some((c) => String(c == null ? '' : c).trim())) continue;
            const obj = {};
            headers.forEach((h, j) => { obj[h] = raw[j] == null ? '' : raw[j]; });
            rows.push(obj);
        }
        return { headers, rows };
    }

    function readCsv(file) {
        return new Promise((resolve, reject) => {
            const decode = (encoding) => new Promise((res, rej) => {
                const reader = new FileReader();
                reader.onload = (e) => res(e.target.result);
                reader.onerror = () => rej(reader.error);
                reader.readAsText(file, encoding);
            });

            decode('UTF-8')
                .then((text) => (text.includes('\ufffd') ? decode('windows-1252') : text))
                .then((text) => {
                    const parsed = Papa.parse(text, { header: false, skipEmptyLines: 'greedy' });
                    resolve(matrixToRecords(parsed.data));
                })
                .catch(reject);
        });
    }

    function readExcel(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                try {
                    const wb = XLSX.read(e.target.result, { type: 'array', cellDates: true });
                    const sheet = wb.Sheets[wb.SheetNames[0]];
                    const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: false });
                    resolve(matrixToRecords(matrix));
                } catch (err) { reject(err); }
            };
            reader.onerror = () => reject(reader.error);
            reader.readAsArrayBuffer(file);
        });
    }

    async function handleFile(file) {
        const ext = (file.name.split('.').pop() || '').toLowerCase();
        if (!['csv', 'xlsx', 'xls'].includes(ext)) {
            showImportStatus('Format non supporté. Importez un fichier .csv, .xlsx ou .xls.', 'error');
            return;
        }
        showImportStatus('Lecture du fichier…', 'info');

        try {
            const { headers, rows } = ext === 'csv' ? await readCsv(file) : await readExcel(file);
            if (!rows.length) {
                showImportStatus('Aucune ligne exploitable détectée dans ce fichier.', 'error');
                return;
            }

            state.headers = headers;
            state.rows = rows;
            state.colMap = detectColumns(headers);
            state.invertSign = false;
            state.fileName = file.name;
            state.importedAt = new Date().toISOString();

            const problem = validateMapping();
            if (problem) {
                showImportStatus(problem + ' Ajustez les colonnes dans l\'écran suivant.', 'warn');
            }

            buildAccounts();
            await saveImport();
            enterApp();
        } catch (err) {
            console.error(err);
            showImportStatus('Erreur lors de la lecture du fichier.', 'error');
        }
    }

    function validateMapping() {
        const m = state.colMap;
        if (!m.debit && !m.credit && !m.montant) return 'Aucune colonne de montant reconnue.';
        if (!m.compte && !m.nom) return 'Ni le n° de compte ni le nom du client n\'ont été reconnus.';
        return null;
    }

    // ══════════════════════════════════════════════
    //  AGGREGATION — ACCOUNTS, INVOICES, PAYMENTS
    // ══════════════════════════════════════════════

    function buildAccounts() {
        const m = state.colMap;
        const byKey = new Map();

        state.rows.forEach((row, index) => {
            const compteRaw = m.compte ? String(row[m.compte] || '').trim() : '';
            let nomRaw = m.nom ? String(row[m.nom] || '').trim() : '';
            if (m.prenom) {
                const prenom = String(row[m.prenom] || '').trim();
                if (prenom) nomRaw = nomRaw ? `${nomRaw} ${prenom}` : prenom;
            }

            const key = normId(compteRaw) || norm(nomRaw) || '_sans_compte';
            if (key === '_sans_compte' && !compteRaw && !nomRaw) return;

            let debit = 0, credit = 0;
            if (m.debit || m.credit) {
                debit = m.debit ? Math.abs(parseNumber(row[m.debit])) : 0;
                credit = m.credit ? Math.abs(parseNumber(row[m.credit])) : 0;
            } else if (m.montant) {
                const amount = parseNumber(row[m.montant]);
                if (amount >= 0) debit = amount; else credit = -amount;
            }
            if (state.invertSign) { const swap = debit; debit = credit; credit = swap; }
            if (!debit && !credit) return;

            const movement = {
                index,
                date: m.date ? parseDate(row[m.date]) : null,
                echeance: m.echeance ? parseDate(row[m.echeance]) : null,
                piece: m.piece ? String(row[m.piece] || '').trim() : '',
                libelle: m.libelle ? String(row[m.libelle] || '').trim() : '',
                lettrage: m.lettrage ? String(row[m.lettrage] || '').trim() : '',
                journal: m.journal ? String(row[m.journal] || '').trim() : '',
                statut: m.statut ? String(row[m.statut] || '').trim() : '',
                debit: round2(debit),
                credit: round2(credit),
            };

            if (!byKey.has(key)) {
                byKey.set(key, { key, compte: compteRaw, nom: nomRaw, movements: [] });
            }
            const account = byKey.get(key);
            if (!account.compte && compteRaw) account.compte = compteRaw;
            if (!account.nom && nomRaw) account.nom = nomRaw;
            account.movements.push(movement);
        });

        state.accounts = Array.from(byKey.values()).map(finaliseAccount)
            .sort((a, b) => b.solde - a.solde || a.label.localeCompare(b.label, 'fr'));
    }

    function finaliseAccount(account) {
        account.movements.sort((a, b) => (a.date ? a.date.getTime() : 0) - (b.date ? b.date.getTime() : 0));

        const factures = account.movements.filter((mv) => mv.debit > 0)
            .map((mv) => ({ ...mv, montant: mv.debit, paye: 0 }));
        const reglements = account.movements.filter((mv) => mv.credit > 0)
            .map((mv) => ({ ...mv, montant: mv.credit }));

        allocatePayments(factures, reglements);

        const today = startOfToday();
        factures.forEach((f) => {
            f.reste = round2(f.montant - f.paye);
            if (f.reste <= 0.01) f.statut2 = 'payee';
            else if (f.paye > 0.01) f.statut2 = 'partielle';
            else f.statut2 = 'impayee';
            f.retard = f.echeance && f.reste > 0.01 && f.echeance < today ? daysBetween(f.echeance, today) : 0;
        });

        account.factures = factures;
        account.reglements = reglements;
        account.totalFacture = round2(factures.reduce((s, f) => s + f.montant, 0));
        account.totalRegle = round2(reglements.reduce((s, r) => s + r.montant, 0));
        account.solde = round2(account.totalFacture - account.totalRegle);
        account.impayeEchu = round2(factures.reduce((s, f) => s + (f.retard > 0 ? f.reste : 0), 0));
        account.nbImpayees = factures.filter((f) => f.reste > 0.01).length;
        account.label = account.nom || account.compte || '(sans nom)';

        account.searchName = norm(account.label);
        account.searchTokens = account.searchName.split(' ').filter(Boolean);
        account.searchCompte = normId(account.compte);
        account.searchPieces = new Set(
            account.movements.map((mv) => normId(mv.piece)).filter(Boolean)
        );
        return account;
    }

    /**
     * Assigns payments to invoices: first within a shared lettrage code,
     * then oldest-invoice-first for whatever is left.
     */
    function allocatePayments(factures, reglements) {
        const consume = (facs, pool) => {
            for (const f of facs) {
                if (pool <= 0.01) break;
                const need = round2(f.montant - f.paye);
                if (need <= 0.01) continue;
                const take = Math.min(need, pool);
                f.paye = round2(f.paye + take);
                pool = round2(pool - take);
            }
            return pool;
        };

        const usedReglements = new Set();
        const groups = new Map();
        reglements.forEach((r) => {
            const code = normId(r.lettrage);
            if (!code) return;
            if (!groups.has(code)) groups.set(code, { factures: [], reglements: [] });
            groups.get(code).reglements.push(r);
        });
        factures.forEach((f) => {
            const code = normId(f.lettrage);
            if (code && groups.has(code)) groups.get(code).factures.push(f);
        });

        groups.forEach((group) => {
            if (!group.factures.length) return;
            const pool = group.reglements.reduce((s, r) => s + r.montant, 0);
            group.reglements.forEach((r) => usedReglements.add(r));
            consume(group.factures, round2(pool));
        });

        const rest = reglements.filter((r) => !usedReglements.has(r))
            .reduce((s, r) => s + r.montant, 0);
        consume(factures, round2(rest));
    }

    // ══════════════════════════════════════════════
    //  SEARCH
    // ══════════════════════════════════════════════

    function search(query) {
        const q = norm(query);
        if (!q) return [];
        const qId = normId(query);
        const tokens = q.split(' ').filter(Boolean);
        const results = [];

        state.accounts.forEach((account) => {
            let score = 0;
            let piece = null;

            if (qId && account.searchCompte) {
                if (account.searchCompte === qId) score = Math.max(score, 100);
                else if (account.searchCompte.includes(qId) && qId.length >= 3) score = Math.max(score, 70);
            }

            if (qId && qId.length >= 3) {
                for (const p of account.searchPieces) {
                    if (p === qId) { score = Math.max(score, 95); piece = p; break; }
                    if (p.includes(qId)) { score = Math.max(score, 65); piece = p; }
                }
            }

            // Every typed token must prefix one of the name tokens — so
            // « dupont jean » and « jean dupont » both match.
            const allMatch = tokens.every((t) => account.searchTokens.some((nt) => nt.startsWith(t)));
            if (allMatch) {
                score = Math.max(score, account.searchName.startsWith(q) ? 90 : 80);
            } else if (account.searchName.includes(q) && q.length >= 3) {
                score = Math.max(score, 60);
            }

            if (score > 0) results.push({ account, score, piece });
        });

        return results
            .sort((a, b) => b.score - a.score || Math.abs(b.account.solde) - Math.abs(a.account.solde))
            .slice(0, 50);
    }

    // ══════════════════════════════════════════════
    //  RENDERING
    // ══════════════════════════════════════════════

    function showScreen(name) {
        $('#screen-import').classList.toggle('active', name === 'import');
        $('#screen-app').classList.toggle('active', name === 'app');
    }

    function showImportStatus(message, kind) {
        const box = $('#import-status');
        box.textContent = message;
        box.className = `import-status ${kind || 'info'}`;
    }

    function enterApp() {
        showScreen('app');
        renderMappingPanel();
        updateSearchMeta();
        $('#search-input').value = '';
        $('#search-input').focus();
        renderResults([]);
        $('#fiche').classList.add('hidden');
    }

    function updateSearchMeta() {
        const accounts = state.accounts.length;
        const solde = round2(state.accounts.reduce((s, a) => s + a.solde, 0));
        $('#search-meta').innerHTML =
            `<span>${accounts} compte${accounts > 1 ? 's' : ''} · ${state.rows.length} lignes</span>` +
            `<span class="dot">•</span><span>Solde total ${escapeHtml(formatMoney(solde))}</span>` +
            `<span class="dot">•</span><span title="${escapeHtml(state.fileName)}">${escapeHtml(state.fileName)}</span>`;
    }

    function renderResults(results) {
        const box = $('#results');
        if (!results.length) {
            box.innerHTML = '';
            box.classList.add('hidden');
            return;
        }
        box.classList.remove('hidden');
        box.innerHTML = `
            <div class="results-head">${results.length} résultat${results.length > 1 ? 's' : ''}</div>
            <div class="results-list">
                ${results.map((r, i) => `
                    <button class="result-card" data-idx="${i}">
                        <div class="result-main">
                            <div class="result-name">${escapeHtml(r.account.label)}</div>
                            <div class="result-sub">
                                ${r.account.compte ? escapeHtml(r.account.compte) + ' · ' : ''}
                                ${r.account.factures.length} facture${r.account.factures.length > 1 ? 's' : ''}
                                ${r.account.nbImpayees ? ` · <span class="txt-warn">${r.account.nbImpayees} en attente</span>` : ''}
                            </div>
                        </div>
                        <div class="result-amount ${r.account.solde > 0.01 ? 'txt-red' : 'txt-green'}">
                            ${escapeHtml(formatMoney(r.account.solde))}
                        </div>
                    </button>`).join('')}
            </div>`;

        $$('.result-card', box).forEach((card) => {
            card.addEventListener('click', () => {
                const r = results[parseInt(card.dataset.idx, 10)];
                openAccount(r.account, r.piece);
            });
        });
    }

    function openAccount(account, highlightPiece) {
        state.currentAccount = account;
        state.highlightPiece = highlightPiece || null;
        renderFiche();
        $('#fiche').classList.remove('hidden');
        $('#fiche').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    const STATUT_LABEL = { payee: 'Payée', partielle: 'Partielle', impayee: 'Impayée' };

    function renderFiche() {
        const a = state.currentAccount;
        if (!a) return;

        const kpis = [
            { label: 'Total facturé', value: formatMoney(a.totalFacture), cls: '' },
            { label: 'Total réglé', value: formatMoney(a.totalRegle), cls: 'txt-green' },
            { label: 'Solde dû', value: formatMoney(a.solde), cls: a.solde > 0.01 ? 'txt-red' : 'txt-green' },
            { label: 'Impayé échu', value: formatMoney(a.impayeEchu), cls: a.impayeEchu > 0.01 ? 'txt-warn' : '' },
        ];

        $('#fiche').innerHTML = `
            <div class="print-header print-only">
                <img src="Liora_Logo_Orange_alpha.png" alt="Liora" class="print-logo">
                <div class="print-header-title">Relevé de compte client</div>
            </div>

            <div class="fiche-head">
                <div>
                    <div class="fiche-eyebrow">Compte client</div>
                    <h2 class="fiche-name">${escapeHtml(a.label)}</h2>
                    <div class="fiche-sub">
                        ${a.compte ? `N° de compte <strong>${escapeHtml(a.compte)}</strong> · ` : ''}
                        ${a.movements.length} écriture${a.movements.length > 1 ? 's' : ''}
                        · Édité le ${escapeHtml(formatDate(new Date()))}
                    </div>
                </div>
                <div class="fiche-actions no-print">
                    <button class="btn btn-ghost" id="btn-export-csv">Exporter CSV</button>
                    <button class="btn btn-primary" id="btn-export-pdf">Exporter PDF</button>
                </div>
            </div>

            <div class="kpi-row">
                ${kpis.map((k) => `
                    <div class="kpi-card">
                        <div class="kpi-label">${k.label}</div>
                        <div class="kpi-value ${k.cls}">${escapeHtml(k.value)}</div>
                    </div>`).join('')}
            </div>

            <div class="block">
                <div class="block-title">Factures (${a.factures.length})</div>
                ${a.factures.length ? `
                <div class="table-wrap">
                    <table class="data-table">
                        <thead><tr>
                            <th>Date</th><th>N° de facture</th><th>Libellé</th><th>Échéance</th>
                            <th class="num">Montant</th><th class="num">Réglé</th><th class="num">Reste</th><th>Statut</th>
                        </tr></thead>
                        <tbody>
                            ${a.factures.map((f) => {
                                const hit = state.highlightPiece && normId(f.piece) === state.highlightPiece;
                                return `<tr class="${hit ? 'row-hit' : ''}">
                                    <td>${escapeHtml(formatDate(f.date))}</td>
                                    <td class="mono">${escapeHtml(f.piece || '—')}</td>
                                    <td class="ellipsis" title="${escapeHtml(f.libelle)}">${escapeHtml(f.libelle || '—')}</td>
                                    <td>${escapeHtml(formatDate(f.echeance))}</td>
                                    <td class="num">${escapeHtml(formatMoney(f.montant))}</td>
                                    <td class="num txt-green">${escapeHtml(formatMoney(f.paye))}</td>
                                    <td class="num ${f.reste > 0.01 ? 'txt-red' : ''}">${escapeHtml(formatMoney(f.reste))}</td>
                                    <td>
                                        <span class="badge badge-${f.statut2}">${STATUT_LABEL[f.statut2]}</span>
                                        ${f.retard > 0 ? `<span class="badge badge-retard">+${f.retard} j</span>` : ''}
                                    </td>
                                </tr>`;
                            }).join('')}
                        </tbody>
                    </table>
                </div>` : '<div class="empty">Aucune facture sur ce compte.</div>'}
            </div>

            <div class="block">
                <div class="block-title">Règlements (${a.reglements.length})</div>
                ${a.reglements.length ? `
                <div class="table-wrap">
                    <table class="data-table">
                        <thead><tr>
                            <th>Date</th><th>Référence</th><th>Libellé</th><th>Journal</th><th class="num">Montant</th>
                        </tr></thead>
                        <tbody>
                            ${a.reglements.map((r) => `
                                <tr>
                                    <td>${escapeHtml(formatDate(r.date))}</td>
                                    <td class="mono">${escapeHtml(r.piece || '—')}</td>
                                    <td class="ellipsis" title="${escapeHtml(r.libelle)}">${escapeHtml(r.libelle || '—')}</td>
                                    <td>${escapeHtml(r.journal || '—')}</td>
                                    <td class="num txt-green">${escapeHtml(formatMoney(r.montant))}</td>
                                </tr>`).join('')}
                        </tbody>
                    </table>
                </div>` : '<div class="empty">Aucun règlement enregistré.</div>'}
            </div>

            <details class="block block-details">
                <summary class="block-title">Grand livre du compte (${a.movements.length} écritures)</summary>
                <div class="table-wrap">
                    <table class="data-table">
                        <thead><tr>
                            <th>Date</th><th>Pièce</th><th>Libellé</th><th>Lettrage</th>
                            <th class="num">Débit</th><th class="num">Crédit</th><th class="num">Solde</th>
                        </tr></thead>
                        <tbody>${renderLedgerRows(a)}</tbody>
                    </table>
                </div>
            </details>

            <div class="fiche-foot">
                Solde = total facturé − total réglé. L'affectation des règlements suit le lettrage
                lorsqu'il est présent dans l'export, sinon les factures les plus anciennes sont soldées en premier.
            </div>`;

        $('#btn-export-csv').addEventListener('click', exportCsv);
        $('#btn-export-pdf').addEventListener('click', () => window.print());
    }

    function renderLedgerRows(account) {
        let running = 0;
        return account.movements.map((mv) => {
            running = round2(running + mv.debit - mv.credit);
            return `<tr>
                <td>${escapeHtml(formatDate(mv.date))}</td>
                <td class="mono">${escapeHtml(mv.piece || '—')}</td>
                <td class="ellipsis" title="${escapeHtml(mv.libelle)}">${escapeHtml(mv.libelle || '—')}</td>
                <td class="mono">${escapeHtml(mv.lettrage || '—')}</td>
                <td class="num">${mv.debit ? escapeHtml(formatMoney(mv.debit)) : ''}</td>
                <td class="num">${mv.credit ? escapeHtml(formatMoney(mv.credit)) : ''}</td>
                <td class="num">${escapeHtml(formatMoney(running))}</td>
            </tr>`;
        }).join('');
    }

    // ══════════════════════════════════════════════
    //  EXPORTS
    // ══════════════════════════════════════════════

    function exportCsv() {
        const a = state.currentAccount;
        if (!a) return;

        const csvCell = (value) => {
            const str = String(value == null ? '' : value);
            return /[";\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
        };
        const amount = (n) => String(round2(n)).replace('.', ',');

        const lines = [
            ['Compte', a.compte, 'Nom', a.label].map(csvCell).join(';'),
            ['Total facturé', amount(a.totalFacture), 'Total réglé', amount(a.totalRegle), 'Solde', amount(a.solde)].map(csvCell).join(';'),
            '',
            ['Type', 'Date', 'N° pièce', 'Libellé', 'Échéance', 'Débit', 'Crédit', 'Reste dû', 'Statut'].map(csvCell).join(';'),
        ];

        a.factures.forEach((f) => lines.push([
            'Facture', formatDate(f.date), f.piece, f.libelle, formatDate(f.echeance),
            amount(f.montant), '', amount(f.reste), STATUT_LABEL[f.statut2],
        ].map(csvCell).join(';')));

        a.reglements.forEach((r) => lines.push([
            'Règlement', formatDate(r.date), r.piece, r.libelle, '', '', amount(r.montant), '', '',
        ].map(csvCell).join(';')));

        // BOM so Excel opens the accented characters correctly
        const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `releve_${(a.compte || norm(a.label).replace(/ /g, '_')) || 'compte'}.csv`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    }

    // ══════════════════════════════════════════════
    //  MAPPING PANEL
    // ══════════════════════════════════════════════

    function renderMappingPanel() {
        const options = (selected) => ['<option value="">— non utilisée —</option>']
            .concat(state.headers.map((h) =>
                `<option value="${escapeHtml(h)}"${h === selected ? ' selected' : ''}>${escapeHtml(h)}</option>`))
            .join('');

        $('#mapping-grid').innerHTML = FIELD_DEFS.map((field) => `
            <label class="mapping-item">
                <span class="mapping-label">${field.label}</span>
                <select data-field="${field.key}">${options(state.colMap[field.key])}</select>
            </label>`).join('') + `
            <label class="mapping-item mapping-toggle">
                <span class="mapping-label">Inverser débit / crédit</span>
                <input type="checkbox" id="invert-sign" ${state.invertSign ? 'checked' : ''}>
            </label>`;
    }

    async function applyMapping() {
        const map = {};
        $$('#mapping-grid select').forEach((sel) => {
            if (sel.value) map[sel.dataset.field] = sel.value;
        });
        state.colMap = map;
        state.invertSign = $('#invert-sign').checked;

        buildAccounts();
        await saveImport();

        updateSearchMeta();
        $('#mapping-panel').classList.add('hidden');
        state.currentAccount = null;
        $('#fiche').classList.add('hidden');
        runSearch($('#search-input').value);
    }

    // ══════════════════════════════════════════════
    //  EVENTS
    // ══════════════════════════════════════════════

    function runSearch(query) {
        const trimmed = query.trim();
        $('#search-clear').classList.toggle('hidden', !trimmed);
        if (!trimmed) {
            renderResults([]);
            $('#fiche').classList.add('hidden');
            return;
        }
        const results = search(trimmed);
        if (!results.length) {
            $('#results').classList.remove('hidden');
            $('#results').innerHTML = `<div class="empty">Aucun compte ne correspond à « ${escapeHtml(trimmed)} ».</div>`;
            $('#fiche').classList.add('hidden');
            return;
        }
        if (results.length === 1) {
            // Un seul compte : on ouvre directement la fiche, sans carte intermédiaire
            renderResults([]);
            openAccount(results[0].account, results[0].piece);
        } else {
            renderResults(results);
            $('#fiche').classList.add('hidden');
        }
    }

    function bindEvents() {
        const zone = $('#upload-zone');
        const input = $('#file-input');

        zone.addEventListener('click', () => input.click());
        zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('dragover'); });
        zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
        zone.addEventListener('drop', (e) => {
            e.preventDefault();
            zone.classList.remove('dragover');
            if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
        });
        input.addEventListener('change', () => {
            if (input.files.length) handleFile(input.files[0]);
        });

        let debounce;
        $('#search-input').addEventListener('input', (e) => {
            const value = e.target.value;
            clearTimeout(debounce);
            debounce = setTimeout(() => runSearch(value), 120);
        });
        $('#search-clear').addEventListener('click', () => {
            $('#search-input').value = '';
            runSearch('');
            $('#search-input').focus();
        });

        $('#nav-home').addEventListener('click', () => {
            $('#fiche').classList.add('hidden');
            $('#search-input').focus();
        });
        $('#btn-new-file').addEventListener('click', () => {
            showScreen('import');
            showImportStatus('', 'info');
            $('#import-status').classList.add('hidden');
        });
        $('#btn-mapping').addEventListener('click', () => {
            renderMappingPanel();
            $('#mapping-panel').classList.toggle('hidden');
        });
        $('#btn-mapping-close').addEventListener('click', () => $('#mapping-panel').classList.add('hidden'));
        $('#btn-mapping-apply').addEventListener('click', applyMapping);

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') $('#mapping-panel').classList.add('hidden');
            if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
                e.preventDefault();
                if ($('#screen-app').classList.contains('active')) $('#search-input').focus();
            }
        });
    }

    // ══════════════════════════════════════════════
    //  BOOT
    // ══════════════════════════════════════════════

    async function init() {
        bindEvents();

        const saved = await loadImport();
        if (saved && saved.rows && saved.rows.length) {
            const box = $('#restore-box');
            const when = saved.importedAt ? new Date(saved.importedAt) : null;
            $('#restore-sub').textContent =
                `${saved.fileName || 'Import'} — ${saved.rows.length} lignes` +
                (when ? ` — ${formatDate(when)}` : '');
            box.classList.remove('hidden');

            $('#btn-restore').addEventListener('click', () => {
                Object.assign(state, {
                    headers: saved.headers || [],
                    rows: saved.rows,
                    colMap: saved.colMap || {},
                    invertSign: !!saved.invertSign,
                    fileName: saved.fileName || '',
                    importedAt: saved.importedAt,
                });
                // Dates survive IndexedDB as Date objects, but a CSV import
                // stores plain strings — buildAccounts() re-parses either way.
                buildAccounts();
                enterApp();
            });
            $('#btn-purge').addEventListener('click', async () => {
                await purgeImport();
                box.classList.add('hidden');
            });
        }
    }

    init();
})();
