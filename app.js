/* ============================
   Liora Cash Flow Analyzer
   Main Application Logic
   v6.2.1h — Categorization Engine
   ============================ */

(function () {
    'use strict';

    // ── State ──
    let rawData = [];
    let filteredData = [];
    let currentPage = 1;
    const PAGE_SIZE = 25;
    let charts = {};

    // ── Persistence (IndexedDB — unlimited storage) ──
    const STORAGE_DATA_KEY = 'liora_cf_data';
    const STORAGE_FILES_KEY = 'liora_cf_files';
    const IDB_NAME = 'liora_cashflow';

    // Request persistent storage so the browser doesn't evict our data
    if (navigator.storage && navigator.storage.persist) {
        navigator.storage.persist().then(granted => {
            console.log('[Liora] Stockage persistant :', granted ? 'accordé' : 'refusé');
        });
    }
    const IDB_STORE = 'kv';
    const IDB_VERSION = 1;

    function openDB() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(IDB_NAME, IDB_VERSION);
            req.onupgradeneeded = () => { req.result.createObjectStore(IDB_STORE); };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    async function idbSet(key, value) {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            tx.objectStore(IDB_STORE).put(value, key);
            tx.oncomplete = () => { db.close(); resolve(true); };
            tx.onerror = () => { db.close(); reject(tx.error); };
        });
    }

    async function idbGet(key) {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readonly');
            const req = tx.objectStore(IDB_STORE).get(key);
            req.onsuccess = () => { db.close(); resolve(req.result); };
            req.onerror = () => { db.close(); reject(req.error); };
        });
    }

    async function idbDelete(key) {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            tx.objectStore(IDB_STORE).delete(key);
            tx.oncomplete = () => { db.close(); resolve(); };
            tx.onerror = () => { db.close(); reject(tx.error); };
        });
    }

    // ── Toast notification for save status ──
    function showSaveToast(message, isError) {
        let toast = document.getElementById('liora-save-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'liora-save-toast';
            document.body.appendChild(toast);
        }
        toast.textContent = message;
        toast.className = 'save-toast' + (isError ? ' save-toast-error' : ' save-toast-success');
        toast.classList.add('save-toast-visible');
        clearTimeout(toast._timer);
        toast._timer = setTimeout(() => toast.classList.remove('save-toast-visible'), 3000);
    }

    async function saveToStorage() {
        try {
            const serializable = rawData.map(r => {
                const { _libNorm, _tiersNorm, ...clean } = r;
                return {
                    ...clean,
                    date: r.date ? r.date.toISOString() : null,
                };
            });
            await idbSet(STORAGE_DATA_KEY, serializable);
            // Verify data was actually written
            const check = await idbGet(STORAGE_DATA_KEY);
            if (!check || check.length !== serializable.length) {
                console.error('[Liora] Verification failed: saved', serializable.length, 'but read back', check?.length || 0);
                showSaveToast('Erreur: données non sauvegardées correctement', true);
                return false;
            }
            console.log('[Liora] Données sauvegardées:', serializable.length, 'transactions');
            showSaveToast(serializable.length + ' transactions sauvegardées', false);
            return true;
        } catch (e) {
            console.error('[Liora] Impossible de sauvegarder dans IndexedDB:', e.message);
            showSaveToast('Erreur de sauvegarde: ' + e.message, true);
            return false;
        }
    }

    // Migration des libellés de catégorie renommés (ancien → nouveau)
    const CATEGORY_RENAMES = { 'Alternance (OPCO)': 'OPCO', 'B2C': 'Financement personnel' };
    function migrateCat(c) { return CATEGORY_RENAMES[c] || c; }

    async function loadFromStorage() {
        try {
            const arr = await idbGet(STORAGE_DATA_KEY);
            if (!arr) { console.log('[Liora] Aucune donnée en mémoire.'); return []; }
            console.log('[Liora] Données chargées depuis IndexedDB:', arr.length, 'transactions');
            return arr.map(r => ({
                ...r,
                // Migration des libellés de catégorie renommés (OPCO, Financement personnel…)
                categorie: migrateCat(r.categorie),
                manualCategory: migrateCat(r.manualCategory),
                date: r.date ? new Date(r.date) : new Date(0),
            }));
        } catch (e) {
            console.error('[Liora] Erreur au chargement IndexedDB:', e);
            return [];
        }
    }

    const _seedFileHistory = [
        {name:'PENNYLANE_DATASCIENTEST_Transactions_bancaires.xlsx',rowCount:1178,date:'2026-04-09T09:18:59.763Z'},
        {name:'Transactions_bancaires_pennylane_consolidees.xlsx',rowCount:15447,date:'2026-04-09T09:22:09.671Z'},
        {name:'Transactions_bancaires_pennylane_septembre_2025_categorisees_vf.xlsx',rowCount:1,date:'2026-04-09T09:22:19.179Z'},
        {name:'Transactions_bancaires_pennylane_octobre_2025_categorisees_vf.xlsx',rowCount:22,date:'2026-04-09T09:22:29.773Z'},
        {name:'PENNYLANE_DATASCIENTEST_Transactions_bancaires (1).xlsx',rowCount:1629,date:'2026-04-09T09:27:20.021Z'},
    ];

    async function getFileHistory() {
        try {
            let h = await idbGet(STORAGE_FILES_KEY);
            if ((!h || h.length === 0) && _seedFileHistory.length > 0) {
                h = JSON.parse(JSON.stringify(_seedFileHistory));
                await idbSet(STORAGE_FILES_KEY, h);
                console.log('[Liora] Historique fichiers par défaut chargé:', h.length, 'fichiers');
            }
            return h || [];
        } catch { return []; }
    }

    async function addFileHistory(name, rowCount) {
        const history = await getFileHistory();
        history.push({ name, rowCount, date: new Date().toISOString() });
        try { await idbSet(STORAGE_FILES_KEY, history); } catch {}
    }

    async function clearAllHistory() {
        await idbDelete(STORAGE_DATA_KEY);
        await idbDelete(STORAGE_FILES_KEY);
    }

    // ── Learned Categories Store ──
    // Maps cleaned libellé keywords → { category, sens, count, date, originalLibelle }
    const STORAGE_LEARNED_KEY = 'liora_learned_categories';
    let _learnedCache = {}; // in-memory cache, loaded at startup

    // Strip banking noise from libellé to extract meaningful keywords
    function cleanLibelleForLearning(libelle) {
        let s = normUpper(libelle);
        // Remove leading standalone numbers (reference numbers at the beginning)
        s = s.replace(/^\d+\s+/, '');
        // Remove common banking operation prefixes (VIR SEPA RECU, PRLV SEPA, etc.)
        s = s.replace(/^(VIR(EMENT)?\s*(SEPA)?\s*(EMIS|RECU|INST)?|PRLV\s*(SEPA)?|PRELEVEMENT\s*(SEPA)?|CHQ\s*N?\d*|CB\s*\d*|CARTE\s*\d*|REM\s*CHQ|AVOIR|ECHEANCE)\s*/i, '');
        // Extract /FRM content (the payer/beneficiary name) if present
        const frmMatch = s.match(/\/FRM\s+([^/]+)/i);
        if (frmMatch) {
            s = frmMatch[1].trim();
        }
        // Remove reference blocks (/REF..., /PID..., /MOTIF..., /EID..., /ID..., etc.)
        s = s.replace(/\/[A-Z]{2,10}\s*[:\-]?\s*[^\s/]*/g, '');
        // Remove standalone dates (DD/MM/YYYY, DD-MM-YYYY, DDMMYY, etc.)
        s = s.replace(/\b\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}\b/g, '');
        s = s.replace(/\b\d{6,8}\b/g, ''); // DDMMYYYY or DDMMYY
        // Remove standalone long numbers (reference/account numbers, 4+ digits)
        s = s.replace(/\b\d{4,}\b/g, '');
        // Remove "N°..." or "NO..." patterns
        s = s.replace(/\bN[O°]\s*\d+/gi, '');
        // Remove trailing single letter or short noise
        s = s.replace(/\s+[A-Z]\.?$/i, '');
        // Collapse whitespace
        s = s.replace(/\s+/g, ' ').trim();
        return s;
    }

    // Default seed rules (exported from previous version)
    const _seedLearnedRules = {
        "A F D A S": {category:"OPCO",sens:"Encaissement",count:2,date:1775728913867,originalLibelle:"VIR SEPA RECU /FRM A F D A S /EID 0586742 /RNF FACT-2405-02655  DV-004567"},
        "ADEL BEGGAH": {category:"Financement personnel",sens:"Encaissement",count:1,date:1775728281981,originalLibelle:"VIR SCT INST RECU /FRM ADEL BEGGAH /EID NOTPROVIDED /RNF FACT-2501-07947 (2/6) BEGGAH ADEL"},
        "AISMT13": {category:"B2B",sens:"Encaissement",count:1,date:1775728804651,originalLibelle:"VIR SEPA RECU /FRM AISMT13 /EID ACH260336 /RNF FACT-2602-13858"},
        "ANTHROPIC": {category:"SaaS/IT",sens:"Décaissement",count:1,date:1775729770424,originalLibelle:"ANTHROPIC"},
        "ASP AGENCE COMPTABLE": {category:"Autres revenus",sens:"Encaissement",count:1,date:1775728827668,originalLibelle:"2879926 VIREMENT SEPA RECU ASP AGENCE COMPTABLE"},
        "ASS FORMATION PERMANENTE PERSONNEL HOSP": {category:"B2B",sens:"Encaissement",count:1,date:1775728804651,originalLibelle:"VIR SEPA RECU /FRM ASS FORMATION PERMANENTE PERSONNEL HOSP"},
        "AUTOMOTIVE": {category:"B2B",sens:"Encaissement",count:1,date:1775728306614,originalLibelle:"VIR SEPA RECU /FRM AUTOMOTIVE CELLS COMPANY SE /EID 2026000000879 /RNF FACT-2501-07695"},
        "AXA FRANCE IARD FACT": {category:"B2B",sens:"Encaissement",count:1,date:1775728957519,originalLibelle:"2893107 VIREMENT SEPA RECU AXA FRANCE IARD FACT-2511-12443"},
        "B&B HOME ST OUEN": {category:"Note de frais",sens:"Décaissement",count:1,date:1775729770424,originalLibelle:"B&B HOME ST OUEN"},
        "BANKIN": {category:"B2B",sens:"Encaissement",count:1,date:1775728804651,originalLibelle:"VIR SEPA RECU /FRM BANKIN /EID PP41035873"},
        "BAPTISTE BERNAUD": {category:"Formateurs / Freelances",sens:"Décaissement",count:1,date:1775730109926,originalLibelle:"FCT20260313 BAPTISTE BERNAUD DATASCIENTEST"},
        "BERGER LEVRAULT": {category:"B2B",sens:"Encaissement",count:1,date:1775728804651,originalLibelle:"VIR SEPA RECU /FRM BERGER LEVRAULT /EID VIR214915 /RNF FACT-2601-13349-"},
        "BITLY.COM": {category:"SaaS/IT",sens:"Décaissement",count:1,date:1775730015479,originalLibelle:"BITLY.COM"},
        "BKG*HOTEL": {category:"Autres revenus",sens:"Encaissement",count:1,date:1775728324680,originalLibelle:"BKG*HOTEL AT BOOKING.C"},
        "BNP PARIBAS PERSONAL FINANCE": {category:"B2B",sens:"Encaissement",count:1,date:1775728804651,originalLibelle:"VIR SEPA RECU /FRM BNP PARIBAS PERSONAL FINANCE"},
        "BRGM": {category:"B2B",sens:"Encaissement",count:1,date:1775728281982,originalLibelle:"VIR SEPA RECU /FRM BRGM /EID 164122 /RNF FACT-2506-10225"},
        "BUDGET GENERAL - CHU DE REIMS": {category:"B2B",sens:"Encaissement",count:1,date:1775728281981,originalLibelle:"VIR SEPA RECU /FRM BUDGET GENERAL - CHU DE REIMS"},
        "BV CERTIFICATION": {category:"Partenariat académique",sens:"Décaissement",count:1,date:1775730197629,originalLibelle:"PRLV SEPA BV CERTIFICATION FRANCE"},
        "BWI FRANCE": {category:"B2B",sens:"Encaissement",count:1,date:1775728281981,originalLibelle:"VIR SEPA RECU /FRM BWI FRANCE /EID 200000574330402026 /RNF FACT-2602-13824"},
        "CA PERSONAL FINANCE . MOBILITY ECH/ ID EMETTEUR MDT REF LIB FINANCE": {category:"Frais généraux & services",sens:"Décaissement",count:1,date:1775729974726,originalLibelle:"PRLV SEPA CA PERSONAL FINANCE . MOBILITY"},
        "CABINET LACOMBLEZ": {category:"B2B",sens:"Encaissement",count:1,date:1775728804651,originalLibelle:"VIR SEPA RECU /FRM CABINET LACOMBLEZ /EID DATASCIENTEST /RNF FACT-2602-13657"},
        "CACEIS BANK": {category:"B2B",sens:"Encaissement",count:1,date:1775728281981,originalLibelle:"VIR SEPA RECU /FRM CACEIS BANK /EID 00349/5610/225659"},
        "CENTRAPEL": {category:"B2B",sens:"Encaissement",count:1,date:1775728677583,originalLibelle:"VIR SEPA RECU /FRM CENTRAPEL /EID F02DOTH001149 /RNF FACT-2602-13818"},
        "CENTRE GEORGES FRANCOIS LECLERC": {category:"B2B",sens:"Encaissement",count:1,date:1775729024670,originalLibelle:"CENTRE GEORGES FRANCOIS LECLERC  FCT-FILIZ-DST-2026-49"},
        "CESAME ANTILLES": {category:"B2B",sens:"Encaissement",count:1,date:1775728677583,originalLibelle:"VIR SEPA RECU /FRM CESAME ANTILLES"},
        "CLOUDFLARE": {category:"SaaS/IT",sens:"Décaissement",count:1,date:1775729770424,originalLibelle:"CLOUDFLARE"},
        "COJEAN LA DEFENSE": {category:"Note de frais",sens:"Décaissement",count:1,date:1775730015479,originalLibelle:"COJEAN LA DEFENSE"},
        "COMPAGNIE PAUL PREDAULT": {category:"B2B",sens:"Encaissement",count:1,date:1775728281981,originalLibelle:"VIR SEPA RECU /FRM COMPAGNIE PAUL PREDAULT /EID 0000005296 /RNF FACT-2601-13404"},
        "COTE COUR": {category:"B2B",sens:"Encaissement",count:1,date:1775728804651,originalLibelle:"VIR SEPA RECU /FRM COTE COUR"},
        "CPAM 93": {category:"Autres revenus",sens:"Encaissement",count:1,date:1775728677583,originalLibelle:"VIR SEPA RECU /FRM CPAM 93"},
        "CSP GUYANE": {category:"B2B",sens:"Encaissement",count:1,date:1775728804651,originalLibelle:"VIR SEPA RECU /FRM CSP GUYANE"},
        "CU GPSO": {category:"B2B",sens:"Encaissement",count:1,date:1775728281981,originalLibelle:"VIR SEPA RECU /FRM CU GPSO"},
        "CURSOR": {category:"SaaS/IT",sens:"Décaissement",count:1,date:1775730274298,originalLibelle:"CURSOR, AI POWERED IDE"},
        "DECENCIERE FERRANDIERE STEPHANE": {category:"Financement personnel",sens:"Encaissement",count:2,date:1775728677583,originalLibelle:"VIR SCT INST RECU /FRM DECENCIERE FERRANDIERE STEPHANE"},
        "DEPARTEMENT DU GARD": {category:"B2B",sens:"Encaissement",count:1,date:1775728971668,originalLibelle:"DEPARTEMENT DU GARD - BUDGET PRI  FACT-2405-02044"},
        "EASYVOYAGE": {category:"B2B",sens:"Encaissement",count:1,date:1775728281981,originalLibelle:"VIR SEPA RECU /FRM EASYVOYAGE /EID F02DSUP000181"},
        "EAT ON LINE": {category:"B2B",sens:"Encaissement",count:1,date:1775728281982,originalLibelle:"VIR SEPA RECU /FRM EAT ON LINE /EID EFT-00834956 /RNF FACT-2502-08441"},
        "EI - M'HOUMADI OUSSOUFI NASSUR": {category:"Formateurs / Freelances",sens:"Décaissement",count:1,date:1775730287744,originalLibelle:"EI - M'HOUMADI OUSSOUFI NASSUR"},
        "ELEVENLABS.IO": {category:"SaaS/IT",sens:"Décaissement",count:1,date:1775729974727,originalLibelle:"ELEVENLABS.IO"},
        "ELIE LAYANI": {category:"Formateurs / Freelances",sens:"Décaissement",count:1,date:1775730220026,originalLibelle:"20260101 ELIE LAYANI DATASCIENTEST"},
        "EPF VENDEE": {category:"B2B",sens:"Encaissement",count:1,date:1775728677583,originalLibelle:"VIR SEPA RECU /FRM EPF VENDEE"},
        "ETRANGER EMIS ATHLAN ISRAEL DISCOUNT BANK LTD. ,00": {category:"Formateurs / Freelances",sens:"Décaissement",count:1,date:1775729770424,originalLibelle:"VIR ETRANGER EMIS /BEN STEPHANIE ATHLAN"},
        "ETRANGER EMIS ATTIJARIBANK (FORM. BANQUE DU SUD) 014 ,41": {category:"Formateurs / Freelances",sens:"Décaissement",count:1,date:1775729770424,originalLibelle:"VIR ETRANGER EMIS /BEN MERAKYS/BIC BSTUTNTT"},
        "EVEN GESTION": {category:"B2B",sens:"Encaissement",count:1,date:1775728804651,originalLibelle:"VIR SCT INST RECU /FRM EVEN GESTION"},
        "FAC LOGISTIQUE": {category:"B2B",sens:"Encaissement",count:1,date:1775728281981,originalLibelle:"VIR SEPA RECU /FRM FAC LOGISTIQUE /EID VIR32717"},
        "FIGMA": {category:"SaaS/IT",sens:"Décaissement",count:1,date:1775729770424,originalLibelle:"FIGMA"},
        "FREELANCE.COM": {category:"Autres revenus",sens:"Encaissement",count:1,date:1775728281982,originalLibelle:"VIR SEPA RECU /FRM FREELANCE.COM /EID VIR SUBVENTION DEFINUM DATASCIENTES"},
        "FS *LINKVECTOR": {category:"SaaS/IT",sens:"Décaissement",count:1,date:1775730015479,originalLibelle:"FS *LinkVector"},
        "FTE FORMATION": {category:"Formateurs / Freelances",sens:"Décaissement",count:1,date:1775730065677,originalLibelle:"VIREMENT SEPA EMIS FTE FORMATION"},
        "GENSPARK.AI": {category:"SaaS/IT",sens:"Décaissement",count:1,date:1775729770424,originalLibelle:"GENSPARK.AI"},
        "GEOSEL MANOSQUE": {category:"B2B",sens:"Encaissement",count:1,date:1775728804651,originalLibelle:"VIR SEPA RECU /FRM GEOSEL MANOSQUE /EID FACT-2602-13661"},
        "GFIP IMPOT-PAS-DSN": {category:"Prélèvement à la source (PAS)",sens:"Décaissement",count:1,date:1775730090792,originalLibelle:"PRLV SEPA B2B DGFIP IMPOT"},
        "GIE LES CINEMAS PATHE": {category:"Frais généraux & services",sens:"Décaissement",count:1,date:1775729974726,originalLibelle:"GIE Les Cinemas Pathe"},
        "GIP SESAN": {category:"B2B",sens:"Encaissement",count:1,date:1775728677583,originalLibelle:"VIR SEPA RECU /FRM GIP SESAN /EID FAC FACT-2603-14014"},
        "GOOGLE ONE": {category:"SaaS/IT",sens:"Décaissement",count:1,date:1775729974727,originalLibelle:"Google One"},
        "HOLDING BB": {category:"B2B",sens:"Encaissement",count:1,date:1775728804651,originalLibelle:"VIR SEPA RECU /FRM HOLDING BB"},
        "IDRIC": {category:"Formateurs / Freelances",sens:"Décaissement",count:1,date:1775730134776,originalLibelle:"VIR ETRANGER EMIS /BEN IDRIC"},
        "IDS GMBH - ANALYSIS AND REPORTING SERVICES": {category:"B2B",sens:"Encaissement",count:1,date:1775728281981,originalLibelle:"VIR SEPA RECU /FRM IDS GMBH - ANALYSIS AND REPORTING SERVICES"},
        "ISTOCK.COM": {category:"Marketing & Acquisition",sens:"Décaissement",count:2,date:1775729974727,originalLibelle:"iStock.com"},
        "IT TRATTORIA": {category:"Note de frais",sens:"Décaissement",count:1,date:1775729974726,originalLibelle:"IT TRATTORIA"},
        "KAHOOT] ASA": {category:"SaaS/IT",sens:"Décaissement",count:1,date:1775729974726,originalLibelle:"KAHOOT] ASA"},
        "LA FAMILLE PARV": {category:"Note de frais",sens:"Décaissement",count:1,date:1775729770424,originalLibelle:"LA FAMILLE PARV"},
        "LAPOSTE": {category:"Frais généraux & services",sens:"Décaissement",count:1,date:1775730145074,originalLibelle:"LAPOSTE L929540"},
        "LOUIS VUITTON": {category:"B2B",sens:"Encaissement",count:1,date:1775728938768,originalLibelle:"VIR SEPA RECU /FRM SOCIETE LOUIS VUITTON SV"},
        "MANUTAN": {category:"B2B",sens:"Encaissement",count:1,date:1775728804651,originalLibelle:"VIR SEPA RECU /FRM MANUTAN"},
        "MEVENGUE": {category:"Formateurs / Freelances",sens:"Décaissement",count:1,date:1775730253360,originalLibelle:"VIR ETRANGER EMIS /BEN BERNARD MEVENGUE"},
        "MINDLAPSE": {category:"B2B",sens:"Encaissement",count:1,date:1775728804651,originalLibelle:"VIR SEPA RECU /FRM MINDLAPSE"},
        "MOB HOUSE PARIS": {category:"Frais généraux & services",sens:"Décaissement",count:1,date:1775729974726,originalLibelle:"Mob House PARIS"},
        "MOBILIS BANQUE": {category:"B2B",sens:"Encaissement",count:1,date:1775728296031,originalLibelle:"VIR SEPA RECU /FRM MOBILIS BANQUE /EID MBQDFG003215"},
        "MONOPRIX": {category:"Frais généraux & services",sens:"Décaissement",count:1,date:1775729974727,originalLibelle:"MONOPRIX"},
        "MULTIPRO PROF LIB BRED CONNECT OFFERT": {category:"Autres revenus",sens:"Encaissement",count:1,date:1775728868051,originalLibelle:"MULTIPRO PROF LIB BRED CONNECT OFFERT"},
        "NATIONAL LOGISTIQUE ROUTE": {category:"B2B",sens:"Encaissement",count:1,date:1775728804651,originalLibelle:"VIR SEPA RECU /FRM NATIONAL LOGISTIQUE ROUTE"},
        "NEATRO": {category:"SaaS/IT",sens:"Décaissement",count:1,date:1775729974726,originalLibelle:"NEATRO"},
        "NOVIUS": {category:"B2B",sens:"Encaissement",count:1,date:1775728281981,originalLibelle:"VIR SEPA RECU /FRM NOVIUS"},
        "O2SWITCH.FR": {category:"SaaS/IT",sens:"Décaissement",count:1,date:1775729974727,originalLibelle:"O2SWITCH.FR"},
        "OCTAEDGE": {category:"B2B",sens:"Encaissement",count:1,date:1775728281981,originalLibelle:"VIR SCT INST RECU /FRM OCTAEDGE"},
        "ONOFF": {category:"SaaS/IT",sens:"Décaissement",count:2,date:1775729770424,originalLibelle:"ONOFF"},
        "PAIE RH SOLUTIONS": {category:"B2B",sens:"Encaissement",count:1,date:1775728281981,originalLibelle:"VIR SEPA RECU /FRM PAIE RH SOLUTIONS"},
        "PENNYLANE - DATASCIENTEST": {category:"Interco",sens:"Encaissement",count:1,date:1775728281981,originalLibelle:"Pennylane - DATASCIENTEST"},
        "POST AFFILIATE PRO": {category:"Frais généraux & services",sens:"Décaissement",count:2,date:1775729974727,originalLibelle:"POST AFFILIATE PRO"},
        "REEL": {category:"SaaS/IT",sens:"Décaissement",count:1,date:1775730015479,originalLibelle:"REEL"},
        "REEZOCORP": {category:"B2B",sens:"Encaissement",count:1,date:1775728677583,originalLibelle:"VIR SEPA RECU /FRM REEZOCORP"},
        "RHENFORSE": {category:"B2B",sens:"Encaissement",count:3,date:1775728281981,originalLibelle:"VIR SCT INST RECU /FRM RHENFORSE"},
        "RUNNINGHUB.AI": {category:"SaaS/IT",sens:"Décaissement",count:1,date:1775729770424,originalLibelle:"RUNNINGHUB.AI"},
        "SAFRAN": {category:"B2B",sens:"Encaissement",count:1,date:1775728804651,originalLibelle:"VIR SEPA RECU /FRM SAFRAN"},
        "SEMRUSH": {category:"Autres revenus",sens:"Encaissement",count:1,date:1775728281981,originalLibelle:"Semrush"},
        "SENTRY": {category:"SaaS/IT",sens:"Décaissement",count:1,date:1775729974727,originalLibelle:"SENTRY"},
        "SEOUDAPP": {category:"SaaS/IT",sens:"Décaissement",count:1,date:1775729974726,originalLibelle:"SEOUDAPP"},
        "SEREZO": {category:"Formateurs / Freelances",sens:"Décaissement",count:1,date:1775730183776,originalLibelle:"20260102 SEREZO DATASCIENTEST"},
        "SERVIER MONDE": {category:"B2B",sens:"Encaissement",count:1,date:1775729034457,originalLibelle:"SERVIER MONDE  FACT-2411-07025"},
        "SERVMASK INC.": {category:"SaaS/IT",sens:"Décaissement",count:1,date:1775729974727,originalLibelle:"SERVMASK INC."},
        "SMARTBOX LTD FR0367206": {category:"Frais généraux & services",sens:"Décaissement",count:1,date:1775729974727,originalLibelle:"SMARTBOX LTD FR0367206"},
        "SMI SDEA EAU": {category:"B2B",sens:"Encaissement",count:1,date:1775728804651,originalLibelle:"VIR SEPA RECU /FRM SMI SDEA EAU"},
        "SNCF VOYAGEURS TER PPU FACT--": {category:"B2B",sens:"Encaissement",count:1,date:1775728677583,originalLibelle:"SNCF VOYAGEURS TER PPU  FACT-2602-13782"},
        "STEPHANE DECENCIERE FERRANDIERE": {category:"Financement personnel",sens:"Encaissement",count:1,date:1775728677583,originalLibelle:"VIR SCT INST RECU /FRM STEPHANE DECENCIERE FERRANDIERE"},
        "SWAN - INCOMING NON-EURO CREDIT TRANSFER": {category:"Banques/Dettes",sens:"Décaissement",count:2,date:1775730173561,originalLibelle:"SWAN - Incoming non-euro credit transfer (group 1)"},
        "TALENDI": {category:"B2B",sens:"Encaissement",count:1,date:1775728804651,originalLibelle:"VIR SEPA RECU /FRM TALENDI"},
        "TELLA": {category:"SaaS/IT",sens:"Décaissement",count:1,date:1775729770424,originalLibelle:"TELLA"},
        "THALES": {category:"B2B",sens:"Encaissement",count:1,date:1775729006654,originalLibelle:"THALES ALENIA SPACE FRANCE  FACT-2405-02874"},
        "THOM FOR YOU": {category:"B2B",sens:"Encaissement",count:1,date:1775728804651,originalLibelle:"VIR SEPA RECU /FRM THOM FOR YOU"},
        "TOMORRO DATASCIENTEST": {category:"SaaS/IT",sens:"Décaissement",count:1,date:1775729770424,originalLibelle:"1522 TOMORRO DATASCIENTEST"},
        "TRAINING SQUARE": {category:"B2B",sens:"Encaissement",count:1,date:1775728986318,originalLibelle:"TRAINING SQUARE  FACT-2601-13029"},
        "UCAR": {category:"B2B",sens:"Encaissement",count:1,date:1775728804651,originalLibelle:"VIR SEPA RECU /FRM UCAR"},
        "VC TECHNOLOGY": {category:"B2B",sens:"Encaissement",count:1,date:1775728677583,originalLibelle:"VIR SEPA RECU /FRM VC TECHNOLOGY"},
        "VECTORSOFT": {category:"B2B",sens:"Encaissement",count:1,date:1775728677583,originalLibelle:"VIR SCT INST RECU /FRM VECTORSOFT"},
        "VELSIA": {category:"B2B",sens:"Encaissement",count:1,date:1775728804651,originalLibelle:"VIR SEPA RECU /FRM VELSIA"},
        "VOODOO": {category:"B2B",sens:"Encaissement",count:1,date:1775728281981,originalLibelle:"VIR SEPA RECU /FRM VOODOO /EID 1230 /RNF FACT-2602-13430"},
        "WE MADE YA": {category:"Marketing & Acquisition",sens:"Décaissement",count:1,date:1775729974727,originalLibelle:"WE MADE YA"},
        "WEBFLOW.COM": {category:"SaaS/IT",sens:"Décaissement",count:1,date:1775730015479,originalLibelle:"WEBFLOW.COM"},
        "WWW.PERPLEXITY.AI": {category:"SaaS/IT",sens:"Décaissement",count:1,date:1775729770424,originalLibelle:"WWW.PERPLEXITY.AI"},
        "WWW.TRUSTINDEX.IO": {category:"Marketing & Acquisition",sens:"Décaissement",count:1,date:1775730015479,originalLibelle:"WWW.TRUSTINDEX.IO"},
        "YUKI": {category:"Note de frais",sens:"Décaissement",count:1,date:1775729770424,originalLibelle:"YUKI"},
        "ZE WILLIAMS EMANE BOMO DATASCIENTEST": {category:"Formateurs / Freelances",sens:"Décaissement",count:1,date:1775729974727,originalLibelle:"2026021 ZE WILLIAMS EMANE BOMO DATASCIENTEST"},
        "ZENDAKIA": {category:"B2B",sens:"Encaissement",count:1,date:1775728804651,originalLibelle:"VIR SCT INST RECU /FRM ZENDAKIA"},
    };

    async function loadLearnedCategories() {
        try { _learnedCache = (await idbGet(STORAGE_LEARNED_KEY)) || {}; } catch { _learnedCache = {}; }
        // Seed with default rules if cache is empty (first launch or data lost)
        if (Object.keys(_learnedCache).length === 0 && Object.keys(_seedLearnedRules).length > 0) {
            _learnedCache = JSON.parse(JSON.stringify(_seedLearnedRules));
            await saveLearnedCategories();
            console.log('[Liora] Règles par défaut chargées:', Object.keys(_learnedCache).length, 'règles');
        }
        // Migration des libellés de catégorie renommés (OPCO, Financement personnel…)
        let migrated = false;
        for (const v of Object.values(_learnedCache)) {
            if (v && CATEGORY_RENAMES[v.category]) { v.category = CATEGORY_RENAMES[v.category]; migrated = true; }
        }
        if (migrated) { await saveLearnedCategories(); console.log('[Liora] Règles apprises migrées vers les nouveaux libellés'); }
    }

    async function saveLearnedCategories() {
        await idbSet(STORAGE_LEARNED_KEY, _learnedCache);
    }

    async function learnCategoryBatch(entries) {
        for (const { libelle, category, sens } of entries) {
            const key = cleanLibelleForLearning(libelle);
            if (key.length < 3) continue; // skip if cleaned key is too short
            _learnedCache[key] = {
                category, sens,
                count: (_learnedCache[key]?.count || 0) + 1,
                date: Date.now(),
                originalLibelle: libelle, // keep original for display
            };
        }
        await saveLearnedCategories();
    }

    async function deleteLearnedRule(key) {
        delete _learnedCache[key];
        await saveLearnedCategories();
    }

    function findLearnedCategory(libelleNorm, sens) {
        const cleaned = cleanLibelleForLearning(libelleNorm);
        // Exact match on cleaned key
        if (_learnedCache[cleaned] && _learnedCache[cleaned].sens === sens) {
            return _learnedCache[cleaned].category;
        }
        // Partial match: cleaned libellé contains a learned key or vice versa
        let bestMatch = null;
        let bestLen = 0;
        for (const [key, val] of Object.entries(_learnedCache)) {
            if (val.sens !== sens) continue;
            if (key.length < 3) continue;
            if (cleaned.includes(key) || key.includes(cleaned)) {
                const matchLen = Math.min(key.length, cleaned.length);
                if (matchLen > bestLen) {
                    bestLen = matchLen;
                    bestMatch = val.category;
                }
            }
        }
        return bestMatch;
    }

    // ── Registry (annuaire officiel — recherche-entreprises.api.gouv.fr, gratuit & sans clé) ──
    // v3 : classe chaque encaissement inconnu en B2B (société commerciale), public (laissé
    //      en Autres revenus) ou « Financement personnel » (aucune entité immatriculée trouvée).
    //      Le changement de clé invalide l'ancien cache.
    const STORAGE_B2B_KEY = 'liora_b2b_registry_v3';
    const STORAGE_B2B_PERSO_KEY = 'liora_b2b_apply_personal'; // n'applique le « personnel » qu'après détection manuelle
    const STORAGE_AUTO_B2B_KEY = 'liora_auto_b2b_import';     // option : auto-B2B à l'import (décochée par défaut)
    let b2bRegistryCache = {}; // { CLEAN_NAME: { found, isCompany, siren, nom, nature } }
    let b2bApplyPersonal = false;

    async function loadB2BCache() {
        try { b2bRegistryCache = (await idbGet(STORAGE_B2B_KEY)) || {}; } catch { b2bRegistryCache = {}; }
        try { b2bApplyPersonal = (await idbGet(STORAGE_B2B_PERSO_KEY)) === true; } catch { b2bApplyPersonal = false; }
    }
    async function saveB2BCache() {
        try { await idbSet(STORAGE_B2B_KEY, b2bRegistryCache); } catch { /* ignore */ }
    }
    function b2bCacheKey(name) { return normUpper(name); }

    // Extrait un nom d'entreprise interrogeable depuis une transaction
    // (champ Tiers prioritaire, sinon Libellé nettoyé de ses mentions bancaires)
    function extractCompanyName(row) {
        const tiers = (row.tiers || '').trim();
        let s = (tiers || String(row.libelle || '')).replace(/\s+/g, ' ').trim();
        if (!tiers) {
            // Couper au premier jeton contenant 4 chiffres ou plus (souvent une référence de transaction)
            const cut = s.search(/\S*\d{4,}/);
            if (cut > 2) s = s.slice(0, cut);
            // Retirer les mentions bancaires courantes
            s = s.replace(/\b(VIREMENT|VIR|SCT|INST|SEPA|RE[CÇ]U|RECU|EMIS|PRELEVEMENT|PRLV|PAIEMENT|PAR|CARTE|DE|DU|DES|LA|LE|LES)\b/gi, ' ');
        }
        // Nettoyage : lettres/chiffres/espaces et quelques séparateurs, puis 6 mots max
        s = s.replace(/[^0-9A-Za-zÀ-ÿ &'’.\-]/g, ' ').replace(/\s+/g, ' ').trim();
        return s.split(' ').slice(0, 6).join(' ').trim();
    }

    // Contrôle de confiance : le nom trouvé doit partager un jeton significatif avec la requête
    function registryNameMatches(query, found) {
        const q = normUpper(query), f = normUpper(found);
        if (!q || !f) return false;
        const qTok = q.split(' ').filter(t => t.length >= 4);
        const fTok = new Set(f.split(' ').filter(t => t.length >= 2));
        return qTok.some(t => fTok.has(t) || f.includes(t));
    }

    // B2B = société commerciale privée uniquement. L'annuaire recense AUSSI les organismes
    // publics, collectivités, France Travail, CPAM, OPCO (associations)… qui ont tous un SIREN.
    // On filtre donc sur la catégorie juridique (5xxx = sociétés commerciales) et on exclut
    // explicitement associations, services publics, collectivités et entrepreneurs individuels.
    function isCommercialCompany(top) {
        const nj = String(top.nature_juridique || '');
        const c = top.complements || {};
        if (c.est_association) return false;                       // ex. OPCO
        if (c.est_service_public) return false;                    // ex. France Travail, CPAM
        if (c.est_collectivite_territoriale || c.collectivite_territoriale) return false; // régions, communes
        if (c.est_entrepreneur_individuel) return false;           // personne physique → pas B2B société
        return nj.charAt(0) === '5';                               // 5xxx = sociétés commerciales (SA, SAS, SARL, EURL…)
    }

    // Garde-fou : un nom portant une forme de société (souvent étrangère, absente de l'annuaire FR)
    // ne doit pas être classé « financement personnel » par erreur.
    const COMPANY_FORM_RE = /\b(LTD|LIMITED|GMBH|INC|LLC|CORP|CORPORATION|PLC|SPA|SRL|PTY|SARL|SASU|SAS|EURL|HOLDING|GROUP|GROUPE|COMPANY)\b/;
    function looksLikeCompanyForm(name) { return COMPANY_FORM_RE.test(normUpper(name)); }

    // Interroge l'annuaire officiel pour un nom → { found, isCompany, siren, nom, nature }
    // found=false : aucune entité immatriculée ne correspond (→ candidat « financement personnel »).
    async function queryCompanyRegistry(name) {
        const url = 'https://recherche-entreprises.api.gouv.fr/search?q='
            + encodeURIComponent(name) + '&page=1&per_page=1';
        const resp = await fetchWithRetry(url, { method: 'GET' });
        if (!resp || !resp.ok) throw new Error('Annuaire indisponible (' + (resp ? resp.status : 'réseau') + ')');
        const data = await resp.json(); // JSON invalide → exception capturée en amont (non mis en cache)
        const results = (data && data.results) || [];
        if (!results.length) return { found: false, isCompany: false };
        const top = results[0];
        const nom = top.nom_complet || top.nom_raison_sociale || '';
        if (!registryNameMatches(name, nom)) return { found: false, isCompany: false };
        // Organismes publics / associations / collectivités : trouvés mais non B2B
        if (!isCommercialCompany(top)) return { found: true, isCompany: false, nom, nature: String(top.nature_juridique || '') };
        return { found: true, isCompany: true, siren: top.siren || '', nom, nature: String(top.nature_juridique || '') };
    }

    // Lignes candidates : encaissements retombés en "Autres revenus" via le fallback (aucune règle), non reclassés
    function getB2BCandidateRows() {
        return rawData.filter(r =>
            r.sens === 'Encaissement' &&
            r.categorie === 'Autres revenus' &&
            r.ruleHit === 'Enc: Fallback' &&
            !r.manualCategory
        );
    }

    // Migrate from localStorage to IndexedDB (one-time)
    async function migrateFromLocalStorage() {
        try {
            const json = localStorage.getItem(STORAGE_DATA_KEY);
            if (!json) return;
            const arr = JSON.parse(json);
            await idbSet(STORAGE_DATA_KEY, arr);
            const filesJson = localStorage.getItem(STORAGE_FILES_KEY);
            if (filesJson) await idbSet(STORAGE_FILES_KEY, JSON.parse(filesJson));
            localStorage.removeItem(STORAGE_DATA_KEY);
            localStorage.removeItem(STORAGE_FILES_KEY);
            console.log('Migration localStorage → IndexedDB terminée.');
        } catch (e) {
            console.warn('Migration localStorage échouée:', e);
        }
    }

    /** Deduplicate: two rows are considered the same if date+libelle+montant+tiers match */
    function deduplicateKey(r) {
        const d = r.date && !isNaN(r.date.getTime()) ? r.date.toISOString().slice(0, 10) : '';
        return d + '|' + (r.libelle || '') + '|' + r.montant + '|' + (r.tiers || '');
    }

    function mergeData(existingData, newData) {
        const seen = new Set(existingData.map(deduplicateKey));
        let added = 0;
        for (const row of newData) {
            const key = deduplicateKey(row);
            if (!seen.has(key)) {
                existingData.push(row);
                seen.add(key);
                added++;
            }
        }
        existingData.sort((a, b) => a.date - b.date);
        return added;
    }

    // ── DOM References ──
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);

    const screens = {
        upload: $('#upload-screen'),
        loading: $('#loading-screen'),
        dashboard: $('#dashboard-screen'),
    };

    // ══════════════════════════════════════════════
    //  CATEGORIZATION ENGINE (translated from Python v6.2.1h)
    // ══════════════════════════════════════════════

    // ── Helpers: accent stripping & normalization ──
    function stripAccents(s) {
        if (typeof s !== 'string') return '';
        return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    }

    function normUpper(s) {
        if (s == null) s = '';
        s = String(s);
        s = stripAccents(s).toUpperCase();
        s = s.replace(/\s+/g, ' ').trim();
        return s;
    }

    function containsAnyDual(textNorm, keywords) {
        if (typeof textNorm !== 'string') return false;
        const up = textNorm;
        const noacc = stripAccents(up);
        for (const kw of keywords) {
            const k = kw.toUpperCase();
            if (up.includes(k) || noacc.includes(k)) return true;
        }
        return false;
    }

    // ── Person detection ──
    const CIV_RE = /\b(M\.?|MR|MME|MADAME|MADEMOISELLE|MLLE|MLE|MONSIEUR)\b/i;

    const FIRSTNAMES_EXTRA = new Set([
        'YOUSEF','YOUSSEF','PRISCILLIA','MARTA','ALEJANDRA','GUILLAUME','KATIA','DIALLO','AMINE','WILFRIED',
        'YASMINE','VLADISLAV','SAMUEL','OUALID','WALID','MAROUANE','MAHDI','AURORE','JEAN-RAPHAEL','DENIS',
        'ABDOULAYE','HASSAN','HORACE','GUSTAVE','ALESSANDRO','FARIS','CYRIELLE','JEAN-PAUL','THIBAUT',
    ].map(x => stripAccents(x).toUpperCase()));

    function looksLikePerson(textNorm) {
        if (CIV_RE.test(textNorm)) return true;

        let toks = stripAccents(textNorm).toUpperCase().split(/\s+/).filter(t => /^[A-Z]+$/i.test(t));
        for (let i = 0; i < toks.length - 1; i++) {
            if (FIRSTNAMES_EXTRA.has(toks[i]) || FIRSTNAMES_EXTRA.has(toks[i + 1])) return true;
        }

        const m = textNorm.match(/\/FRM\s+([^/]+)/i);
        if (m) {
            const part = normUpper(m[1]);
            const toks2 = stripAccents(part).toUpperCase().split(/\s+/).filter(t => /^[A-Z]+$/i.test(t));
            for (let i = 0; i < toks2.length - 1; i++) {
                if (FIRSTNAMES_EXTRA.has(toks2[i]) || FIRSTNAMES_EXTRA.has(toks2[i + 1])) return true;
            }
        }
        return false;
    }

    // ── Keyword dictionaries ──

    // Encaissements
    const INTERCO_ENC_KEYS = [
        'TRESO','TRESORERIE','AFORSSIC','FORSSIC','VIREMENT COMPENSE','DST GERMANY',
        'APPROVISIONNEMENT','DEBIT MENSUEL CARTE BLEUE','COMPTE PRO','APPRO','PRELEVEMENT AUTOMATIQUE',
        'AMERICAN EXPRESS CARTE','AMERICAN EXPRESS CARTE-FRANCE','TRESORERIE',
    ];

    const OPCO_KEYS = [
        'AFDAS','ATLAS','OCAPIAT','UNIFORMATION','CONSTRUCTYS',"L'OPCOMMERCE",'OPCOMMERCE','AKTO','OPCO2I',
        'OPCO MOBILITES','OPCO EP','OPCO SANTE',
    ];

    const CPF_KEYS = ['CPF','CAISSE DES DEPOTS'];

    const RECONV_KEYS = [
        'TRANSITIONS PRO','REGION','FRANCE TRAVAIL','POLE EMPLOI','NOUVELLE-AQUITAINE','METROPOLE','VILLE',
        'COMMUNE','MEURTHE-ET-MOSELLE','SOMME','CENTRE ET LOIRET','VAL DE SEINE','YVELINES','DORDOGNE',
        'NORMANDIE','OCCITANIE','VAL DE SAONE','LOIRET',
    ];

    const B2B_EXTRA = [
        'AEROPORTS','AEROPORT','ELUSDIF','DELANE SI','MANUFACTURE','ACTEMIK','WADAM-IT','24 SEVRES','ADME',
        'ADWAY','GIRONDIN','AIR AUSTRAL','ALBA UP','ALBINGIA','AUBAY','AVELOOK','CHRU','CHRS','RHODIA','COTE FLUX',
        'CREDIT AGRICOLE','DEPIXUS','EASYDIS','ECHOSENS','ECO CO2','FACILITY PARK','FIOULMARKET',
        'MAINTENANCE','FLOCA','GUILDE DES LUNETIERS','HIGH CO BOX','HUTCHINSON','LIAISONS','LONG PLAY','GAMBLING',
        'SIEGE','NEOLITHE','NERABIS','FILTRATION','OLINDA','ONASOFT','OODRIVE','OPEN BEE','ORTHO-CARAIBES',
        'PLACE DE LA','PONTOON','POSOS','PRAEMIA','PRELIGENS','PRODISER','PROXISERVE','QUANTUM','RANDSTAD','REALITES',
        'RENTR','RESEAU CANOPE','INDUSTRIE','SCALIAN','SELARL FIDES','SIACI SAINT HONORE','COMPOSITE','TISSIUM',
        'TYRES','VALRHONA','VEDICOM','LEARNQUEST','WINKO','ORANGE','LHH','NOOUS','SODEXO','LE PUY DU FOU',
        'LIGUE NATIONALE','DOMIS','MUTUELLES','MY MONEY BANK','METRO','SAPMER','CONSUMER FINANCE','GOLDEN BEES',
        'ALIXIO','SIMPLON','MANPOWER','DACODE','CEREMA','INVEST','SALSIFY','IZNES','SOCIETE DE GESTION',
        'MANCHE NUMERIQUE','TILD','SOCFIM','BUSINESS SOLUTIONS','PHARMA','FUTUROSOFT','HUSQVARNA','ASNR',
        'NEXITY','COMMISSARIAT','HEALTHCARE','TEKSIALCSTA','FRANPRIX','WEBCHECK','VERTUO','SANDVIK',
        'CONSTRUCTION','POS CONNECT','SYNERINTERNATIONALGIE','APICIL','GROUPE','IT SERVICES',
        'SYSTEMES ET TELECOMMUNICATIONS','DISNEY','ANTARGAZ','INTERNATIONAL','WIRING SYSTEMS','SOCIETE GENERALE',
        'LP GROUPE','LDLC FINANCE','PROFESSION SANTE','NIIT IRELAND','ALLIANZ','ALSO FRANCE','ENGIE','VINCI',
        'CASTORAMA','VENATHEC','MOODY','DISTRIBUTION','AIA INGENIERIE','SOLIDARITES ET SANTE','ELOGEN',
        'CAMCA MUTUELLE','LISEA','STE CCAS',
        'ORSYS','ARCELORMITTAL','SAINT-GOBAIN','SELARL','ASSURANCES','BUROK TECH','WORLDLINE FRANCE',
        'ARS HAUTS DE FRANCE','GIVENCHY','USSEL','SMART','CONSULTING','CORETAB','MISTERTEMP','SMILE','AXYLIS',
        'ARAQIM','CONECS','G3 SERVICE','INRAE','SIDEV','MALTA','LUMINESS','ASSISTANCE','LIVESTORM',
        'OLYMPIQUE LYONNAIS','YZICO','ICON FRANCE','CANDEX','XELIANS','AVITUM','MACIF','PERNOD RICARD',
        'CNMSS','LEAKMITED','ACCENTURE','AVANADE','DCM 075','ICAPE','PASS CULTURE','SYSTEMGIE','MNH1',
        'FORMIRIS','SPARKS',
    ];

    const B2C_PSP = ['ALMA','GOCARDLESS','STRIPE'];

    const AUTRES_REV_KEYS = ['CPAM','AIDE','SUBVENTION'];

    // Décaissements
    const INTERCO_DEC_KEYS = [
        'TRESO','TRESORERIE','AFORSSIC','FORSSIC','VIREMENT COMPENSE','DST GERMANY','ALIMENTATION SPENDESK',
        'DEBIT MENSUEL CARTE BLEUE','APPRO SPDSK','APPRO PENNY','TRESORERIE','REGUL','REGULARISATION',
        'TRESORERIE','REGULARISATION','AMERICAN EXPRESS CARTE','AMERICAN EXPRESS CARTE-FRANCE',
    ];

    const BANQUES_DETTES_KEYS = [
        'FRAIS VIREMENT',"FRAIS AVIS D'OPERE",'DOMICILIATION INCOMPLETE','DONT HORS TAXE','COMMISSION',
        'COMMISSIONS','PRET','INTERETS','INTERET','BPIFRANCE FINANCEMENT','TRANSACTION CARTE',
        'FRAIS DE CHANGE','CARD TRANSACTION IN FOREIGN CURRENCY','COTISATION MULTIPRO','ECART RAPPRO',
        'BPIFRANCE','CHEQUE IMPAYE','COTISATION','FRAIS BANCAIRE','FRAIS DE TENUE','FRAIS DE GESTION','INTERETS','SWAN - TRANSACTION',
    ];

    const FGS_KEYS = [
        'ORANGE','FREE','AMAZON PAYMENTS','LA POSTE','ENDESA ENERGIA','EDF','ENGIE','GRDF','AMAZON EU SARL','AMZN',
        'NESPRESSO','CULLIGAN','KAWA','ARVAL SERVICE LEASE','CREDIPAR','MAILEVA','GSF.PROPRETE','GSF GRANDE ARCHE',
        'CIAMT','CAR WASH','VINCI','ELF','ALIEXPRESS','ALIMENTATION','ALLENBY','ALLISON PNEUS','AMAZON PRIME',
        'AMAZON.FR*','AUTOROUTE','AUCHAN','BNP PARIBAS LEASE','CARREFOUR','CHRONOPOST','COFIROUTE','COPY TOP',
        'E.LECLERC','EASY CHARGE','ESSO','FNAC','FORF P.STAT','FRANPRIX','GARAGE','MAXSOCIETE','IKEA','INDIGO',
        'LEBONCOIN','LETTRE24','EVCHARGE','OBJETRAMA','RAKUTEN','ROXY COPY','ROX COPY','SAPN','AMENDE','SACEF',
        'CRECHE','LE VERGER DE GALLY','SNP*MLG EVENTS','CARROSSERIE','AUTOMOBILES','VISTAPRINT','IMPRIMERIE',
    ];

    const NOTES_FRAIS_KEYS = [
        'SNCF-VOYAGEURS','HOTEL','AIRBNB','UBER','NOTES DE FRAIS','RESTAURANT','RESTAURANTS','TRANSPORT',
        'DELIVEROO','DAILY DEFENSE','IBIS','TOUR I','SERVICE NAVIGO','YBRY KASH','LIORIM','MAIRIE DE PARIS',
        'LE BAZAR','W.A.X','SUPERMARCHE','TAXI','POLLY MAGGO','FONDUE ZHANGGE','1ERE CLASSE','API RESTAURATION',
        'AFILAL LARBI','API 01161','ASTERIX','ASIATI K','ATELIERNIEL','AU DELICE','AYEL','BABAIT','BASSAR',
        'BBV-MEATPACKING','BEKEF','BELIB','BENSON KFE','BILLY','BIOBURGER','BOMB SQUAD','BOOKING.COM',
        'BOUCHERIE','BOULANGERIE','BP DAC','BP PUTEAUX','BURGER KING','CAFE HOCHE','BUDDIE','CANOE','RESTO',
        'CHARLES PATISSI','CERTAS','CHEZ INOUN','CHEZ FRANCK','CHOCOLAT','INTERFLORA','COMMANDE','SUSHI',
        'CTOIR PRINCIPAL','CT PAY','COUT ESPLANADE','DAMYEL','DAV AND JO','DECATHLON','DELICES D\'ASNIE',
        'DELMAMA','DIFFORT','DIVAN DU MONDE','DORON NIEL','DORON SPONTINI','DS CAFE DEFENSE','EL AL','ENVATO',
        'EUROPCAR','VEVOR','FRAISE D AMOUR','FUNBOOKER','GETAROUND','GRAMI','GRILL BAR','HC MONTEVIDEO',
        'RESTAURATIO','HYPER BOULOGNE','IL CONTE','IOSSA','JACOB MEATPACKE','JEFF DE BRUGES','JEYM',
        'JETBRAINS','KAHN FAMOUS DEL','KANTEEN','KAVOD','KEOLIS LYON','KING DAVID','KOOKIE PARIS','L ABREUVOIR',
        'L ATELIER DELI','L&L GEORGES','LA BELLE EPOQUE','LA CABANE','LA CREME DES','LA GARGAMELLE','LA RECREE',
        'LA VILLA K','L\'AS DU FALLAFE','LE DUPLEX','LE GAY LUSSAC','LE JULYANN','LE SAFRANE','LE STUDIO','LE XXV',
        'LE YAD','LES DELICES','LES GARCONS','LES ZOUZOUS','LEVAPARC','CAFFE','LIOR','LIVIO','LS MOMENTO',
        'LW-BILLETWEB','MAISON','MARCEAU RIVE','SANDWICH','MONDIAL RELAY','MOSES DELI','MSFT *','NYX*CASCADE',
        'NACHOS','OCTOPUSMIND','PIZZA','PAIN','OTTER*','P COMME PAPILLE','PAPA','VOYAGES','PARIS DEFENSE',
        'PAVILLON DU LAC','PHCIE','PHOTOMATON','POINCARE DISTRI','PICTO','PUB SAINT JOHN\'S','RATP','QPLD','RIMONE',
        'RODCHENKO','RNG26','ROSETTA','SABA','SARL DAV','SARL MAISON','MISTER GARDE','SENDINBLUE','SNCF',
        'STAT AVIA','STATPBPHONEVILL','SUMUP','TAMIN','TOTAL','UBR*','ZETTLE',
    ];

    const PREVOYANCE_KEYS = ['ABEILLE VIE','MALAKOFF HUMANIS','HENNER','AXA','ALLIANZ','GSA ASSURANCES','HUMANIS PREVOYANCE'];

    const SAAS_IT_KEYS = [
        'GOOGLE SERVICES','GSUITE','MICROSOFT','IONOS','AMAZON WEB SERVICES','NOTION LABS','ADOBE','OPENAI',
        'SNOWFLAKE','STAPE','STREAMYARD','FACTORIALHR','SUPERPROF','YOAST','WELCOME TO THE JUNGLE','CAPCUT',
        'SMSFACTOR','SEMRUSH','TRYHACKME','BALSAMIQ','CALENDLY','SERPAPI','CLAUDE.AI','PADDLE.NET','ARTIFEX',
        'TYPEFORM','MAKE.COM','RINGOVER','IMAGIFY','CRAZY EGG.COM','WIFIRST','APPLE.COM','UDEMY','INOREADER',
        'SCALEWAY','ZOOM','ABONNEMENT KASP','ADA4MONTH','AGICAP','ZAPIER','ASANA','ARTICULATE GLOBAL',
        'ATLASSIAN','AWS EMEA','BACK MARKET','MONDAY.COM','BOTPRESS.COM','BOONDMANAGER','BOTSPACE','CANVA',
        'CLASSMARKER','DARTY','DELL','DIGIREACH SOLUTIONS','GODADDY','DOCUSIGN','FISIO','FIVERR','FORMCRAFTS',
        'GITHUB','GOCARDLESS','GOOGLE CLOUD','ZOHO-INVOICE','HEYGEN TECHNOLOGY INC.','HUAWEI','HUBSPOT','KAHOOT!',
        'LEMLIST','LIVESTORM','MEETUP','METRICOOL.COM','MIDJOURNEY','OVH','PANDADOC','STRIPE','SAMSUNG',
        'SALESFORCE','SKILLABLE','SLACK','SURVICATE','SURVEYMONKEY','GOOGLE*CLOUD','LINKTREE','EDUSIGN','DATADOG',
        'YAMM','ONLINEFORMAPRO',
    ];

    const MKT_ACQ_KEYS = [
        'GOOGLE IRELAND','TIKTOK','CRITEO','LINKEDIN','META','FACEBOOK','INDEED','REDDIT','FACEBK',
        'LINKODY','GOOGLE *ADS','ADWORDS',
    ];

    const URSSAF_KEYS = ['URSSAF'];

    const PA_ACAD_KEYS = ['SORBONNE','DES MINES','MINES PARIS','MINES SAINT','PEARSON','GILMORE','EDITIONS ENI','BUREAU.VERITAS','UNIVERSITE','XVOUCHER'];

    const FF_GEN_KEYS = ['CONSEIL','CONSULTING','CABINET','COURTAGE'];

    const FF_SPECIFIC_KEYS = [
        'REEL ECH','SECHE ARTHUR','SLOAN','IT TRAININGS','AFRICAN DEVELOPMENT ENGINEERING','FCIT NEW GENERATION',
        'SECOPS GUARD SOLUTIONS','IT TRAININGS ETS','ICPF ECH','AGENCE KEACREA','NATHANIEL COHN','ATHLAN STEPHANIE',
        'RAMISARIJAONA','BE API','MEDIATION SOLUTION','PALOOMA','NGUETI MANFO','GHISLAINE BEN CHEMOUL',
        'ELBAZ RAPHAEL','MEVENGUE BERNARD',
    ];

    const REMBOURSEMENT_KEYS = ['RMBT','REMB','REMBOURSEMENT','RMB'];

    const SALAIRES_HINTS = ['INDEMN. KM.','INDEMNIT','SALAIRE'];
    const SALAIRES_REGEX_PID5 = /VIR\s*SEPA\s*EMIS\b.*?\/PID[:\s-]*\d{5}\b/i;

    const LOYERS_KEYS = ['SVENSKASAGAX','ESSET','KEY SENSE'];

    const AUTRES_IMPOTS_KEYS = ['CVAE','TAXE FONCIERE','CFE'];

    const FF_REGEX_PENNYLANE = /\bPENNYLANE-[A-Z0-9]+\b/;
    const FF_REGEX_PID_PENNYLANE = /\bPID\s+PENNYLANE/;

    // ── FILIZ special case ──
    function isFilizB2B(tiersNorm, libNorm) {
        return tiersNorm.includes('FILIZ') && !containsAnyDual(libNorm, OPCO_KEYS);
    }

    // ── Encaissements categorization ──
    function categoriseEnc(libNorm, tiersNorm) {
        const both = libNorm + ' || ' + tiersNorm;
        if (containsAnyDual(both, INTERCO_ENC_KEYS)) return ['Interco', 'Enc: Interco'];
        if (containsAnyDual(libNorm, OPCO_KEYS)) return ['OPCO', 'Enc: OPCO'];
        if (containsAnyDual(libNorm, CPF_KEYS)) return ['CPF', 'Enc: CPF'];
        if (containsAnyDual(libNorm, RECONV_KEYS)) return ['Reconversion', 'Enc: Reconversion'];
        if (containsAnyDual(both, B2B_EXTRA) || isFilizB2B(tiersNorm, libNorm)) return ['B2B', 'Enc: B2B'];
        if (containsAnyDual(libNorm, B2C_PSP) || looksLikePerson(libNorm) || looksLikePerson(tiersNorm)) return ['Financement personnel', 'Enc: Financement personnel'];
        if (containsAnyDual(libNorm, AUTRES_REV_KEYS)) return ['Autres revenus', 'Enc: Autres revenus'];
        return ['Autres revenus', 'Enc: Fallback'];
    }

    // ── Décaissements categorization ──
    function categoriseDec(libNorm) {
        // Priority: VIR SEPA EMIS ... /PID PENNYLANE → Formateurs / Freelances
        if (/VIR\s*SEPA\s*EMIS\b.*?\/PID\s+PENNYLANE/i.test(libNorm) || FF_REGEX_PID_PENNYLANE.test(libNorm))
            return ['Formateurs / Freelances', 'Dec: PID Pennylane'];
        if (containsAnyDual(libNorm, INTERCO_DEC_KEYS)) return ['Interco', 'Dec: Interco'];
        if (containsAnyDual(libNorm, NOTES_FRAIS_KEYS)) return ['Note de frais', 'Dec: Note de frais'];
        if (containsAnyDual(libNorm, BANQUES_DETTES_KEYS)) return ['Banques/Dettes', 'Dec: Banques/Dettes'];
        if (libNorm.includes('DGFIP') && (libNorm.includes('TS-') || libNorm.includes('TS1-')))
            return ['Taxe sur les salaires', 'Dec: DGFIP TS/TS1'];
        if (libNorm.includes('DGFIP') && libNorm.includes('PASDSN'))
            return ['Prélèvement à la source (PAS)', 'Dec: PAS'];
        if (containsAnyDual(libNorm, FGS_KEYS)) return ['Frais généraux & services', 'Dec: FGS'];
        if (containsAnyDual(libNorm, PREVOYANCE_KEYS)) return ['Prévoyance / Mutuelle', 'Dec: Prevoyance/Mutuelle'];
        if (libNorm.includes('PLUXEE')) return ['Ticket restaurant', 'Dec: Ticket restaurant'];
        if (containsAnyDual(libNorm, SAAS_IT_KEYS)) return ['SaaS/IT', 'Dec: SaaS/IT'];
        if (containsAnyDual(libNorm, MKT_ACQ_KEYS)) return ['Marketing & Acquisition', 'Dec: Marketing/Acquisition'];
        if (containsAnyDual(libNorm, URSSAF_KEYS)) return ['URSSAF', 'Dec: URSSAF'];
        if (containsAnyDual(libNorm, PA_ACAD_KEYS)) return ['Partenariat académique', 'Dec: Partenariat academique'];
        if (containsAnyDual(libNorm, FF_GEN_KEYS) || containsAnyDual(libNorm, FF_SPECIFIC_KEYS) ||
            FF_REGEX_PENNYLANE.test(libNorm) || FF_REGEX_PID_PENNYLANE.test(libNorm))
            return ['Formateurs / Freelances', 'Dec: Formateurs/Freelances'];
        if (containsAnyDual(libNorm, REMBOURSEMENT_KEYS)) return ['Remboursement', 'Dec: Remboursement'];
        if (containsAnyDual(libNorm, SALAIRES_HINTS) || SALAIRES_REGEX_PID5.test(libNorm))
            return ['Salaires', 'Dec: Salaires'];
        if (containsAnyDual(libNorm, LOYERS_KEYS)) return ['Loyers & charges', 'Dec: Loyers & charges'];
        if (containsAnyDual(libNorm, AUTRES_IMPOTS_KEYS)) return ['Autres impôts', 'Dec: Autres impots'];
        return ['DIVERS', 'Dec: Fallback'];
    }

    // ── Main categorization pipeline ──
    function categorizeAll(data) {
        // Step 1: baseline categorization
        data.forEach(row => {
            const libNorm = normUpper(row.libelle);
            const tiersNorm = normUpper(row.tiers);
            row._libNorm = libNorm;
            row._tiersNorm = tiersNorm;
            row.sens = row.montant > 0 ? 'Encaissement' : (row.montant < 0 ? 'Décaissement' : 'Neutre');

            // Skip manually reclassified rows
            if (row.manualCategory) {
                row.categorie = row.manualCategory;
                row.ruleHit = 'DQ: Reclassement manuel';
                return;
            }

            // Check learned categories (from previous manual categorizations)
            const learnedCat = findLearnedCategory(libNorm, row.sens);
            if (learnedCat) {
                row.categorie = learnedCat;
                row.manualCategory = learnedCat;
                row.ruleHit = 'Apprentissage automatique';
                return;
            }

            if (row.sens === 'Encaissement') {
                const [cat, rule] = categoriseEnc(libNorm, tiersNorm);
                row.categorie = cat;
                row.ruleHit = rule;
            } else if (row.sens === 'Décaissement') {
                const [cat, rule] = categoriseDec(libNorm);
                row.categorie = cat;
                row.ruleHit = rule;
            } else {
                row.categorie = 'Neutre';
                row.ruleHit = 'Neutre';
            }
        });

        // Step 2: Anti-regression — formes juridiques → B2B (enc only, sauf GOCARDLESS SAS)
        const formsRe = /\b(SAS|SARL|EURL|SA)\b/;
        const excRe = /GOCARDLESS\s+SAS/;
        data.forEach(row => {
            if (row.manualCategory) return;
            if (row.sens === 'Encaissement' && formsRe.test(row._libNorm) && !excRe.test(row._libNorm)) {
                row.categorie = 'B2B';
                row.ruleHit = 'Enc: Anti-reg formes juridiques';
            }
        });

        // Step 3: Post-fix rules
        const PRIORITY_CATS = new Set(['Interco', 'OPCO', 'CPF', 'Reconversion']);

        data.forEach(row => {
            if (row.manualCategory) return;
            if (row._libNorm.includes('TRESO')) {
                row.categorie = 'Interco';
                row.ruleHit = 'Post-fix: Interco (TRESO in Libelle)';
            }
        });

        data.forEach(row => {
            if (row.manualCategory) return;
            if (row.sens === 'Encaissement' && row._libNorm.includes('CA CONSUMER FINANCE')) {
                row.categorie = 'Financement personnel';
                row.ruleHit = 'Post-fix: Financement personnel (CA CONSUMER FINANCE)';
            }
        });

        data.forEach(row => {
            if (row.manualCategory) return;
            if (row.sens === 'Décaissement' &&
                (row._libNorm.includes('GOOGLE IRELAND') || row._libNorm.includes('ADWORDS') || row._libNorm.includes('GOOGLE *ADS'))) {
                row.categorie = 'Marketing & Acquisition';
                row.ruleHit = 'Post-fix: Marketing & Acquisition (Google/AdWords)';
            }
        });

        data.forEach(row => {
            if (row.manualCategory) return;
            if (row.sens === 'Encaissement' && !PRIORITY_CATS.has(row.categorie)) {
                const libUp = String(row._libNorm).toUpperCase();
                if (B2B_EXTRA.some(k => libUp.includes(k.toUpperCase()))) {
                    row.categorie = 'B2B';
                    row.ruleHit = 'Post-fix: Enc B2B (client markers v621h)';
                }
            }
        });

        data.forEach(row => {
            if (row.manualCategory) return;
            if (row._libNorm.includes('ONLINEFORMAPRO')) {
                row.categorie = 'SaaS/IT';
                row.ruleHit = 'Post-fix: SaaS/IT (ONLINEFORMAPRO)';
            }
        });

        data.forEach(row => {
            if (FF_REGEX_PID_PENNYLANE.test(row._libNorm)) {
                row.categorie = 'Formateurs / Freelances';
                row.manualCategory = '';
                row.ruleHit = 'Post-fix: FF (PID PENNYLANE)';
            }
        });

        // Step 3b: Annuaire officiel (cache) — reclasse les "Autres revenus" (fallback) :
        //          société commerciale → B2B ; aucune entité immatriculée → Financement personnel.
        //          Persistant : s'applique à chaque recatégorisation et aux imports suivants,
        //          sans réinterroger l'API.
        data.forEach(row => {
            if (row.manualCategory) return;
            if (row.sens === 'Encaissement' && row.categorie === 'Autres revenus' && row.ruleHit === 'Enc: Fallback') {
                const name = extractCompanyName(row);
                const hit = b2bRegistryCache[b2bCacheKey(name)];
                if (!hit) return;
                if (hit.isCompany) {
                    row.categorie = 'B2B';
                    row.ruleHit = 'Enc: B2B (annuaire officiel' + (hit.siren ? ' — SIREN ' + hit.siren : '') + ')';
                } else if (b2bApplyPersonal && hit.found === false && !looksLikeCompanyForm(name)) {
                    // Aucune entité immatriculée (pas de SIREN) → particulier finançant lui-même.
                    // Appliqué seulement après une détection MANUELLE (b2bApplyPersonal), jamais en auto-import.
                    row.categorie = 'Financement personnel';
                    row.ruleHit = 'Enc: Financement personnel (absent de l\'annuaire)';
                }
                // hit.found === true mais non commercial (public / association) → reste "Autres revenus"
            }
        });

        // Step 4: Type Financeur (enc only) — from DAX formula
        const INTERCO_FIN_KEYS = ['TRESO','TRESORERIE','AFORSSIC','FORSSIC','VIREMENT COMPENSE','DST GERMANY','APPRO','COMPTE PRO','PRELEVEMENT AUTOMATIQUE'];
        const PUBLIC_FIN_KEYS = ['OPCO','TRANSITIONS PRO','CAISSE DES DEPOTS','CPF','POLE EMPLOI','REGION','FRANCE TRAVAIL','VILLE','COMMUNE','METROPOLE'];
        const PUBLIC_CATS = new Set(['OPCO', 'CPF', 'Reconversion']);

        data.forEach(row => {
            if (row.sens !== 'Encaissement') { row.typeFinanceur = ''; return; }
            const lib = row._libNorm;
            // 1. Interco (prioritaire)
            if (containsAnyDual(lib, INTERCO_FIN_KEYS) || row.categorie === 'Interco') {
                row.typeFinanceur = 'Interco';
                return;
            }
            // 2. Public
            if (containsAnyDual(lib, PUBLIC_FIN_KEYS) || PUBLIC_CATS.has(row.categorie)) {
                row.typeFinanceur = 'Public';
                return;
            }
            // 3. Privé (par défaut)
            row.typeFinanceur = 'Privé';
        });

        // Step 5: Mode de paiement (enc only) — from DAX formula
        data.forEach(row => {
            if (row.sens !== 'Encaissement') { row.modePaiement = ''; return; }
            const lib = row._libNorm;
            if (lib.includes('ALMA')) { row.modePaiement = 'Alma'; return; }
            if (lib.includes('GO CARDLESS') || lib.includes('GOCARDLESS')) { row.modePaiement = 'GoCardless'; return; }
            if (lib.includes('STRIPE')) { row.modePaiement = 'Stripe'; return; }
            if (lib.includes('SOFINCO')) { row.modePaiement = 'Sofinco'; return; }
            if (lib.includes('CPF')) { row.modePaiement = 'CPF'; return; }
            if (lib.includes('PAYPAL')) { row.modePaiement = 'PayPal'; return; }
            row.modePaiement = 'Virement';
        });
    }

    // ══════════════════════════════════════════════
    //  COLUMN MAPPING
    // ══════════════════════════════════════════════

    const COL_MAP = {
        date: ['date'],
        mois: ['mois'],
        compte: ['compte bancaire', 'compte', 'bank account'],
        libelle: ['libellé', 'libelle', 'label', 'description'],
        montant: ['montant', 'amount'],
        tiers: ['tiers', 'third party', 'vendor', 'nom du tiers'],
        justifie: ['justifié', 'justifie', 'justified'],
        commentaires: ['commentaires', 'comments'],
        etat: ['état', 'etat', 'status'],
        type: ['type'],
        equipe: ['equipe', 'équipe', 'team'],
        pl_liora: ['p&l liora', 'p&l_liora', 'pl liora', 'pnl liora'],
        pl_omnes: ['p&l omnes', 'p&l_omnes', 'pl omnes', 'pnl omnes'],
        projets: ['projets', 'projects'],
        titulaire: ['titulaire de la carte', 'titulaire', 'card holder'],
        nom_carte: ['nom de la carte', 'nom carte', 'card name'],
    };

    function mapColumns(headers) {
        const mapping = {};
        const lowerHeaders = headers.map((h) => h.trim().toLowerCase());

        for (const [key, aliases] of Object.entries(COL_MAP)) {
            const idx = lowerHeaders.findIndex((h) => aliases.some((a) => h.includes(a)));
            if (idx !== -1) mapping[key] = headers[idx];
        }
        return mapping;
    }

    // ══════════════════════════════════════════════
    //  FILE UPLOAD
    // ══════════════════════════════════════════════

    const uploadZone = $('#upload-zone');
    const fileInput = $('#file-input');

    uploadZone.addEventListener('click', () => fileInput.click());
    uploadZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadZone.classList.add('dragover');
    });
    uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('dragover'));
    uploadZone.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadZone.classList.remove('dragover');
        if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
    });
    fileInput.addEventListener('change', () => {
        if (fileInput.files.length) handleFile(fileInput.files[0]);
    });

    function handleFile(file) {
        const ext = file.name.split('.').pop().toLowerCase();
        if (!['csv', 'xlsx', 'xls'].includes(ext)) {
            alert('Format non supporté. Veuillez importer un fichier .csv, .xlsx ou .xls');
            return;
        }

        $('#file-name').textContent = file.name;
        $('#file-size').textContent = formatFileSize(file.size);
        $('#file-info').classList.remove('hidden');
        window._selectedFile = file;
    }

    $('#analyze-btn').addEventListener('click', () => {
        if (window._selectedFile) processFile(window._selectedFile);
    });

    function formatFileSize(bytes) {
        if (bytes < 1024) return bytes + ' o';
        if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' Ko';
        return (bytes / 1048576).toFixed(1) + ' Mo';
    }

    function showScreen(name) {
        Object.values(screens).forEach((s) => s.classList.remove('active'));
        screens[name].classList.add('active');
    }

    // ══════════════════════════════════════════════
    //  FILE PROCESSING
    // ══════════════════════════════════════════════

    function processFile(file) {
        showScreen('loading');
        const ext = file.name.split('.').pop().toLowerCase();

        if (ext === 'csv') {
            Papa.parse(file, {
                header: true,
                skipEmptyLines: true,
                encoding: 'UTF-8',
                complete: (result) => {
                    setTimeout(() => parseAndAnalyze(result.data, result.meta.fields, file.name), 500);
                },
                error: () => {
                    alert('Erreur lors de la lecture du fichier CSV.');
                    showScreen('upload');
                },
            });
        } else {
            const reader = new FileReader();
            reader.onload = (e) => {
                try {
                    const workbook = XLSX.read(e.target.result, { type: 'array' });
                    const sheet = workbook.Sheets[workbook.SheetNames[0]];
                    const json = XLSX.utils.sheet_to_json(sheet, { defval: '' });
                    const headers = json.length > 0 ? Object.keys(json[0]) : [];
                    setTimeout(() => parseAndAnalyze(json, headers, file.name), 500);
                } catch {
                    alert('Erreur lors de la lecture du fichier Excel.');
                    showScreen('upload');
                }
            };
            reader.readAsArrayBuffer(file);
        }
    }

    async function parseAndAnalyze(data, headers, fileName) {
        $('#loader-status').textContent = 'Analyse des données...';

        const colMap = mapColumns(headers);
        const newRows = data.map((row) => {
            const montantRaw = row[colMap.montant] || '0';
            const montant = parseFloat(
                String(montantRaw).replace(/\s/g, '').replace(',', '.')
            ) || 0;

            const dateRaw = row[colMap.date] || '';
            const parsedDate = parseDate(dateRaw);

            return {
                date: parsedDate,
                dateStr: formatDate(parsedDate),
                mois: row[colMap.mois] || '',
                compte: row[colMap.compte] || '',
                libelle: row[colMap.libelle] || '',
                montant,
                tiers: row[colMap.tiers] || '',
                justifie: row[colMap.justifie] || '',
                commentaires: row[colMap.commentaires] || '',
                etat: row[colMap.etat] || '',
                type: row[colMap.type] || '',
                equipe: row[colMap.equipe] || '',
                pl_liora: row[colMap.pl_liora] || '',
                pl_omnes: row[colMap.pl_omnes] || '',
                projets: row[colMap.projets] || '',
                titulaire: row[colMap.titulaire] || '',
                nom_carte: row[colMap.nom_carte] || '',
                categorie: '',
                ruleHit: '',
                sens: '',
                typeFinanceur: '',
                modePaiement: '',
            };
        });

        // Merge with existing historical data (async)
        const existingData = await loadFromStorage();
        if (existingData.length > 0) {
            rawData = existingData;
        } else {
            rawData = [];
        }

        const added = mergeData(rawData, newRows);

        // Run categorization on ALL data
        $('#loader-status').textContent = 'Catégorisation des transactions...';
        await new Promise(r => setTimeout(r, 100)); // allow UI update
        await loadLearnedCategories();
        await loadB2BCache();
        await loadCashBalance();
        categorizeAll(rawData);

        // Save merged data + file history
        $('#loader-status').textContent = 'Sauvegarde des données...';
        const saved = await saveToStorage();
        if (saved) await addFileHistory(fileName || 'fichier', added);

        filteredData = [...rawData];

        $('#loader-status').textContent = `Génération du tableau de bord... (${added} nouvelles lignes ajoutées)`;
        await new Promise(r => setTimeout(r, 100)); // allow UI update
        buildDashboard();
        await renderFileHistory();
        showScreen('dashboard');
        // Option : reconnaissance B2B automatique à l'import (annuaire) — B2B uniquement
        try {
            if ((await idbGet(STORAGE_AUTO_B2B_KEY)) === true) await autoDetectB2BOnImport();
        } catch { /* ignore */ }
    }

    function parseDate(str) {
        if (!str) return new Date(0);
        const s = String(str).trim();
        const dmy = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
        if (dmy) return new Date(+dmy[3], +dmy[2] - 1, +dmy[1]);
        const ymd = s.match(/^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})$/);
        if (ymd) return new Date(+ymd[1], +ymd[2] - 1, +ymd[3]);
        if (/^\d+$/.test(s)) {
            const num = parseInt(s, 10);
            if (num > 40000 && num < 60000) return new Date((num - 25569) * 86400 * 1000);
        }
        return new Date(s);
    }

    function formatDate(d) {
        if (!d || isNaN(d.getTime())) return '—';
        return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
    }

    // ══════════════════════════════════════════════
    //  CROSS-FILTER STATE
    // ══════════════════════════════════════════════

    const crossFilter = {
        categorie: null,   // from doughnut clicks
        sens: null,        // 'Encaissement' or 'Décaissement'
        month: null,       // 'YYYY-MM' from flow chart click
        months: null,      // Set of 'YYYY-MM' from date filter bar (null = all selected)
        equipe: null,      // from teams chart click
        financeur: null,   // 'Interco', 'Public', 'Privé' from financeur chart
        paiement: null,    // 'Alma', 'GoCardless', 'Stripe', etc.
        search: '',        // from search input
        typeDropdown: '',  // from type select
        teamDropdown: '',  // from team select
        catDropdown: '',   // from category select
        excludeInterco: false, // toggle to hide Interco transactions
    };

    function getMonthKey(r) {
        if (!r.date || isNaN(r.date.getTime())) return null;
        return r.date.getFullYear() + '-' + String(r.date.getMonth() + 1).padStart(2, '0');
    }

    function computeFilteredData() {
        filteredData = rawData.filter(r => {
            if (crossFilter.excludeInterco && r.categorie === 'Interco') return false;
            if (crossFilter.categorie && r.categorie !== crossFilter.categorie) return false;
            if (crossFilter.sens && r.sens !== crossFilter.sens) return false;
            if (crossFilter.month && getMonthKey(r) !== crossFilter.month) return false;
            if (crossFilter.months && !crossFilter.months.has(getMonthKey(r))) return false;
            if (crossFilter.financeur && r.typeFinanceur !== crossFilter.financeur) return false;
            if (crossFilter.paiement && r.modePaiement !== crossFilter.paiement) return false;
            if (crossFilter.equipe) {
                const team = r.equipe && r.equipe.trim() ? r.equipe.trim() : 'Non attribué';
                if (team !== crossFilter.equipe) return false;
            }
            if (crossFilter.typeDropdown && r.type !== crossFilter.typeDropdown) return false;
            if (crossFilter.teamDropdown && r.equipe !== crossFilter.teamDropdown) return false;
            if (crossFilter.catDropdown && r.categorie !== crossFilter.catDropdown) return false;
            if (crossFilter.search) {
                const s = crossFilter.search;
                const searchable = [r.libelle, r.tiers, r.nom_carte, r.titulaire, r.equipe, r.type, r.categorie]
                    .join(' ').toLowerCase();
                if (!searchable.includes(s)) return false;
            }
            return true;
        });
    }

    function toggleCrossFilter(key, value) {
        if (crossFilter[key] === value) {
            crossFilter[key] = null; // deselect
        } else {
            crossFilter[key] = value;
        }
        refreshDashboard();
    }

    function clearAllCrossFilters() {
        crossFilter.categorie = null;
        crossFilter.sens = null;
        crossFilter.month = null;
        crossFilter.equipe = null;
        crossFilter.financeur = null;
        crossFilter.paiement = null;
        crossFilter.excludeInterco = false;
        // Note: months (date bar) is NOT cleared by "Tout effacer" — it's a separate persistent filter
        refreshDashboard();
    }

    function hasCrossFilters() {
        return crossFilter.categorie || crossFilter.sens || crossFilter.month || crossFilter.equipe || crossFilter.financeur || crossFilter.paiement || crossFilter.excludeInterco;
    }

    function renderFilterChips() {
        const container = $('#active-filters');
        if (!hasCrossFilters()) {
            container.classList.add('hidden');
            return;
        }
        container.classList.remove('hidden');

        const labels = { categorie: 'Catégorie', sens: 'Sens', month: 'Mois', equipe: 'Équipe', financeur: 'Financeur', paiement: 'Paiement' };
        let html = '<span class="filter-chip-label">Filtres actifs :</span>';

        for (const key of ['categorie', 'sens', 'month', 'equipe', 'financeur', 'paiement']) {
            if (!crossFilter[key]) continue;
            let display = crossFilter[key];
            if (key === 'month') {
                const [y, m] = display.split('-');
                display = new Date(+y, +m - 1).toLocaleDateString('fr-FR', { month: 'short', year: 'numeric' });
            }
            html += `<span class="filter-chip">${labels[key]}: ${escapeHtml(display)}<span class="filter-chip-close" data-key="${key}">&times;</span></span>`;
        }

        if (crossFilter.excludeInterco) {
            html += `<span class="filter-chip">Hors Interco<span class="filter-chip-close" data-key="excludeInterco">&times;</span></span>`;
        }

        html += '<button class="filter-clear-all">Tout effacer</button>';
        container.innerHTML = html;

        container.querySelectorAll('.filter-chip-close').forEach(el => {
            el.addEventListener('click', () => {
                const k = el.dataset.key;
                if (k === 'excludeInterco') {
                    crossFilter.excludeInterco = false;
                    updateIntercoButtonState();
                } else {
                    crossFilter[k] = null;
                }
                refreshDashboard();
            });
        });
        const clearBtn = container.querySelector('.filter-clear-all');
        if (clearBtn) clearBtn.addEventListener('click', clearAllCrossFilters);
    }

    // ── Date Filter Bar ──
    let allMonthKeys = []; // populated from rawData

    function buildDateFilter() {
        const monthSet = new Set();
        rawData.forEach(r => {
            const mk = getMonthKey(r);
            if (mk) monthSet.add(mk);
        });
        allMonthKeys = [...monthSet].sort();

        renderDateFilterButtons();
    }

    function renderDateFilterButtons() {
        const container = $('#date-filter-months');
        if (!container) return;
        container.innerHTML = '';

        allMonthKeys.forEach(mk => {
            const [y, m] = mk.split('-');
            const label = new Date(+y, +m - 1).toLocaleDateString('fr-FR', { month: 'short', year: '2-digit' });
            const btn = document.createElement('button');
            btn.className = 'date-month-btn';
            btn.dataset.month = mk;
            btn.textContent = label;

            // Active state: selected if months is null (all) or includes this month
            if (!crossFilter.months || crossFilter.months.has(mk)) {
                btn.classList.add('active');
            }

            btn.addEventListener('click', () => toggleDateMonth(mk));
            container.appendChild(btn);
        });
    }

    function toggleDateMonth(mk) {
        // If currently null (all selected), switch to "all except this one"
        if (!crossFilter.months) {
            crossFilter.months = new Set(allMonthKeys);
            crossFilter.months.delete(mk);
        } else if (crossFilter.months.has(mk)) {
            crossFilter.months.delete(mk);
        } else {
            crossFilter.months.add(mk);
        }

        // If all selected again, set back to null
        if (crossFilter.months.size === allMonthKeys.length) {
            crossFilter.months = null;
        }
        // If none selected, keep empty set (will show no data)

        renderDateFilterButtons();
        refreshDashboard();
    }

    $('#date-select-all').addEventListener('click', () => {
        crossFilter.months = null;
        renderDateFilterButtons();
        refreshDashboard();
    });

    $('#date-select-none').addEventListener('click', () => {
        crossFilter.months = new Set();
        renderDateFilterButtons();
        refreshDashboard();
    });

    function updateIntercoButtonState() {
        const btn = $('#btn-exclude-interco');
        if (!btn) return;
        btn.classList.toggle('active', crossFilter.excludeInterco);
    }

    $('#btn-exclude-interco').addEventListener('click', () => {
        crossFilter.excludeInterco = !crossFilter.excludeInterco;
        updateIntercoButtonState();
        refreshDashboard();
    });

    // ══════════════════════════════════════════════
    //  DASHBOARD BUILDER
    // ══════════════════════════════════════════════

    function buildDashboard() {
        populateFilters();
        buildDateFilter();
        refreshDashboard();
    }

    function refreshDashboard() {
        computeFilteredData();
        currentPage = 1;
        renderFilterChips();
        renderKPIs();
        renderRunway();
        renderFlowChart();
        renderCumulativeChart();
        renderEncCategoriesChart();
        renderDecCategoriesChart();
        renderFinanceurChart();
        renderFinanceurMonthlyChart();
        renderPaiementChart();
        renderFixedVariable();
        renderTopVendorsChart();
        renderTeamsChart();
        renderTable();
        renderSummary();
    }

    // ── KPIs (use filteredData) ──
    function renderKPIs() {
        const data = filteredData;
        const inflows = data.filter(r => r.montant > 0).reduce((s, r) => s + r.montant, 0);
        const outflows = data.filter(r => r.montant < 0).reduce((s, r) => s + r.montant, 0);
        const net = inflows + outflows;

        $('#kpi-inflows').textContent = formatCurrency(inflows);
        $('#kpi-inflows').className = 'kpi-value amount-positive';
        $('#kpi-outflows').textContent = formatCurrency(outflows);
        $('#kpi-outflows').className = 'kpi-value amount-negative';
        $('#kpi-net').textContent = formatCurrency(net);
        $('#kpi-net').className = 'kpi-value ' + (net >= 0 ? 'amount-positive' : 'amount-negative');
        $('#kpi-count').textContent = data.length.toLocaleString('fr-FR');

        // Monthly totals for averages & volatility
        const monthlyInflows = {};
        const monthlyOutflows = {};
        data.forEach(r => {
            if (!r.date || isNaN(r.date.getTime())) return;
            const key = r.date.getFullYear() + '-' + String(r.date.getMonth() + 1).padStart(2, '0');
            if (r.montant > 0) monthlyInflows[key] = (monthlyInflows[key] || 0) + r.montant;
            if (r.montant < 0) monthlyOutflows[key] = (monthlyOutflows[key] || 0) + Math.abs(r.montant);
        });

        const inflowVals = Object.values(monthlyInflows);
        const outflowVals = Object.values(monthlyOutflows);
        const numMonths = Math.max(inflowVals.length, outflowVals.length, 1);

        // Average per month
        const avgInflows = inflowVals.length > 0 ? inflowVals.reduce((s, v) => s + v, 0) / inflowVals.length : 0;
        const avgOutflows = outflowVals.length > 0 ? outflowVals.reduce((s, v) => s + v, 0) / outflowVals.length : 0;
        $('#kpi-avg-inflows').textContent = formatCurrency(avgInflows);
        $('#kpi-avg-inflows').className = 'kpi-value amount-positive';
        $('#kpi-avg-outflows').textContent = formatCurrency(-avgOutflows);
        $('#kpi-avg-outflows').className = 'kpi-value amount-negative';

        // Volatility (coefficient of variation)
        function calcVolatility(values) {
            if (values.length < 2) return 0;
            const mean = values.reduce((s, v) => s + v, 0) / values.length;
            if (mean === 0) return 0;
            const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
            return (Math.sqrt(variance) / mean) * 100;
        }

        function applyVolatilityStyle(el, pct) {
            el.textContent = pct.toFixed(1) + ' %';
            if (pct < 10) {
                el.className = 'kpi-value';
                el.style.color = '#84cc16';
            } else if (pct <= 30) {
                el.className = 'kpi-value';
                el.style.color = '#f59e0b';
            } else {
                el.className = 'kpi-value';
                el.style.color = '#ef4444';
            }
        }

        applyVolatilityStyle($('#kpi-vol-inflows'), calcVolatility(inflowVals));
        applyVolatilityStyle($('#kpi-vol-outflows'), calcVolatility(outflowVals));

        const dates = data.map(r => r.date).filter(d => d && !isNaN(d.getTime()));
        if (dates.length > 0) {
            const minDate = new Date(Math.min(...dates));
            const maxDate = new Date(Math.max(...dates));
            $('#period-badge').textContent =
                minDate.toLocaleDateString('fr-FR', { month: 'short', year: 'numeric' }) + ' → ' +
                maxDate.toLocaleDateString('fr-FR', { month: 'short', year: 'numeric' });
        }
    }

    function formatCurrency(val) {
        return new Intl.NumberFormat('fr-FR', {
            style: 'currency', currency: 'EUR',
            minimumFractionDigits: 0, maximumFractionDigits: 0,
        }).format(val);
    }

    // ── Chart Defaults — Dark Navy palette ──
    const chartColors = {
        indigo: '#6366f1', blue: '#3b82f6', lime: '#84cc16', coral: '#F47458',
        amber: '#f59e0b', cyan: '#06b6d4', pink: '#ec4899', purple: '#8b5cf6',
        teal: '#14b8a6', orange: '#f97316', green: '#10b981', rose: '#f43f5e',
        sky: '#38bdf8', fuchsia: '#d946ef', emerald: '#34d399', yellow: '#eab308',
    };
    const paletteArray = Object.values(chartColors);

    // Extended palette for treemaps — navy/indigo base + varied accents
    const treemapPalette = [
        '#1e2a5e', '#2a3a80', '#3b4fa0', '#4f62b8', '#6474cc', '#7c8ae0',
        '#F47458', '#f59e0b', '#84cc16', '#3b82f6', '#8b5cf6', '#06b6d4',
        '#ec4899', '#14b8a6', '#ef4444', '#f97316', '#6366f1', '#d946ef',
        '#10b981', '#38bdf8', '#eab308', '#f43f5e', '#22d3ee', '#a855f7',
    ];

    function getChartDefaults() {
        return {
            responsive: true, maintainAspectRatio: false,
            plugins: {
                legend: { labels: { color: '#8b92a5', font: { family: 'Inter', size: 12 }, padding: 16 } },
                tooltip: {
                    backgroundColor: 'rgba(11, 14, 26, 0.95)', titleColor: '#eef0f6', bodyColor: '#8b92a5',
                    borderColor: 'rgba(99, 102, 241, 0.15)', borderWidth: 1, cornerRadius: 6, padding: 12,
                    titleFont: { family: 'Inter', weight: '600' }, bodyFont: { family: 'Inter' },
                    callbacks: { label: (ctx) => { const val = ctx.parsed.y ?? ctx.parsed; return ctx.dataset.label + ': ' + formatCurrency(val); } },
                },
            },
            scales: {
                x: { ticks: { color: '#555d75', font: { family: 'Inter', size: 11 } }, grid: { color: 'rgba(99, 102, 241, 0.06)' } },
                y: { ticks: { color: '#555d75', font: { family: 'Inter', size: 11 }, callback: (v) => formatCurrency(v) }, grid: { color: 'rgba(99, 102, 241, 0.06)' } },
            },
        };
    }

    function getDoughnutOptions() {
        return {
            responsive: true, maintainAspectRatio: false, cutout: '55%',
            plugins: {
                legend: { position: 'right', labels: { color: '#8b92a5', font: { family: 'Inter', size: 11 }, padding: 10, boxWidth: 12, boxHeight: 12, borderRadius: 3 } },
                tooltip: {
                    backgroundColor: 'rgba(11, 14, 26, 0.95)', titleColor: '#eef0f6', bodyColor: '#8b92a5',
                    borderColor: 'rgba(99, 102, 241, 0.15)', borderWidth: 1, cornerRadius: 6, padding: 12,
                    callbacks: { label: (ctx) => { const total = ctx.dataset.data.reduce((s, v) => s + v, 0); const pct = ((ctx.parsed / total) * 100).toFixed(1); return ctx.label + ': ' + formatCurrency(ctx.parsed) + ' (' + pct + '%)'; } },
                },
            },
        };
    }

    function destroyChart(key) {
        if (charts[key]) { charts[key].destroy(); charts[key] = null; }
    }

    // ── Aggregate helpers (all use filteredData) ──
    function aggregateByMonth() {
        const months = {};
        filteredData.forEach(r => {
            if (!r.date || isNaN(r.date.getTime())) return;
            const key = getMonthKey(r);
            if (!months[key]) months[key] = { inflows: 0, outflows: 0 };
            if (r.montant > 0) months[key].inflows += r.montant;
            else months[key].outflows += r.montant;
        });
        const keys = Object.keys(months).sort();
        return {
            keys,
            labels: keys.map(k => { const [y, m] = k.split('-'); return new Date(+y, +m - 1).toLocaleDateString('fr-FR', { month: 'short', year: 'numeric' }); }),
            inflows: keys.map(k => months[k].inflows),
            outflows: keys.map(k => Math.abs(months[k].outflows)),
            net: keys.map(k => months[k].inflows + months[k].outflows),
        };
    }

    function aggregateByCategorie(sens) {
        const cats = {};
        filteredData.filter(r => r.sens === sens).forEach(r => {
            const cat = r.categorie || 'Non catégorisé';
            cats[cat] = (cats[cat] || 0) + Math.abs(r.montant);
        });
        const sorted = Object.entries(cats).sort((a, b) => b[1] - a[1]);
        return { labels: sorted.map(([k]) => k), values: sorted.map(([, v]) => v) };
    }

    // ── Flow Chart — clickable bars select a month ──
    function renderFlowChart() {
        const data = aggregateByMonth();
        destroyChart('flow');
        const ctx = $('#chart-flow').getContext('2d');
        const defaults = getChartDefaults();

        // Highlight selected month
        const selectedIdx = crossFilter.month ? data.keys.indexOf(crossFilter.month) : -1;
        const encBg = data.inflows.map((_, i) => i === selectedIdx ? 'rgba(132, 204, 22, 1)' : 'rgba(132, 204, 22, 0.7)');
        const decBg = data.outflows.map((_, i) => i === selectedIdx ? 'rgba(99, 102, 241, 1)' : 'rgba(99, 102, 241, 0.7)');

        charts.flow = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: data.labels,
                datasets: [
                    { label: 'Encaissements', data: data.inflows, backgroundColor: encBg, borderColor: '#84cc16', borderWidth: 1, borderRadius: 3 },
                    { label: 'Décaissements', data: data.outflows, backgroundColor: decBg, borderColor: '#6366f1', borderWidth: 1, borderRadius: 3 },
                    { label: 'Solde net', data: data.net, type: 'line', borderColor: '#F47458', backgroundColor: 'rgba(244, 116, 88, 0.08)', borderWidth: 2, pointRadius: 4, pointBackgroundColor: '#F47458', tension: 0.3, fill: true },
                ],
            },
            options: {
                ...defaults,
                interaction: { intersect: false, mode: 'index' },
                onClick: (evt, elements) => {
                    if (!elements.length) return;
                    const idx = elements[0].index;
                    toggleCrossFilter('month', data.keys[idx]);
                },
                plugins: {
                    ...defaults.plugins,
                    tooltip: { ...defaults.plugins.tooltip, callbacks: { label: (ctx) => { const val = ctx.parsed.y; const prefix = ctx.datasetIndex === 1 ? '-' : ''; return ctx.dataset.label + ': ' + prefix + formatCurrency(Math.abs(val)); } } },
                },
            },
        });
    }

    // ── Cumulative Chart ──
    function renderCumulativeChart() {
        const data = aggregateByMonth();
        destroyChart('cumulative');
        let cumulative = 0;
        const cumData = data.net.map(v => { cumulative += v; return cumulative; });
        const ctx = $('#chart-cumulative').getContext('2d');
        const defaults = getChartDefaults();
        const gradient = ctx.createLinearGradient(0, 0, 0, 300);
        gradient.addColorStop(0, 'rgba(244, 116, 88, 0.2)');
        gradient.addColorStop(1, 'rgba(244, 116, 88, 0)');

        charts.cumulative = new Chart(ctx, {
            type: 'line',
            data: { labels: data.labels, datasets: [{ label: 'Solde cumulé', data: cumData, borderColor: '#F47458', backgroundColor: gradient, borderWidth: 2.5, fill: true, tension: 0.4, pointRadius: 4, pointBackgroundColor: '#F47458', pointBorderColor: '#0b0e1a', pointBorderWidth: 2 }] },
            options: {
                ...defaults,
                onClick: (evt, elements) => {
                    if (!elements.length) return;
                    toggleCrossFilter('month', data.keys[elements[0].index]);
                },
            },
        });
    }

    // ── Helper: build treemap config for a category chart ──
    function buildTreemapConfig(data, total, colorMap) {
        return {
            type: 'treemap',
            data: {
                datasets: [{
                    tree: data.labels.map((l, i) => ({ label: l, value: data.values[i] })),
                    key: 'value',
                    groups: ['label'],
                    backgroundColor: (c) => {
                        const d = c.raw;
                        if (!d || !d._data) return '#8b5cf6';
                        return colorMap[d._data.label] || '#8b5cf6';
                    },
                    borderColor: '#0b0e1a',
                    borderWidth: 3,
                    spacing: 2,
                    labels: {
                        display: true,
                        align: 'center',
                        position: 'middle',
                        overflow: 'fit',
                        color: '#ffffff',
                        font: { size: 12, weight: '700', family: 'Inter' },
                        formatter: (c) => {
                            const d = c.raw;
                            if (!d || !d._data) return '';
                            const pct = total > 0 ? ((d.v / total) * 100).toFixed(1) : 0;
                            return [d._data.label, Number(d.v).toLocaleString('fr-FR', { maximumFractionDigits: 0 }) + ' €', pct + '%'];
                        },
                    },
                }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false }, tooltip: {
                    callbacks: {
                        title: (items) => items[0]?.raw?._data?.label || '',
                        label: (item) => {
                            const v = item.raw.v;
                            const pct = total > 0 ? ((v / total) * 100).toFixed(1) : 0;
                            return v.toLocaleString('fr-FR', { maximumFractionDigits: 0 }) + ' € (' + pct + '%)';
                        },
                    },
                }},
                onClick: (evt, elements) => {
                    if (!elements.length) return;
                    const el = elements[0];
                    const label = el.element.$context?.raw?._data?.label;
                    if (label) toggleCrossFilter('categorie', label);
                },
            },
        };
    }

    // ── Enc categories — Treemap — click filters by category ──
    function renderEncCategoriesChart() {
        const data = aggregateByCategorie('Encaissement');
        destroyChart('encCategories');
        if (data.labels.length === 0) { $('#chart-enc-categories').getContext('2d').clearRect(0, 0, 9999, 9999); return; }
        const ctx = $('#chart-enc-categories').getContext('2d');
        const total = data.values.reduce((s, v) => s + v, 0);
        const colorMap = {};
        data.labels.forEach((l, i) => { colorMap[l] = treemapPalette[i % treemapPalette.length]; });
        charts.encCategories = new Chart(ctx, buildTreemapConfig(data, total, colorMap));
    }

    // ── Dec categories — Treemap — click filters by category ──
    function renderDecCategoriesChart() {
        const data = aggregateByCategorie('Décaissement');
        destroyChart('decCategories');
        if (data.labels.length === 0) { $('#chart-dec-categories').getContext('2d').clearRect(0, 0, 9999, 9999); return; }
        const ctx = $('#chart-dec-categories').getContext('2d');
        const total = data.values.reduce((s, v) => s + v, 0);
        const colorMap = {};
        data.labels.forEach((l, i) => { colorMap[l] = treemapPalette[i % treemapPalette.length]; });
        charts.decCategories = new Chart(ctx, buildTreemapConfig(data, total, colorMap));
    }

    // ── Type Financeur Chart (enc only) — Interco / Public / Privé ──
    const FINANCEUR_COLORS = {
        'Interco': '#F47458',  // coral
        'Public': '#3b82f6',   // blue
        'Privé': '#84cc16',    // lime
    };

    function renderFinanceurChart() {
        const financeurs = {};
        filteredData.filter(r => r.sens === 'Encaissement' && r.typeFinanceur).forEach(r => {
            financeurs[r.typeFinanceur] = (financeurs[r.typeFinanceur] || 0) + r.montant;
        });

        const order = ['Interco', 'Public', 'Privé'];
        const sorted = order.filter(k => financeurs[k]).map(k => [k, financeurs[k]]);

        destroyChart('financeur');
        if (sorted.length === 0) {
            const canvas = $('#chart-financeur');
            if (canvas) canvas.getContext('2d').clearRect(0, 0, 9999, 9999);
            return;
        }
        const ctx = $('#chart-financeur').getContext('2d');

        charts.financeur = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: sorted.map(([k]) => k),
                datasets: [{
                    data: sorted.map(([, v]) => v),
                    backgroundColor: sorted.map(([k]) => FINANCEUR_COLORS[k] || '#8b5cf6'),
                    borderColor: '#0b0e1a',
                    borderWidth: 2,
                    hoverOffset: 6,
                }],
            },
            options: {
                ...getDoughnutOptions(),
                onClick: (evt, elements) => {
                    if (!elements.length) return;
                    const label = sorted[elements[0].index][0];
                    toggleCrossFilter('financeur', label);
                },
            },
        });
    }

    // ── Financeur Monthly stacked bar chart ──
    function renderFinanceurMonthlyChart() {
        const months = {};
        filteredData.filter(r => r.sens === 'Encaissement' && r.typeFinanceur).forEach(r => {
            const mk = getMonthKey(r);
            if (!mk) return;
            if (!months[mk]) months[mk] = { Interco: 0, Public: 0, 'Privé': 0 };
            months[mk][r.typeFinanceur] += r.montant;
        });

        const keys = Object.keys(months).sort();
        const labels = keys.map(k => {
            const [y, m] = k.split('-');
            return new Date(+y, +m - 1).toLocaleDateString('fr-FR', { month: 'short', year: '2-digit' });
        });

        destroyChart('financeurMonthly');
        const ctx = $('#chart-financeur-monthly').getContext('2d');
        const defaults = getChartDefaults();

        charts.financeurMonthly = new Chart(ctx, {
            type: 'bar',
            data: {
                labels,
                datasets: [
                    { label: 'Interco', data: keys.map(k => months[k].Interco), backgroundColor: FINANCEUR_COLORS.Interco, borderRadius: 3 },
                    { label: 'Public', data: keys.map(k => months[k].Public), backgroundColor: FINANCEUR_COLORS.Public, borderRadius: 3 },
                    { label: 'Privé', data: keys.map(k => months[k]['Privé']), backgroundColor: FINANCEUR_COLORS['Privé'], borderRadius: 3 },
                ],
            },
            options: {
                ...defaults,
                scales: {
                    ...defaults.scales,
                    x: { ...defaults.scales.x, stacked: true },
                    y: { ...defaults.scales.y, stacked: true },
                },
                plugins: {
                    ...defaults.plugins,
                    legend: { ...defaults.plugins.legend, labels: { ...defaults.plugins.legend.labels, color: '#a5a0b8' } },
                },
                onClick: (evt, elements) => {
                    if (!elements.length) return;
                    toggleCrossFilter('month', keys[elements[0].index]);
                },
            },
        });
    }

    // ── Mode de paiement Chart (enc only) ──
    const PAIEMENT_COLORS = {
        'Alma': '#ec4899',      // pink
        'GoCardless': '#06b6d4', // cyan
        'Stripe': '#6366f1',    // indigo
        'Sofinco': '#f97316',   // orange
        'CPF': '#8b5cf6',       // purple
        'PayPal': '#3b82f6',    // blue
        'Virement': '#10b981',  // green
    };

    function renderPaiementChart() {
        const modes = {};
        filteredData.filter(r => r.sens === 'Encaissement' && r.modePaiement).forEach(r => {
            modes[r.modePaiement] = (modes[r.modePaiement] || 0) + r.montant;
        });

        const order = ['Alma', 'GoCardless', 'Stripe', 'Sofinco', 'CPF', 'PayPal', 'Virement'];
        const sorted = order.filter(k => modes[k]).map(k => [k, modes[k]]);

        destroyChart('paiement');
        if (sorted.length === 0) {
            const canvas = $('#chart-paiement');
            if (canvas) canvas.getContext('2d').clearRect(0, 0, 9999, 9999);
            return;
        }
        const ctx = $('#chart-paiement').getContext('2d');

        charts.paiement = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: sorted.map(([k]) => k),
                datasets: [{
                    data: sorted.map(([, v]) => v),
                    backgroundColor: sorted.map(([k]) => PAIEMENT_COLORS[k] || '#8b5cf6'),
                    borderColor: '#0b0e1a',
                    borderWidth: 2,
                    hoverOffset: 6,
                }],
            },
            options: {
                ...getDoughnutOptions(),
                onClick: (evt, elements) => {
                    if (!elements.length) return;
                    const label = sorted[elements[0].index][0];
                    toggleCrossFilter('paiement', label);
                },
            },
        });
    }

    // ── Décaissements fixes vs variables ──
    // Classification métier : catégories de charges récurrentes (fixes) vs dépendantes de
    // l'activité (variables). Interco = mouvements internes, présentés à part.
    const DEC_FIXED_CATS = new Set([
        'Salaires', 'URSSAF', 'Prélèvement à la source (PAS)', 'Taxe sur les salaires',
        'Prévoyance / Mutuelle', 'Ticket restaurant', 'Loyers & charges', 'SaaS/IT',
        'Banques/Dettes', 'Autres impôts',
    ]);
    function decFixedVarType(cat) {
        if (cat === 'Interco') return 'interco';
        return DEC_FIXED_CATS.has(cat) ? 'fixe' : 'variable';
    }

    function renderFixedVariable() {
        const el = document.getElementById('fixed-var-table');
        if (!el) return;
        const dec = filteredData.filter(r => r.sens === 'Décaissement');
        if (dec.length === 0) {
            el.innerHTML = '<p class="fv-empty">Aucun décaissement sur la période sélectionnée.</p>';
            return;
        }
        const byCat = {};
        dec.forEach(r => { byCat[r.categorie] = (byCat[r.categorie] || 0) + Math.abs(r.montant); });
        const total = Object.values(byCat).reduce((s, v) => s + v, 0);
        const groups = { fixe: [], variable: [], interco: [] };
        Object.entries(byCat).forEach(([cat, amt]) => groups[decFixedVarType(cat)].push({ cat, amt }));
        Object.values(groups).forEach(g => g.sort((a, b) => b.amt - a.amt));

        const pct = amt => total > 0 ? (amt / total * 100) : 0;
        const fmtPct = p => p.toFixed(1).replace('.', ',') + ' %';
        const sum = g => g.reduce((s, x) => s + x.amt, 0);

        function groupBlock(label, cls, g) {
            if (g.length === 0) return '';
            const sub = sum(g);
            const rows = g.map(x => `
                <tr class="fv-row">
                    <td class="fv-cat">${escapeHtml(x.cat)}</td>
                    <td class="text-right">${formatCurrency(x.amt)}</td>
                    <td class="text-right">${fmtPct(pct(x.amt))}</td>
                </tr>`).join('');
            return `
                <tr class="fv-group-head ${cls}">
                    <td>${label}</td>
                    <td class="text-right">${formatCurrency(sub)}</td>
                    <td class="text-right">${fmtPct(pct(sub))}</td>
                </tr>
                ${rows}`;
        }

        el.innerHTML = `
            <div class="fv-summary">
                <div class="fv-card fv-card-fixe">
                    <span class="fv-card-label">Décaissements fixes</span>
                    <span class="fv-card-value">${formatCurrency(sum(groups.fixe))}</span>
                    <span class="fv-card-pct">${fmtPct(pct(sum(groups.fixe)))} du total</span>
                </div>
                <div class="fv-card fv-card-variable">
                    <span class="fv-card-label">Décaissements variables</span>
                    <span class="fv-card-value">${formatCurrency(sum(groups.variable))}</span>
                    <span class="fv-card-pct">${fmtPct(pct(sum(groups.variable)))} du total</span>
                </div>
            </div>
            <div class="table-wrapper">
                <table class="data-table fv-table">
                    <thead>
                        <tr><th>Catégorie</th><th class="text-right">Montant</th><th class="text-right">% du total décaissements</th></tr>
                    </thead>
                    <tbody>
                        ${groupBlock('🔒 Décaissements fixes', 'fv-fixe', groups.fixe)}
                        ${groupBlock('📈 Décaissements variables', 'fv-variable', groups.variable)}
                        ${groupBlock('🔁 Interco (mouvements internes)', 'fv-interco', groups.interco)}
                        <tr class="fv-total">
                            <td>Total décaissements</td>
                            <td class="text-right">${formatCurrency(total)}</td>
                            <td class="text-right">100 %</td>
                        </tr>
                    </tbody>
                </table>
            </div>`;
    }

    // ── Trésorerie & runway ──
    let cashBalance = 0;
    async function loadCashBalance() {
        try { cashBalance = Number(await idbGet('liora_cash_balance')) || 0; } catch { cashBalance = 0; }
    }
    function renderRunway() {
        const el = document.getElementById('runway-body');
        if (!el) return;
        // Flux net mensuel moyen, hors Interco (mouvements internes) et hors lignes neutres
        const rows = filteredData.filter(r => r.categorie !== 'Interco' && r.sens !== 'Neutre');
        const byMonth = {};
        rows.forEach(r => { const k = getMonthKey(r); if (k) byMonth[k] = (byMonth[k] || 0) + r.montant; });
        const months = Object.keys(byMonth).sort();
        const n = months.length;
        const avgNet = n ? months.reduce((s, k) => s + byMonth[k], 0) / n : 0;
        const burning = avgNet < 0;

        let runwayHtml;
        if (!burning) {
            runwayHtml = `<div class="runway-metric runway-ok">
                <span class="runway-label">Runway</span>
                <span class="runway-value">Illimité</span>
                <span class="runway-sub">trésorerie excédentaire en moyenne</span></div>`;
        } else if (cashBalance > 0) {
            const monthsLeft = cashBalance / Math.abs(avgNet);
            const d = new Date(); d.setMonth(d.getMonth() + Math.floor(monthsLeft));
            const cls = monthsLeft < 3 ? 'runway-danger' : (monthsLeft < 6 ? 'runway-warn' : 'runway-ok');
            runwayHtml = `<div class="runway-metric ${cls}">
                <span class="runway-label">Runway estimé</span>
                <span class="runway-value">${monthsLeft.toFixed(1).replace('.', ',')} mois</span>
                <span class="runway-sub">≈ jusqu'à ${d.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })}</span></div>`;
        } else {
            runwayHtml = `<div class="runway-metric runway-warn">
                <span class="runway-label">Runway</span>
                <span class="runway-value">—</span>
                <span class="runway-sub">renseigne ta trésorerie actuelle pour l'estimer</span></div>`;
        }

        el.innerHTML = `
            <div class="runway-grid">
                <div class="runway-input-group">
                    <label for="runway-balance">Trésorerie actuelle (€)</label>
                    <input type="number" id="runway-balance" class="sim-input" value="${cashBalance}" step="1000">
                </div>
                <div class="runway-metric ${avgNet >= 0 ? 'runway-ok' : 'runway-danger'}">
                    <span class="runway-label">Flux net moyen</span>
                    <span class="runway-value">${formatCurrency(avgNet)}<span class="runway-unit"> / mois</span></span>
                    <span class="runway-sub">sur ${n} mois (hors Interco)</span>
                </div>
                ${runwayHtml}
            </div>`;
        const inp = document.getElementById('runway-balance');
        if (inp) inp.addEventListener('change', async () => {
            cashBalance = Number(inp.value) || 0;
            try { await idbSet('liora_cash_balance', cashBalance); } catch { /* ignore */ }
            renderRunway();
        });
    }

    // ── Volume by category (horizontal bar) — click filters ──
    function renderTopVendorsChart() {
        const cats = {};
        filteredData.forEach(r => {
            const cat = r.categorie || 'Non catégorisé';
            if (!cats[cat]) cats[cat] = { in: 0, out: 0 };
            if (r.montant > 0) cats[cat].in += r.montant;
            else cats[cat].out += Math.abs(r.montant);
        });

        const sorted = Object.entries(cats)
            .map(([name, v]) => ({ name, total: v.in + v.out, in: v.in, out: v.out }))
            .sort((a, b) => b.total - a.total).slice(0, 12);

        destroyChart('topVendors');
        const ctx = $('#chart-top-vendors').getContext('2d');
        const defaults = getChartDefaults();

        charts.topVendors = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: sorted.map(v => v.name),
                datasets: [
                    { label: 'Encaissements', data: sorted.map(v => v.in), backgroundColor: 'rgba(16, 185, 129, 0.7)', borderRadius: 4 },
                    { label: 'Décaissements', data: sorted.map(v => v.out), backgroundColor: 'rgba(239, 68, 68, 0.7)', borderRadius: 4 },
                ],
            },
            options: {
                ...defaults, indexAxis: 'y',
                onClick: (evt, elements) => {
                    if (!elements.length) return;
                    const label = sorted[elements[0].index].name;
                    toggleCrossFilter('categorie', label);
                },
                scales: {
                    ...defaults.scales,
                    x: { ...defaults.scales.x, ticks: { ...defaults.scales.x.ticks, callback: v => formatCurrency(v) } },
                    y: { ...defaults.scales.y, ticks: { color: '#a5a0b8', font: { family: 'Inter', size: 11 } }, grid: { display: false } },
                },
            },
        });
    }

    // ── Teams Chart — click filters by team ──
    function renderTeamsChart() {
        const teams = {};
        filteredData.forEach(r => {
            const team = r.equipe && r.equipe.trim() ? r.equipe.trim() : 'Non attribué';
            teams[team] = (teams[team] || 0) + Math.abs(r.montant);
        });

        const sorted = Object.entries(teams).sort((a, b) => b[1] - a[1]);
        destroyChart('teams');
        if (sorted.length === 0) return;
        const ctx = $('#chart-teams').getContext('2d');

        charts.teams = new Chart(ctx, {
            type: 'doughnut',
            data: { labels: sorted.map(([k]) => k), datasets: [{ data: sorted.map(([, v]) => v), backgroundColor: paletteArray.slice(0, sorted.length), borderColor: '#0b0e1a', borderWidth: 2 }] },
            options: {
                ...getDoughnutOptions(),
                onClick: (evt, elements) => {
                    if (!elements.length) return;
                    const label = sorted[elements[0].index][0];
                    toggleCrossFilter('equipe', label);
                },
            },
        });
    }

    // ══════════════════════════════════════════════
    //  TABLE
    // ══════════════════════════════════════════════

    function populateFilters() {
        const types = new Set(rawData.map(r => r.type).filter(Boolean));
        const teams = new Set(rawData.map(r => r.equipe).filter(Boolean));
        const categories = new Set(rawData.map(r => r.categorie).filter(Boolean));

        const typeSelect = $('#filter-type');
        typeSelect.innerHTML = '<option value="">Tous les types</option>';
        types.forEach(t => { typeSelect.innerHTML += `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`; });

        const teamSelect = $('#filter-team');
        teamSelect.innerHTML = '<option value="">Toutes les équipes</option>';
        teams.forEach(t => { teamSelect.innerHTML += `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`; });

        const catSelect = $('#filter-categorie');
        catSelect.innerHTML = '<option value="">Toutes les catégories</option>';
        [...categories].sort().forEach(c => { catSelect.innerHTML += `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`; });

        typeSelect.addEventListener('change', () => { crossFilter.typeDropdown = typeSelect.value; refreshDashboard(); });
        teamSelect.addEventListener('change', () => { crossFilter.teamDropdown = teamSelect.value; refreshDashboard(); });
        catSelect.addEventListener('change', () => { crossFilter.catDropdown = catSelect.value; refreshDashboard(); });
        $('#search-input').addEventListener('input', debounce(() => { crossFilter.search = $('#search-input').value.toLowerCase(); refreshDashboard(); }, 300));
    }

    function renderTable() {
        const tbody = $('#table-body');
        const start = (currentPage - 1) * PAGE_SIZE;
        const pageData = filteredData.slice(start, start + PAGE_SIZE);

        tbody.innerHTML = pageData.map(r => `
            <tr>
                <td>${escapeHtml(r.dateStr)}</td>
                <td title="${escapeHtml(r.libelle)}">${escapeHtml(truncate(r.libelle, 45))}</td>
                <td>${escapeHtml(r.tiers || '—')}</td>
                <td class="text-right ${r.montant >= 0 ? 'amount-positive' : 'amount-negative'}">${formatCurrency(r.montant)}</td>
                <td><span class="tag ${getCatTagClass(r.categorie)}" title="${escapeHtml(r.ruleHit)}">${escapeHtml(r.categorie || '—')}</span></td>
                <td><span class="tag tag-sens-${r.montant >= 0 ? 'enc' : 'dec'}">${r.montant >= 0 ? 'Enc' : 'Déc'}</span></td>
                <td>${escapeHtml(r.equipe || '—')}</td>
                <td>${escapeHtml(r.titulaire || '—')}</td>
            </tr>`
        ).join('');

        renderPagination();
    }

    function renderPagination() {
        const totalPages = Math.ceil(filteredData.length / PAGE_SIZE);
        const container = $('#pagination');
        if (totalPages <= 1) { container.innerHTML = ''; return; }

        let html = '';
        const maxVisible = 7;
        let startPage = Math.max(1, currentPage - Math.floor(maxVisible / 2));
        let endPage = Math.min(totalPages, startPage + maxVisible - 1);
        if (endPage - startPage < maxVisible - 1) startPage = Math.max(1, endPage - maxVisible + 1);

        if (currentPage > 1) html += `<button class="page-btn" data-page="${currentPage - 1}">&laquo;</button>`;
        for (let i = startPage; i <= endPage; i++)
            html += `<button class="page-btn ${i === currentPage ? 'active' : ''}" data-page="${i}">${i}</button>`;
        if (currentPage < totalPages) html += `<button class="page-btn" data-page="${currentPage + 1}">&raquo;</button>`;

        container.innerHTML = html;
        container.querySelectorAll('.page-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                currentPage = parseInt(btn.dataset.page, 10);
                renderTable();
                document.querySelector('.table-wrapper').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            });
        });
    }

    const CAT_COLOR_MAP = {
        'B2B': 'tag-b2b', 'Financement personnel': 'tag-b2c', 'Interco': 'tag-interco',
        'OPCO': 'tag-opco', 'CPF': 'tag-cpf', 'Reconversion': 'tag-reconv',
        'Salaires': 'tag-salaires', 'URSSAF': 'tag-urssaf',
        'SaaS/IT': 'tag-saas', 'Marketing & Acquisition': 'tag-mkt',
        'Formateurs / Freelances': 'tag-ff',
        'Frais généraux & services': 'tag-fgs', 'Note de frais': 'tag-ndf',
        'Banques/Dettes': 'tag-banques', 'Autres revenus': 'tag-autres-rev',
        'DIVERS': 'tag-divers',
    };

    function getCatTagClass(cat) { return CAT_COLOR_MAP[cat] || 'tag-default'; }

    // ══════════════════════════════════════════════
    //  SUMMARY (uses filteredData)
    // ══════════════════════════════════════════════

    function renderSummary() {
        const data = filteredData;

        const expensesByCat = {};
        data.filter(r => r.montant < 0).forEach(r => {
            const cat = r.categorie || 'Non catégorisé';
            expensesByCat[cat] = (expensesByCat[cat] || 0) + Math.abs(r.montant);
        });
        const topExpenses = Object.entries(expensesByCat).sort((a, b) => b[1] - a[1]).slice(0, 8);
        $('#summary-expenses').innerHTML = topExpenses.map(([name, val]) =>
            `<div class="summary-item"><span class="summary-item-label">${escapeHtml(name)}</span><span class="summary-item-value amount-negative">${formatCurrency(-val)}</span></div>`
        ).join('');

        const incomeByCat = {};
        data.filter(r => r.montant > 0).forEach(r => {
            const cat = r.categorie || 'Non catégorisé';
            incomeByCat[cat] = (incomeByCat[cat] || 0) + r.montant;
        });
        const topIncome = Object.entries(incomeByCat).sort((a, b) => b[1] - a[1]).slice(0, 8);
        $('#summary-income').innerHTML = topIncome.map(([name, val]) =>
            `<div class="summary-item"><span class="summary-item-label">${escapeHtml(name)}</span><span class="summary-item-value amount-positive">${formatCurrency(val)}</span></div>`
        ).join('');

        renderAlerts();
    }

    function renderAlerts() {
        const data = filteredData;
        const alerts = [];
        const totalIn = data.filter(r => r.montant > 0).reduce((s, r) => s + r.montant, 0);
        const totalOut = Math.abs(data.filter(r => r.montant < 0).reduce((s, r) => s + r.montant, 0));
        const net = totalIn - totalOut;

        if (net < 0) {
            alerts.push({ type: 'warning', text: `Solde net négatif (${formatCurrency(-Math.abs(net))}). Les décaissements dépassent les encaissements.` });
        } else {
            alerts.push({ type: 'success', text: `Solde net positif (${formatCurrency(net)}). Les encaissements couvrent les décaissements.` });
        }

        const sorted = [...data].sort((a, b) => Math.abs(b.montant) - Math.abs(a.montant));
        if (sorted[0]) alerts.push({ type: 'info', text: `Transaction max : ${formatCurrency(sorted[0].montant)} — ${sorted[0].libelle.substring(0, 60)}` });

        const unjustified = data.filter(r => r.justifie && r.justifie.toLowerCase() === 'non');
        if (unjustified.length > 0) {
            const tot = unjustified.reduce((s, r) => s + Math.abs(r.montant), 0);
            alerts.push({ type: 'warning', text: `${unjustified.length} transaction(s) non justifiée(s) pour ${formatCurrency(tot)}.` });
        }

        const topExpCat = Object.entries(
            data.filter(r => r.montant < 0).reduce((acc, r) => { const cat = r.categorie || 'DIVERS'; acc[cat] = (acc[cat] || 0) + Math.abs(r.montant); return acc; }, {})
        ).sort((a, b) => b[1] - a[1])[0];
        if (topExpCat && totalOut > 0) {
            const pct = ((topExpCat[1] / totalOut) * 100).toFixed(1);
            if (pct > 30) alerts.push({ type: 'warning', text: `Concentration : « ${topExpCat[0]} » = ${pct}% des décaissements.` });
        }

        const intercoTotal = data.filter(r => r.categorie === 'Interco').reduce((s, r) => s + Math.abs(r.montant), 0);
        if (intercoTotal > 0) alerts.push({ type: 'info', text: `Flux Interco : ${formatCurrency(intercoTotal)}.` });

        const diversCount = data.filter(r => r.categorie === 'DIVERS' || (r.ruleHit && r.ruleHit.includes('Fallback'))).length;
        if (diversCount > 0) alerts.push({ type: 'warning', text: `${diversCount} transaction(s) « DIVERS / Fallback » — à vérifier.` });

        const iconMap = {
            warning: '<svg class="alert-icon alert-warning" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
            info: '<svg class="alert-icon alert-info" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
            success: '<svg class="alert-icon alert-success" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
        };

        $('#summary-alerts').innerHTML = alerts.map(a => `<div class="alert-item">${iconMap[a.type]}<span>${escapeHtml(a.text)}</span></div>`).join('');
    }

    // ══════════════════════════════════════════════
    //  UTILITIES
    // ══════════════════════════════════════════════

    function escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function truncate(str, len) {
        if (!str) return '';
        return str.length > len ? str.substring(0, len) + '…' : str;
    }

    function debounce(fn, ms) {
        let timer;
        return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
    }

    // ── Logo click = Home ──
    $('#nav-logo-home').addEventListener('click', () => {
        $$('.nav-tab').forEach(b => b.classList.remove('active'));
        const dashTab = document.querySelector('.nav-tab[data-tab="dashboard"]');
        if (dashTab) dashTab.classList.add('active');
        $$('.tab-content').forEach(tc => tc.classList.remove('active'));
        const target = document.getElementById('tab-dashboard');
        if (target) target.classList.add('active');
    });

    // ── Export ──
    $('#btn-export').addEventListener('click', () => { window.print(); });

    // ── Fichiers Tab: Upload zone ──
    const ftFileInput = document.getElementById('ft-file-input');
    const ftUploadZone = document.getElementById('ft-upload-zone');

    ftUploadZone.addEventListener('click', () => ftFileInput.click());
    ftUploadZone.addEventListener('dragover', (e) => { e.preventDefault(); ftUploadZone.classList.add('dragover'); });
    ftUploadZone.addEventListener('dragleave', () => ftUploadZone.classList.remove('dragover'));
    ftUploadZone.addEventListener('drop', (e) => {
        e.preventDefault();
        ftUploadZone.classList.remove('dragover');
        if (e.dataTransfer.files.length > 0) handleFtFile(e.dataTransfer.files[0]);
    });
    ftFileInput.addEventListener('change', () => {
        if (ftFileInput.files.length > 0) handleFtFile(ftFileInput.files[0]);
    });

    function handleFtFile(file) {
        window._selectedFile = file;
        const sizeKB = (file.size / 1024).toFixed(1);
        $('#ft-file-name').textContent = file.name;
        $('#ft-file-size').textContent = `(${sizeKB} KB)`;
        $('#ft-file-info').classList.remove('hidden');
    }

    $('#ft-analyze-btn').addEventListener('click', () => {
        if (!window._selectedFile) return;
        showScreen('loading');
        setTimeout(() => processFile(window._selectedFile), 500);
    });

    // ── Manual Save Button ──
    $('#ft-manual-save').addEventListener('click', async () => {
        if (rawData.length === 0) {
            showSaveToast('Aucune donnée à sauvegarder', true);
            return;
        }
        const saved = await saveToStorage();
        if (saved) updateStorageStatus();
    });

    // ── Sauvegarde / restauration (fichier JSON) ──
    async function exportBackup() {
        try {
            const backup = {
                app: 'Liora Cash Flow Analyzer',
                type: 'backup',
                version: 1,
                exportedAt: new Date().toISOString(),
                data: {
                    [STORAGE_DATA_KEY]: await idbGet(STORAGE_DATA_KEY),
                    [STORAGE_FILES_KEY]: await idbGet(STORAGE_FILES_KEY),
                    [STORAGE_LEARNED_KEY]: await idbGet(STORAGE_LEARNED_KEY),
                    [STORAGE_B2B_KEY]: await idbGet(STORAGE_B2B_KEY),
                },
            };
            const blob = new Blob([JSON.stringify(backup)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'liora-sauvegarde-' + new Date().toISOString().slice(0, 10) + '.json';
            document.body.appendChild(a); a.click(); a.remove();
            URL.revokeObjectURL(url);
            showSaveToast('Sauvegarde exportée', false);
        } catch (e) {
            showSaveToast('Échec de l\'export : ' + e.message, true);
        }
    }

    async function importBackup(file) {
        try {
            const backup = JSON.parse(await file.text());
            const payload = (backup && backup.data) ? backup.data : backup; // tolère un objet brut
            const keys = [STORAGE_DATA_KEY, STORAGE_FILES_KEY, STORAGE_LEARNED_KEY, STORAGE_B2B_KEY];
            const present = keys.filter(k => payload && payload[k] !== undefined);
            if (present.length === 0) { showSaveToast('Fichier de sauvegarde non reconnu', true); return; }
            const nb = Array.isArray(payload[STORAGE_DATA_KEY]) ? payload[STORAGE_DATA_KEY].length : 0;
            if (!confirm(`Restaurer cette sauvegarde ?\n\n${nb} transaction(s) et les règles associées remplaceront les données actuelles.`)) return;
            for (const k of present) await idbSet(k, payload[k]);
            showSaveToast('Sauvegarde restaurée — rechargement…', false);
            setTimeout(() => location.reload(), 800);
        } catch (e) {
            showSaveToast('Échec de la restauration : ' + e.message, true);
        }
    }

    (function wireBackup() {
        const exp = document.getElementById('ft-backup-export');
        const impBtn = document.getElementById('ft-backup-import-btn');
        const impInput = document.getElementById('ft-backup-import');
        if (exp) exp.addEventListener('click', exportBackup);
        if (impBtn && impInput) {
            impBtn.addEventListener('click', () => impInput.click());
            impInput.addEventListener('change', () => { if (impInput.files.length) importBackup(impInput.files[0]); impInput.value = ''; });
        }
    })();

    // ── Option : reconnaissance B2B automatique à l'import ──
    (async function wireAutoB2BOption() {
        const cb = document.getElementById('opt-auto-b2b');
        if (!cb) return;
        try { cb.checked = (await idbGet(STORAGE_AUTO_B2B_KEY)) === true; } catch { /* ignore */ }
        cb.addEventListener('change', async () => {
            try {
                await idbSet(STORAGE_AUTO_B2B_KEY, cb.checked);
                showSaveToast(cb.checked ? 'Auto-B2B à l\'import activé' : 'Auto-B2B à l\'import désactivé', false);
            } catch { /* ignore */ }
        });
    })();

    // ── Storage status indicator ──
    async function updateStorageStatus() {
        const dot = document.getElementById('storage-status-dot');
        const text = document.getElementById('storage-status-text');
        if (!dot || !text) return;
        try {
            const stored = await idbGet(STORAGE_DATA_KEY);
            const count = stored ? stored.length : 0;
            const learnedCount = Object.keys(_learnedCache).length;
            if (count > 0) {
                dot.className = 'storage-status-dot';
                text.textContent = `${count} transactions et ${learnedCount} règles apprises sauvegardées dans IndexedDB`;
            } else {
                dot.className = 'storage-status-dot offline';
                text.textContent = 'Aucune donnée stockée';
            }
            // Show storage estimate if available
            if (navigator.storage && navigator.storage.estimate) {
                const est = await navigator.storage.estimate();
                const usedMB = (est.usage / (1024 * 1024)).toFixed(1);
                text.textContent += ` — ${usedMB} Mo utilisés`;
            }
        } catch (e) {
            dot.className = 'storage-status-dot offline';
            text.textContent = 'Erreur IndexedDB: ' + e.message;
        }
    }

    // ── Clear All History ──
    $('#ft-clear-all').addEventListener('click', async () => {
        if (!confirm('Supprimer tout l\'historique des données importées ?')) return;
        await clearAllHistory();
        rawData = [];
        filteredData = [];
        currentPage = 1;
        Object.keys(charts).forEach(destroyChart);
        await renderFileHistory();
    });

    // ── Delete single file from history ──
    async function deleteFileFromHistory(index) {
        const history = await getFileHistory();
        if (index < 0 || index >= history.length) return;
        const fileName = history[index].name;
        if (!confirm(`Supprimer « ${fileName} » de l'historique ?`)) return;

        // Remove file entry
        history.splice(index, 1);
        await idbSet(STORAGE_FILES_KEY, history);

        // Note: raw data is merged, we can't perfectly un-merge.
        // But we can reload from remaining data if all files are cleared.
        if (history.length === 0) {
            await idbDelete(STORAGE_DATA_KEY);
            rawData = [];
            filteredData = [];
            currentPage = 1;
            Object.keys(charts).forEach(destroyChart);
        }
        await renderFileHistory();
    }

    // ── File History Rendering (in Fichiers tab) ──
    async function renderFileHistory() {
        const container = document.getElementById('ft-file-history');
        if (!container) return;
        const history = await getFileHistory();
        if (history.length === 0) {
            container.innerHTML = '<p class="ft-empty">Aucun fichier importé.</p>';
            return;
        }
        let html = '';
        history.forEach((f, i) => {
            const d = new Date(f.date);
            const dateStr = d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
            html += `<div class="ft-file-item">
                <div class="ft-file-info">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                    <span class="ft-file-name">${escapeHtml(f.name)}</span>
                    <span class="ft-file-meta">${f.rowCount} lignes — ${dateStr}</span>
                </div>
                <button class="ft-btn-delete" data-index="${i}" title="Supprimer ce fichier">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                </button>
            </div>`;
        });
        container.innerHTML = html;

        // Wire delete buttons
        container.querySelectorAll('.ft-btn-delete').forEach(btn => {
            btn.addEventListener('click', () => deleteFileFromHistory(parseInt(btn.dataset.index)));
        });
    }

    // ── Rules Recap (in Fichiers tab) ──
    function renderRulesRecap() {
        // Learned rules list (read-only view)
        const learnedContainer = document.getElementById('ft-recap-learned-list');
        const learnedCountEl = document.getElementById('ft-recap-learned-count');
        if (!learnedContainer) return;
        const entries = Object.entries(_learnedCache);
        if (learnedCountEl) learnedCountEl.textContent = entries.length;
        if (entries.length === 0) {
            learnedContainer.innerHTML = '<p class="ft-empty">Aucune règle apprise. Reclassez des transactions dans l\'onglet Data Quality pour créer des règles.</p>';
        } else {
            entries.sort((a, b) => (b[1].date || 0) - (a[1].date || 0));
            let html = '';
            entries.forEach(([key, val]) => {
                const sensLabel = val.sens === 'Encaissement' ? 'Enc.' : 'Déc.';
                const sensClass = val.sens === 'Encaissement' ? 'ft-rule-enc' : 'ft-rule-dec';
                html += `<div class="ft-rule-item">
                    <div class="ft-rule-content">
                        <span class="ft-rule-badge ${sensClass}">${sensLabel}</span>
                        <span class="ft-rule-key">${escapeHtml(key)}</span>
                        <span class="ft-rule-arrow">→</span>
                        <span class="ft-rule-cat">${escapeHtml(val.category)}</span>
                    </div>
                </div>`;
            });
            learnedContainer.innerHTML = html;
        }

        // Built-in rules list (grouped by category)
        const builtinContainer = document.getElementById('ft-recap-builtin-list');
        if (!builtinContainer) return;
        const builtinRules = [
            { label: 'Interco (Enc.)', keys: INTERCO_ENC_KEYS, sens: 'enc' },
            { label: 'OPCO', keys: OPCO_KEYS, sens: 'enc' },
            { label: 'CPF', keys: CPF_KEYS, sens: 'enc' },
            { label: 'Reconversion', keys: RECONV_KEYS, sens: 'enc' },
            { label: 'B2B', keys: B2B_EXTRA, sens: 'enc' },
            { label: 'Financement personnel (PSP)', keys: B2C_PSP, sens: 'enc' },
            { label: 'Autres revenus', keys: AUTRES_REV_KEYS, sens: 'enc' },
            { label: 'Interco (Déc.)', keys: INTERCO_DEC_KEYS, sens: 'dec' },
            { label: 'Banques/Dettes', keys: BANQUES_DETTES_KEYS, sens: 'dec' },
            { label: 'Frais généraux & services', keys: FGS_KEYS, sens: 'dec' },
            { label: 'Note de frais', keys: NOTES_FRAIS_KEYS, sens: 'dec' },
            { label: 'Prévoyance / Mutuelle', keys: PREVOYANCE_KEYS, sens: 'dec' },
            { label: 'SaaS/IT', keys: SAAS_IT_KEYS, sens: 'dec' },
            { label: 'Marketing & Acquisition', keys: MKT_ACQ_KEYS, sens: 'dec' },
            { label: 'URSSAF', keys: URSSAF_KEYS, sens: 'dec' },
            { label: 'Partenariat académique', keys: PA_ACAD_KEYS, sens: 'dec' },
            { label: 'Formateurs / Freelances (génériques)', keys: FF_GEN_KEYS, sens: 'dec' },
            { label: 'Formateurs / Freelances (spécifiques)', keys: FF_SPECIFIC_KEYS, sens: 'dec' },
            { label: 'Remboursement', keys: REMBOURSEMENT_KEYS, sens: 'dec' },
            { label: 'Salaires', keys: SALAIRES_HINTS, sens: 'dec' },
            { label: 'Loyers & charges', keys: LOYERS_KEYS, sens: 'dec' },
            { label: 'Autres impôts', keys: AUTRES_IMPOTS_KEYS, sens: 'dec' },
        ];
        let bhtml = '';
        builtinRules.forEach((rule, i) => {
            const sensLabel = rule.sens === 'enc' ? 'Enc.' : 'Déc.';
            const sensClass = rule.sens === 'enc' ? 'ft-rule-enc' : 'ft-rule-dec';
            bhtml += `<div class="ft-builtin-group">
                <div class="ft-builtin-group-header" data-builtin-idx="${i}">
                    <span class="ft-builtin-arrow">▶</span>
                    <span class="ft-rule-badge ${sensClass}">${sensLabel}</span>
                    <h4>${escapeHtml(rule.label)}</h4>
                    <span class="ft-builtin-count">${rule.keys.length} mots-clés</span>
                </div>
                <div class="ft-builtin-keywords" data-builtin-body="${i}">
                    ${rule.keys.map(k => `<span class="ft-builtin-kw">${escapeHtml(k)}</span>`).join('')}
                </div>
            </div>`;
        });
        builtinContainer.innerHTML = bhtml;

        // Toggle groups
        builtinContainer.querySelectorAll('.ft-builtin-group-header').forEach(header => {
            header.addEventListener('click', () => {
                const idx = header.dataset.builtinIdx;
                const body = builtinContainer.querySelector(`[data-builtin-body="${idx}"]`);
                header.classList.toggle('open');
                body.classList.toggle('open');
            });
        });
    }

    // Wire rules recap tab switching
    document.querySelectorAll('.ft-rules-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.ft-rules-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            document.querySelectorAll('.ft-rules-recap-panel').forEach(p => {
                p.classList.remove('active');
                p.style.display = 'none';
            });
            const target = document.getElementById('ft-rules-recap-' + tab.dataset.rulesTab);
            if (target) {
                target.classList.add('active');
                target.style.display = '';
            }
        });
    });

    // ── Helpers for learned rules ──
    function countMatchingDqRows(ruleKey, sens) {
        const defaultCat = sens === 'Encaissement' ? 'Autres revenus' : 'DIVERS';
        return rawData.filter(r => {
            if (r.sens !== sens || r.manualCategory || r.categorie !== defaultCat) return false;
            const cleaned = cleanLibelleForLearning(normUpper(r.libelle));
            return cleaned.includes(ruleKey) || ruleKey.includes(cleaned);
        }).length;
    }

    // Count ALL matching transactions for a rule in the currently selected month(s)
    // (classified or not — used to decide if a rule is relevant to show)
    function countMatchingRowsInSelectedMonths(ruleKey, sens) {
        return rawData.filter(r => {
            if (r.sens !== sens) return false;
            // Month filter
            if (dqSelectedMonths) {
                const mk = getDqMonthKey(r);
                if (!mk || !dqSelectedMonths.has(mk)) return false;
            }
            const cleaned = cleanLibelleForLearning(normUpper(r.libelle));
            return cleaned.includes(ruleKey) || ruleKey.includes(cleaned);
        }).length;
    }

    function applyRuleToDqRows(ruleKey, val) {
        const defaultCat = val.sens === 'Encaissement' ? 'Autres revenus' : 'DIVERS';
        let applied = 0;
        rawData.forEach(r => {
            if (r.sens !== val.sens || r.manualCategory || r.categorie !== defaultCat) return;
            const cleaned = cleanLibelleForLearning(normUpper(r.libelle));
            if (cleaned.includes(ruleKey) || ruleKey.includes(cleaned)) {
                r.categorie = val.category;
                r.manualCategory = val.category;
                r.ruleHit = 'DQ: Règle apprise validée';
                applied++;
            }
        });
        return applied;
    }

    // ── Helper: find all matching unclassified DQ rows for a rule key (all months) ──
    function findMatchingDqRows(ruleKey, sens) {
        const defaultCat = sens === 'Encaissement' ? 'Autres revenus' : 'DIVERS';
        return rawData.filter(r => {
            if (r.sens !== sens || r.manualCategory || r.categorie !== defaultCat) return false;
            const cleaned = cleanLibelleForLearning(normUpper(r.libelle));
            return cleaned.includes(ruleKey) || ruleKey.includes(cleaned);
        });
    }

    // ── Build transaction preview HTML ──
    function buildPreviewHtml(ruleKey, sens) {
        const rows = findMatchingDqRows(ruleKey, sens);
        if (rows.length === 0) {
            return '<p class="ft-preview-none">Aucune transaction correspondante à reclasser.</p>';
        }
        let html = '';
        rows.forEach(r => {
            const mk = getDqMonthKey(r);
            const [y, m] = (mk || '--').split('-');
            const monthLabel = mk ? new Date(+y, +m - 1).toLocaleDateString('fr-FR', { month: 'short', year: '2-digit' }) : '—';
            html += `<div class="ft-rule-preview-row">
                <span class="ft-preview-month">${monthLabel}</span>
                <span class="ft-preview-lib" title="${escapeHtml(r.libelle)}">${escapeHtml(r.libelle)}</span>
                <span class="ft-preview-amount">${formatCurrency(r.montant)}</span>
            </div>`;
        });
        return html;
    }

    // ── Learned Rules Rendering (in Data Quality tab) ──
    function renderLearnedRules() {
        wireValidateAll();
        wireClearLearned();
        const container = document.getElementById('ft-learned-rules');
        const clearBtn = document.getElementById('ft-clear-learned');
        const validateAllBtn = document.getElementById('ft-validate-all');
        const countEl = document.getElementById('dq-count-rules');
        if (!container) return;
        const allEntries = Object.entries(_learnedCache);

        // Show rules that have matching transactions in the currently selected month(s)
        const entries = allEntries.filter(([key, val]) => countMatchingRowsInSelectedMonths(key, val.sens) > 0);

        if (countEl) countEl.textContent = entries.length;
        if (entries.length === 0) {
            container.innerHTML = allEntries.length > 0
                ? '<p class="ft-empty">Aucune règle ne correspond aux transactions du mois sélectionné.</p>'
                : '<p class="ft-empty">Aucune règle apprise.</p>';
            if (clearBtn) clearBtn.style.display = allEntries.length > 0 ? '' : 'none';
            if (validateAllBtn) validateAllBtn.style.display = 'none';
            return;
        }
        if (clearBtn) clearBtn.style.display = '';

        // Check total pending across all rules for "Tout valider" button
        let totalPending = 0;
        entries.forEach(([key, val]) => { totalPending += countMatchingDqRows(key, val.sens); });
        if (validateAllBtn) {
            validateAllBtn.style.display = totalPending > 0 ? '' : 'none';
            validateAllBtn.textContent = `Tout valider (${totalPending})`;
        }

        // Sort by date descending
        entries.sort((a, b) => (b[1].date || 0) - (a[1].date || 0));

        // Split into Enc / Déc groups
        const encEntries = entries.filter(([, v]) => v.sens === 'Encaissement');
        const decEntries = entries.filter(([, v]) => v.sens === 'Décaissement');

        function buildRuleItemHtml(key, val) {
            const cats = val.sens === 'Encaissement' ? ENC_CATEGORIES : DEC_CATEGORIES;
            const catOptions = cats.map(c =>
                `<option value="${escapeHtml(c)}"${c === val.category ? ' selected' : ''}>${escapeHtml(c)}</option>`
            ).join('');
            const matchCount = countMatchingDqRows(key, val.sens);
            const matchBadge = matchCount > 0
                ? `<span class="dq-count" style="font-size:0.68rem">${matchCount}</span>`
                : '';
            return `<div class="ft-rule-item" data-rule-key="${escapeHtml(key)}">
                <div class="ft-rule-row">
                    <div class="ft-rule-content">
                        <span class="ft-rule-key">${escapeHtml(key)}</span>
                        <span class="ft-rule-arrow">→</span>
                        <span class="ft-rule-cat">${escapeHtml(val.category)}</span>
                        ${matchBadge}
                    </div>
                    <div class="ft-rule-actions">
                        <button class="ft-btn-edit" title="Modifier">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                        </button>
                        <button class="ft-btn-delete" title="Supprimer">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                        </button>
                    </div>
                </div>
                <div class="ft-rule-edit-panel">
                    <div class="ft-rule-edit-fields">
                        <label>Mot-clé :</label>
                        <input class="ft-rule-edit-input" value="${escapeHtml(key)}">
                        <label>Catégorie :</label>
                        <select class="ft-rule-edit-cat">${catOptions}</select>
                    </div>
                    <div class="ft-rule-edit-actions">
                        <button class="ft-btn-save-rule">Enregistrer</button>
                        <button class="ft-btn-cancel-rule">Annuler</button>
                    </div>
                    <div class="ft-rule-preview">
                        <div class="ft-rule-preview-title">Transactions concernées (tous mois) :</div>
                        <div class="ft-rule-preview-list">${buildPreviewHtml(key, val.sens)}</div>
                    </div>
                </div>
            </div>`;
        }

        function buildGroupHtml(label, cssClass, groupEntries, groupId) {
            if (groupEntries.length === 0) return '';
            const collapsed = _rulesGroupCollapsed[groupId] ? ' ft-group-collapsed' : '';
            const chevron = _rulesGroupCollapsed[groupId]
                ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>'
                : '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>';
            let html = `<div class="ft-rules-group${collapsed}" data-group-id="${groupId}">
                <div class="ft-rules-group-header ${cssClass}">
                    <span class="ft-group-chevron">${chevron}</span>
                    <span class="ft-group-label">${label}</span>
                    <span class="dq-count" style="font-size:0.68rem">${groupEntries.length}</span>
                </div>
                <div class="ft-rules-group-body">`;
            groupEntries.forEach(([key, val]) => { html += buildRuleItemHtml(key, val); });
            html += '</div></div>';
            return html;
        }

        let html = '';
        html += buildGroupHtml('Encaissements', 'ft-group-enc', encEntries, 'enc');
        html += buildGroupHtml('Décaissements', 'ft-group-dec', decEntries, 'dec');
        container.innerHTML = html;

        // Wire group collapse/expand
        container.querySelectorAll('.ft-rules-group-header').forEach(header => {
            header.addEventListener('click', () => {
                const group = header.closest('.ft-rules-group');
                const groupId = group.dataset.groupId;
                group.classList.toggle('ft-group-collapsed');
                _rulesGroupCollapsed[groupId] = group.classList.contains('ft-group-collapsed');
                // Update chevron
                const chevronEl = header.querySelector('.ft-group-chevron');
                chevronEl.innerHTML = _rulesGroupCollapsed[groupId]
                    ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>'
                    : '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>';
            });
        });

        // Wire all rule items
        container.querySelectorAll('.ft-rule-item').forEach(item => {
            const ruleKey = item.dataset.ruleKey;
            const btnEdit = item.querySelector('.ft-btn-edit');
            const btnDelete = item.querySelector('.ft-btn-delete');
            const btnSave = item.querySelector('.ft-btn-save-rule');
            const btnCancel = item.querySelector('.ft-btn-cancel-rule');
            const keyInput = item.querySelector('.ft-rule-edit-input');
            const catSelect = item.querySelector('.ft-rule-edit-cat');
            const previewList = item.querySelector('.ft-rule-preview-list');

            btnEdit.addEventListener('click', () => {
                // Close any other open panels
                container.querySelectorAll('.ft-rule-item.ft-rule-editing').forEach(other => {
                    other.classList.remove('ft-rule-editing');
                });
                item.classList.add('ft-rule-editing');
                keyInput.focus();
                keyInput.select();
            });

            btnCancel.addEventListener('click', () => {
                item.classList.remove('ft-rule-editing');
                keyInput.value = ruleKey;
                catSelect.value = _learnedCache[ruleKey]?.category || '';
            });

            keyInput.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') btnCancel.click();
                if (e.key === 'Enter') btnSave.click();
            });

            // Live preview update as user types
            keyInput.addEventListener('input', () => {
                const testKey = keyInput.value.trim().toUpperCase();
                const sens = _learnedCache[ruleKey]?.sens || 'Encaissement';
                if (testKey.length >= 2) {
                    previewList.innerHTML = buildPreviewHtml(testKey, sens);
                } else {
                    previewList.innerHTML = '<p class="ft-preview-none">Saisissez au moins 2 caractères.</p>';
                }
            });

            btnSave.addEventListener('click', async () => {
                const newKey = keyInput.value.trim().toUpperCase();
                const newCat = catSelect.value;
                if (newKey.length < 2) return;
                const oldVal = _learnedCache[ruleKey];
                if (!oldVal) return;
                if (newKey !== ruleKey) delete _learnedCache[ruleKey];
                _learnedCache[newKey] = { ...oldVal, category: newCat, date: Date.now() };
                await saveLearnedCategories();
                // Apply to matching rows and refresh
                applyRuleToDqRows(newKey, _learnedCache[newKey]);
                categorizeAll(rawData);
                await saveToStorage();
                computeFilteredData();
                renderDataQuality();
                renderLearnedRules();
                refreshDashboard();
            });

            btnDelete.addEventListener('click', async () => {
                await deleteLearnedRule(ruleKey);
                categorizeAll(rawData);
                await saveToStorage();
                computeFilteredData();
                renderDataQuality();
                renderLearnedRules();
                refreshDashboard();
            });
        });

        // Also refresh the recap in Fichiers tab if visible
        renderRulesRecap();
    }

    // ── Rules group collapse state ──
    const _rulesGroupCollapsed = {};

    // ── "Tout valider" global button (wired once after DOM ready) ──
    let _validateAllWired = false;
    function wireValidateAll() {
        if (_validateAllWired) return;
        const btn = document.getElementById('ft-validate-all');
        if (!btn) return;
        _validateAllWired = true;
        btn.addEventListener('click', async () => {
            const entries = Object.entries(_learnedCache);
            let totalApplied = 0;
            for (const [key, val] of entries) {
                totalApplied += applyRuleToDqRows(key, val);
            }
            if (totalApplied > 0) {
                await saveToStorage();
                computeFilteredData();
                renderDataQuality();
                renderLearnedRules();
                refreshDashboard();
            }
        });
    }

    // Clear all learned rules (wired once after DOM ready)
    let _clearLearnedWired = false;
    function wireClearLearned() {
        if (_clearLearnedWired) return;
        const btn = document.getElementById('ft-clear-learned');
        if (!btn) return;
        _clearLearnedWired = true;
        btn.addEventListener('click', async () => {
            if (!confirm('Supprimer toutes les règles apprises ?')) return;
            _learnedCache = {};
            await saveLearnedCategories();
            categorizeAll(rawData);
            await saveToStorage();
            computeFilteredData();
            renderDataQuality();
            renderLearnedRules();
            refreshDashboard();
        });
    }

    // ── Auto-load from IndexedDB on startup ──
    (async function autoLoad() {
        console.log('[Liora] Démarrage — chargement des données persistées...');
        await migrateFromLocalStorage();
        await loadLearnedCategories();
        await loadB2BCache();
        await loadCashBalance();
        const stored = await loadFromStorage();
        if (stored.length > 0) {
            console.log('[Liora] Restauration de', stored.length, 'transactions depuis IndexedDB');
            rawData = stored;
            categorizeAll(rawData);
            filteredData = [...rawData];
            buildDashboard();
            await renderFileHistory();
            showScreen('dashboard');
            showSaveToast(stored.length + ' transactions restaurées', false);
        } else {
            console.log('[Liora] Aucune donnée trouvée dans IndexedDB');
            await renderFileHistory();
        }
    })();

    // ══════════════════════════════════════════════
    //  TAB NAVIGATION
    // ══════════════════════════════════════════════

    $$('.nav-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            $$('.nav-tab').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            $$('.tab-content').forEach(tc => tc.classList.remove('active'));
            const target = document.getElementById('tab-' + btn.dataset.tab);
            if (target) target.classList.add('active');
            if (btn.dataset.tab === 'dataquality') { renderDataQuality(); renderLearnedRules(); }
            if (btn.dataset.tab === 'projection') renderProjectionTab();
            if (btn.dataset.tab === 'simulation') renderSimulationTab();
            if (btn.dataset.tab === 'fichiers') { renderFileHistory(); renderRulesRecap(); updateStorageStatus(); }
        });
    });

    // ══════════════════════════════════════════════
    //  DATA QUALITY TAB
    // ══════════════════════════════════════════════

    const DEC_CATEGORIES = [
        'Interco', 'Banques/Dettes', 'Taxe sur les salaires', 'Prélèvement à la source (PAS)',
        'Frais généraux & services', 'Note de frais', 'Prévoyance / Mutuelle', 'Ticket restaurant',
        'SaaS/IT', 'Marketing & Acquisition', 'URSSAF', 'Partenariat académique',
        'Formateurs / Freelances', 'Remboursement', 'Salaires', 'Loyers & charges', 'Autres impôts',
        'DIVERS',
    ];
    const ENC_CATEGORIES = [
        'Interco', 'OPCO', 'CPF', 'Reconversion', 'B2B', 'Financement personnel',
        'Autres revenus',
    ];

    const MONTH_NAMES = ['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre'];

    function getDqMonthKey(row) {
        if (!row.date) return null;
        const d = row.date;
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    }

    // DQ multi-month filter state: null = all selected, empty Set = none selected
    // Par défaut : aucun mois sélectionné (l'utilisateur choisit le(s) mois à traiter).
    let dqSelectedMonths = new Set();
    let dqAllMonthKeys = [];

    function populateDqMonthFilter() {
        // Use ALL months from rawData, not just unclassified rows
        const monthSet = new Set();
        rawData.forEach(r => { const k = getDqMonthKey(r); if (k) monthSet.add(k); });
        dqAllMonthKeys = [...monthSet].sort();
        renderDqMonthButtons();
    }

    function renderDqMonthButtons() {
        const container = document.getElementById('dq-filter-months');
        if (!container) return;
        container.innerHTML = '';
        dqAllMonthKeys.forEach(mk => {
            const [y, m] = mk.split('-');
            const label = new Date(+y, +m - 1).toLocaleDateString('fr-FR', { month: 'short', year: '2-digit' });
            const btn = document.createElement('button');
            btn.className = 'date-month-btn';
            btn.dataset.month = mk;
            btn.textContent = label;
            if (!dqSelectedMonths || dqSelectedMonths.has(mk)) {
                btn.classList.add('active');
            }
            btn.addEventListener('click', () => toggleDqMonth(mk));
            container.appendChild(btn);
        });
    }

    function toggleDqMonth(mk) {
        if (!dqSelectedMonths) {
            dqSelectedMonths = new Set(dqAllMonthKeys);
            dqSelectedMonths.delete(mk);
        } else if (dqSelectedMonths.has(mk)) {
            dqSelectedMonths.delete(mk);
        } else {
            dqSelectedMonths.add(mk);
        }
        if (dqSelectedMonths.size === dqAllMonthKeys.length) {
            dqSelectedMonths = null;
        }
        renderDqMonthButtons();
        renderDataQuality();
    }

    document.getElementById('dq-select-all').addEventListener('click', () => {
        dqSelectedMonths = null;
        renderDqMonthButtons();
        renderDataQuality();
    });

    document.getElementById('dq-select-none').addEventListener('click', () => {
        dqSelectedMonths = new Set();
        renderDqMonthButtons();
        renderDataQuality();
    });

    // Bouton « Détecter B2B (annuaire officiel) » dans la section Autres revenus
    (function wireB2BButton() {
        const b2bBtn = document.getElementById('dq-b2b-autres');
        if (b2bBtn) b2bBtn.addEventListener('click', () => runB2BDetection(b2bBtn));
    })();

    // ── Détection via annuaire officiel ──
    // Collecte les noms de tiers uniques (candidats) absents du cache.
    function collectRegistryCandidates() {
        const seen = new Map();
        for (const row of getB2BCandidateRows()) {
            const name = extractCompanyName(row);
            if (!name || name.length < 4) continue;
            if (looksLikePerson(row._libNorm || normUpper(row.libelle))) continue;
            const key = b2bCacheKey(name);
            if (!seen.has(key)) seen.set(key, name);
        }
        return [...seen.values()].filter(name => !(b2bCacheKey(name) in b2bRegistryCache));
    }

    async function queryNamesIntoCache(names, onProgress) {
        let done = 0, errored = false;
        for (const name of names) {
            if (onProgress) onProgress(++done, names.length);
            try { b2bRegistryCache[b2bCacheKey(name)] = await queryCompanyRegistry(name); }
            catch { errored = true; } // échec réseau : non mis en cache (réessayable)
            await new Promise(r => setTimeout(r, 160)); // throttle ~6 req/s (limite API : 7/s)
        }
        await saveB2BCache();
        return errored;
    }

    async function finalizeRegistry(errored) {
        const beforeB2B = rawData.filter(r => r.categorie === 'B2B').length;
        const beforePerso = rawData.filter(r => r.categorie === 'Financement personnel').length;
        categorizeAll(rawData);
        const addB2B = rawData.filter(r => r.categorie === 'B2B').length - beforeB2B;
        const addPerso = rawData.filter(r => r.categorie === 'Financement personnel').length - beforePerso;
        await saveToStorage();
        computeFilteredData();
        renderDataQuality();
        renderLearnedRules();
        refreshDashboard();
        const parts = [];
        if (addB2B > 0) parts.push(addB2B + ' en B2B');
        if (addPerso > 0) parts.push(addPerso + ' en financement personnel');
        const msg = parts.length ? 'Reclassé via l\'annuaire : ' + parts.join(' et ') : 'Aucune nouvelle reconnaissance';
        showSaveToast(msg + (errored ? ' (certaines requêtes ont échoué)' : ''), errored);
    }

    // Détection MANUELLE (bouton Data Quality) : B2B + financements personnels.
    async function runB2BDetection(btn) {
        const toQuery = collectRegistryCandidates();
        const origLabel = btn ? btn.textContent : '';
        if (btn) btn.disabled = true;
        let errored = false;
        try {
            errored = await queryNamesIntoCache(toQuery, (d, t) => { if (btn) btn.textContent = 'Annuaire… ' + d + '/' + t; });
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = origLabel; }
        }
        // Le clic manuel active l'application des « financements personnels » (par élimination)
        b2bApplyPersonal = true;
        try { await idbSet(STORAGE_B2B_PERSO_KEY, true); } catch { /* ignore */ }
        await finalizeRegistry(errored);
    }

    // Détection AUTOMATIQUE à l'import (option) : B2B UNIQUEMENT — n'active pas le personnel.
    async function autoDetectB2BOnImport() {
        const toQuery = collectRegistryCandidates();
        if (toQuery.length) showSaveToast('Reconnaissance B2B (annuaire) en cours…', false);
        const errored = await queryNamesIntoCache(toQuery, null);
        await finalizeRegistry(errored);
    }

    // ── Claude API for category suggestion ──
    function getDqApiKey() {
        return ($('#dq-api-key') || {}).value || '';
    }

    // Persist API key in IndexedDB
    (async function loadApiKey() {
        try {
            const key = await idbGet('liora_api_key');
            if (key) {
                $('#dq-api-key').value = key;
            } else {
                // First launch: prompt user to enter API key
                console.log('[Liora] Aucune clé API trouvée. Renseignez-la dans l\'onglet Fichiers.');
            }
        } catch {}
    })();
    $('#dq-api-key').addEventListener('change', async () => {
        try { await idbSet('liora_api_key', getDqApiKey()); } catch {}
        updateSuggestButtons();
    });
    $('#dq-api-key').addEventListener('input', updateSuggestButtons);

    function updateSuggestButtons() {
        const hasKey = getDqApiKey().length > 10;
        const statusEl = $('#dq-api-status');
        statusEl.textContent = hasKey ? 'Connecté' : '';
        statusEl.className = 'dq-api-status' + (hasKey ? ' dq-api-ok' : '');
        document.querySelectorAll('.dq-btn-suggest-all').forEach(btn => {
            btn.disabled = !hasKey;
        });
    }

    async function callClaudeForCategory(libelle, montant, sens, categories) {
        const apiKey = getDqApiKey();
        if (!apiKey) throw new Error('Clé API manquante');

        const catList = categories.join(', ');
        const resp = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
                'anthropic-dangerous-direct-browser-access': 'true',
            },
            body: JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 200,
                messages: [{
                    role: 'user',
                    content: `Tu es un expert comptable français. Classe cette transaction bancaire dans une des catégories proposées.

Transaction :
- Libellé : "${libelle}"
- Montant : ${montant} €
- Sens : ${sens}

Catégories possibles : ${catList}

Réponds UNIQUEMENT en JSON valide (pas de markdown) :
{"categorie": "...", "confiance": 85, "raison": "explication courte"}

- "categorie" doit être EXACTEMENT une des catégories de la liste.
- "confiance" est un entier de 0 à 100.
- "raison" est une phrase courte en français.`
                }]
            })
        });

        if (!resp.ok) {
            const errBody = await resp.text();
            throw new Error(`API ${resp.status}: ${errBody}`);
        }

        const data = await resp.json();
        const text = data.content[0].text.trim();
        return JSON.parse(text);
    }

    // ── Batch API call: classify multiple transactions at once ──
    async function callClaudeBatch(transactions, categories) {
        const apiKey = getDqApiKey();
        if (!apiKey) throw new Error('Clé API manquante');

        const catList = categories.join(', ');
        const txList = transactions.map((t, i) =>
            `${i + 1}. Libellé: "${t.libelle}" | Montant: ${t.montant} € | Sens: ${t.sens}`
        ).join('\n');

        const resp = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
                'anthropic-dangerous-direct-browser-access': 'true',
            },
            body: JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 1500,
                messages: [{
                    role: 'user',
                    content: `Tu es un expert comptable français. Classe chacune de ces transactions bancaires dans une des catégories proposées.

Transactions :
${txList}

Catégories possibles : ${catList}

Réponds UNIQUEMENT en JSON valide (pas de markdown), sous forme d'un tableau :
[{"categorie": "...", "confiance": 85, "raison": "explication courte"}, ...]

- Un élément par transaction, dans le MÊME ORDRE.
- "categorie" doit être EXACTEMENT une des catégories de la liste.
- "confiance" est un entier de 0 à 100.
- "raison" est une phrase courte en français.`
                }]
            })
        });

        if (!resp.ok) {
            const errBody = await resp.text();
            throw new Error(`API ${resp.status}: ${errBody}`);
        }

        const data = await resp.json();
        const text = data.content[0].text.trim();
        return JSON.parse(text);
    }

    // ── Retry with exponential backoff for 429 / 5xx ──
    async function fetchWithRetry(url, options, maxRetries = 4) {
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                const resp = await fetch(url, options);
                if (resp.status === 429 || resp.status >= 500) {
                    if (attempt < maxRetries) {
                        const delay = Math.pow(2, attempt + 1) * 1000; // 2s, 4s, 8s, 16s
                        await new Promise(r => setTimeout(r, delay));
                        continue;
                    }
                }
                return resp;
            } catch (e) {
                if (attempt < maxRetries) {
                    const delay = Math.pow(2, attempt + 1) * 1000;
                    await new Promise(r => setTimeout(r, delay));
                    continue;
                }
                throw e;
            }
        }
    }

    function displaySuggestion(tr, result, categories) {
        const suggCell = tr.querySelector('.dq-suggestion');
        const conf = result.confiance || 0;
        const confClass = conf >= 80 ? 'high' : conf >= 50 ? 'med' : 'low';

        suggCell.innerHTML = `
            <div class="dq-sugg-result">
                <div class="dq-sugg-cat">${escapeHtml(result.categorie)}</div>
                <div class="dq-sugg-conf dq-conf-${confClass}">${conf}%</div>
                <div class="dq-sugg-reason">${escapeHtml(result.raison)}</div>
                <div class="dq-sugg-actions">
                    <button class="dq-btn-confirm" data-cat="${escapeHtml(result.categorie)}" title="Confirmer">Confirmer</button>
                    <button class="dq-btn-edit" title="Modifier">Modifier</button>
                </div>
            </div>
        `;

        suggCell.querySelector('.dq-btn-confirm').addEventListener('click', () => {
            const sel = tr.querySelector('.dq-select');
            sel.value = result.categorie;
            sel.dispatchEvent(new Event('change'));
            tr.classList.add('dq-row-confirmed');
            suggCell.querySelector('.dq-sugg-actions').innerHTML = '<span class="dq-confirmed-badge">Confirmé</span>';
        });

        suggCell.querySelector('.dq-btn-edit').addEventListener('click', () => {
            tr.querySelector('.dq-select').focus();
        });
    }

    async function suggestForRow(tr, row, categories) {
        const suggCell = tr.querySelector('.dq-suggestion');
        suggCell.innerHTML = '<span class="dq-loading">Analyse...</span>';

        try {
            const result = await callClaudeForCategory(row.libelle, row.montant, row.sens, categories);
            displaySuggestion(tr, result, categories);
        } catch (e) {
            suggCell.innerHTML = `<span class="dq-sugg-error" title="${escapeHtml(e.message)}">Erreur</span>`;
        }
    }

    // ── Batch suggest: groups of 5 transactions per API call ──
    const BATCH_SIZE = 5;

    async function suggestBatch(trs, rows, categories, suggestBtn) {
        const pending = [];
        for (let i = 0; i < trs.length; i++) {
            const tr = trs[i];
            if (tr.querySelector('.dq-empty')) continue;
            if (tr.classList.contains('dq-row-confirmed')) continue;
            pending.push({ tr, row: rows[i], index: i });
        }

        if (pending.length === 0) return;

        let processed = 0;
        for (let b = 0; b < pending.length; b += BATCH_SIZE) {
            const batch = pending.slice(b, b + BATCH_SIZE);

            // Show loading state for this batch
            batch.forEach(({ tr }) => {
                tr.querySelector('.dq-suggestion').innerHTML = '<span class="dq-loading">Analyse...</span>';
            });

            suggestBtn.textContent = `Analyse... (${processed}/${pending.length})`;

            try {
                const results = await callClaudeBatch(
                    batch.map(({ row }) => ({ libelle: row.libelle, montant: row.montant, sens: row.sens })),
                    categories
                );

                // Map results back to rows
                const resultArray = Array.isArray(results) ? results : [results];
                batch.forEach(({ tr }, j) => {
                    if (resultArray[j]) {
                        displaySuggestion(tr, resultArray[j], categories);
                    } else {
                        tr.querySelector('.dq-suggestion').innerHTML = '<span class="dq-sugg-error">Pas de réponse</span>';
                    }
                });
            } catch (e) {
                // Fallback: try individually for this batch
                for (const { tr, row } of batch) {
                    await suggestForRow(tr, row, categories);
                    await new Promise(r => setTimeout(r, 500));
                }
            }

            processed += batch.length;

            // Small delay between batches to avoid rate limits
            if (b + BATCH_SIZE < pending.length) {
                await new Promise(r => setTimeout(r, 800));
            }
        }
    }

    function renderDataQuality() {
        // Re-apply learned rules to ensure all months reflect latest rules
        categorizeAll(rawData);

        const allDivers = rawData.filter(r => r.sens === 'Décaissement' && r.categorie === 'DIVERS' && !r.manualCategory);
        const allAutres = rawData.filter(r => r.sens === 'Encaissement' && r.categorie === 'Autres revenus' && !r.manualCategory);

        populateDqMonthFilter();

        const filterByMonth = (rows) => {
            if (!dqSelectedMonths) return rows; // null = all selected
            return rows.filter(r => { const k = getDqMonthKey(r); return k && dqSelectedMonths.has(k); });
        };

        const diversRows = filterByMonth(allDivers);
        const autresRows = filterByMonth(allAutres);

        $('#dq-count-divers').textContent = diversRows.length;
        $('#dq-count-autres').textContent = autresRows.length;

        renderDqTable('dq-body-divers', diversRows, DEC_CATEGORIES, 'dq-bulk-divers', 'dq-suggest-divers');
        renderDqTable('dq-body-autres', autresRows, ENC_CATEGORIES, 'dq-bulk-autres', 'dq-suggest-autres');
        updateSuggestButtons();
        wireDqCollapsible();
        renderLearnedRules();
    }

    // Month filter is now driven by button clicks (toggleDqMonth, dq-select-all, dq-select-none)

    // ── DQ section collapse/expand ──
    const _dqGroupCollapsed = { dec: true, enc: true }; // collapsed by default
    let _dqCollapsibleWired = false;
    function wireDqCollapsible() {
        // Sync collapsed state to DOM each render
        document.querySelectorAll('.dq-collapsible').forEach(section => {
            const groupId = section.dataset.dqGroup;
            if (_dqGroupCollapsed[groupId]) {
                section.classList.add('dq-collapsed');
            } else {
                section.classList.remove('dq-collapsed');
            }
        });

        if (_dqCollapsibleWired) return;
        document.querySelectorAll('.dq-collapsible').forEach(section => {
            const groupId = section.dataset.dqGroup;
            const header = section.querySelector('.dq-section-toggle');
            if (!header) return;
            header.addEventListener('click', (e) => {
                if (e.target.closest('.dq-section-actions')) return;
                section.classList.toggle('dq-collapsed');
                _dqGroupCollapsed[groupId] = section.classList.contains('dq-collapsed');
            });
        });
        _dqCollapsibleWired = true;
    }

    const DQ_PAGE_SIZE = 25;
    const _dqPageState = {};

    function renderDqTable(tbodyId, rows, categories, bulkBtnId, suggestBtnId) {
        const tbody = document.getElementById(tbodyId);
        const bulkBtn = document.getElementById(bulkBtnId);
        const suggestBtn = document.getElementById(suggestBtnId);
        if (rows.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" class="dq-empty">Aucune transaction à reclasser.</td></tr>`;
            bulkBtn.disabled = true;
            // Remove any existing pagination
            const existingPag = tbody.closest('.dq-section-body').querySelector('.dq-pagination');
            if (existingPag) existingPag.remove();
            return;
        }

        // Init page state
        if (!_dqPageState[tbodyId]) _dqPageState[tbodyId] = 0;
        const totalPages = Math.ceil(rows.length / DQ_PAGE_SIZE);
        if (_dqPageState[tbodyId] >= totalPages) _dqPageState[tbodyId] = totalPages - 1;
        const currentPage = _dqPageState[tbodyId];
        const startIdx = currentPage * DQ_PAGE_SIZE;
        const pageRows = rows.slice(startIdx, startIdx + DQ_PAGE_SIZE);

        tbody.innerHTML = '';
        pageRows.forEach((row, i) => {
            const tr = document.createElement('tr');
            const idx = rawData.indexOf(row);

            const options = categories.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');

            tr.innerHTML = `
                <td class="dq-cell-check"><input type="checkbox" class="dq-check"></td>
                <td>${escapeHtml(row.dateStr || '')}</td>
                <td class="dq-cell-libelle">${escapeHtml(row.libelle)}</td>
                <td class="text-right" style="white-space:nowrap">${formatCurrency(row.montant)}</td>
                <td class="dq-suggestion"></td>
                <td><select class="dq-select" data-idx="${idx}"><option value="">— Choisir —</option>${options}</select></td>
            `;
            tbody.appendChild(tr);

            // Check for learned suggestion
            const learnedCat = findLearnedCategory(normUpper(row.libelle), row.sens);
            if (learnedCat && categories.includes(learnedCat)) {
                const suggCell = tr.querySelector('.dq-suggestion');
                suggCell.innerHTML = `<div class="dq-sugg-result dq-sugg-learned">
                    <div class="dq-sugg-cat">${escapeHtml(learnedCat)}</div>
                    <div class="dq-sugg-reason">Suggestion basée sur vos reclassements précédents</div>
                    <div class="dq-sugg-actions">
                        <button class="dq-btn-confirm" data-cat="${escapeHtml(learnedCat)}" title="Confirmer">Appliquer</button>
                    </div>
                </div>`;
                suggCell.querySelector('.dq-btn-confirm').addEventListener('click', () => {
                    const sel = tr.querySelector('.dq-select');
                    sel.value = learnedCat;
                    sel.dispatchEvent(new Event('change'));
                    tr.classList.add('dq-row-confirmed');
                    suggCell.querySelector('.dq-sugg-actions').innerHTML = '<span class="dq-confirmed-badge">Appliqué</span>';
                });
            }
        });

        // ── Pagination controls ──
        const sectionBody = tbody.closest('.dq-section-body');
        let pagEl = sectionBody.querySelector('.dq-pagination');
        if (!pagEl) {
            pagEl = document.createElement('div');
            pagEl.className = 'dq-pagination';
            sectionBody.appendChild(pagEl);
        }
        if (totalPages <= 1) {
            pagEl.innerHTML = '';
        } else {
            const from = startIdx + 1;
            const to = Math.min(startIdx + DQ_PAGE_SIZE, rows.length);
            pagEl.innerHTML = `
                <button class="dq-pag-btn" data-dir="prev" ${currentPage === 0 ? 'disabled' : ''}>&lsaquo; Préc.</button>
                <span class="dq-pag-info">${from}–${to} sur ${rows.length}</span>
                <button class="dq-pag-btn" data-dir="next" ${currentPage >= totalPages - 1 ? 'disabled' : ''}>Suiv. &rsaquo;</button>
            `;
            pagEl.querySelectorAll('.dq-pag-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    if (btn.dataset.dir === 'prev' && _dqPageState[tbodyId] > 0) {
                        _dqPageState[tbodyId]--;
                    } else if (btn.dataset.dir === 'next' && _dqPageState[tbodyId] < totalPages - 1) {
                        _dqPageState[tbodyId]++;
                    }
                    renderDqTable(tbodyId, rows, categories, bulkBtnId, suggestBtnId);
                });
            });
        }

        function updateBulkBtn() {
            const anyFilled = tbody.querySelector('.dq-select') &&
                [...tbody.querySelectorAll('.dq-select')].some(s => s.value);
            bulkBtn.disabled = !anyFilled;
        }

        // Propagation : changer la catégorie d'une ligne COCHÉE applique la même valeur
        // à toutes les lignes cochées de la page (sélection multiple).
        function propagateIfChecked(changedSel) {
            const srcRow = changedSel.closest('tr');
            const srcChk = srcRow && srcRow.querySelector('.dq-check');
            if (!srcChk || !srcChk.checked) return;
            const val = changedSel.value;
            tbody.querySelectorAll('tr').forEach(r => {
                const c = r.querySelector('.dq-check');
                const s = r.querySelector('.dq-select');
                if (c && c.checked && s && s !== changedSel) s.value = val;
            });
        }

        tbody.querySelectorAll('.dq-select').forEach(sel => {
            sel.addEventListener('change', () => { propagateIfChecked(sel); updateBulkBtn(); });
        });

        // Case « tout sélectionner » de l'en-tête (portée : page courante)
        const dqTable = tbody.closest('table');
        const checkAll = dqTable && dqTable.querySelector('.dq-check-all');
        if (checkAll) {
            checkAll.checked = false;
            checkAll.onchange = () => {
                tbody.querySelectorAll('.dq-check').forEach(c => { c.checked = checkAll.checked; });
            };
        }

        // Bulk suggest all via Claude API (batched) — current page only
        suggestBtn.onclick = async () => {
            if (!getDqApiKey()) return;
            suggestBtn.disabled = true;
            const trs = tbody.querySelectorAll('tr');
            await suggestBatch([...trs], pageRows, categories, suggestBtn);
            suggestBtn.textContent = 'Suggérer tout (IA)';
            suggestBtn.disabled = !getDqApiKey();
        };

        // Bulk apply all selected categories (current page)
        bulkBtn.onclick = async () => {
            const selects = tbody.querySelectorAll('.dq-select');
            const toApply = [];
            selects.forEach(sel => {
                if (sel.value) toApply.push({ idx: parseInt(sel.dataset.idx), cat: sel.value });
            });
            if (toApply.length === 0) return;
            const learnEntries = [];
            toApply.forEach(({ idx, cat }) => {
                const row = rawData[idx];
                if (!row) return;
                row.categorie = cat;
                row.manualCategory = cat;
                row.ruleHit = 'DQ: Reclassement manuel';
                learnEntries.push({ libelle: row.libelle, category: cat, sens: row.sens });
            });
            await learnCategoryBatch(learnEntries);
            // Auto-validate: apply new rules to ALL matching unclassified rows
            for (const { libelle, category, sens } of learnEntries) {
                const ruleKey = cleanLibelleForLearning(libelle);
                if (ruleKey.length < 3) continue;
                applyRuleToDqRows(ruleKey, { category, sens });
            }
            await saveToStorage();
            computeFilteredData();
            renderDataQuality();
            renderLearnedRules();
            refreshDashboard();
        };
    }


    // ══════════════════════════════════════════════
    //  SIMULATION TAB
    // ══════════════════════════════════════════════

    let simActiveModel = 'seasonal';
    const SIM_MONTHS_AHEAD = 3;

    // ── Helper: get sorted unique month keys from rawData ──
    function getHistoricalMonths() {
        const set = new Set();
        rawData.forEach(r => { const k = getMonthKey(r); if (k) set.add(k); });
        return [...set].sort();
    }

    function monthKeyToLabel(k) {
        const [y, m] = k.split('-');
        return MONTH_NAMES[parseInt(m) - 1] + ' ' + y;
    }

    function nextMonthKey(k) {
        let [y, m] = k.split('-').map(Number);
        m++;
        if (m > 12) { m = 1; y++; }
        return y + '-' + String(m).padStart(2, '0');
    }

    function getFutureMonthKeys(count) {
        const months = getHistoricalMonths();
        let last = months.length > 0 ? months[months.length - 1] : new Date().getFullYear() + '-' + String(new Date().getMonth() + 1).padStart(2, '0');
        const result = [];
        for (let i = 0; i < count; i++) {
            last = nextMonthKey(last);
            result.push(last);
        }
        return result;
    }

    // ── Aggregate historical monthly data by category ──
    function getMonthlyByCat(sens) {
        const map = {}; // { cat: { monthKey: total } }
        rawData.forEach(r => {
            if (r.sens !== sens) return;
            const mk = getMonthKey(r);
            if (!mk) return;
            const cat = r.categorie || 'Autre';
            if (!map[cat]) map[cat] = {};
            map[cat][mk] = (map[cat][mk] || 0) + Math.abs(r.montant);
        });
        return map;
    }

    // ── MODEL 1: Recurring pattern (median by category) ──
    function projectSeasonal() {
        const histMonths = getHistoricalMonths();
        const futureKeys = getFutureMonthKeys(SIM_MONTHS_AHEAD);
        const n = histMonths.length;
        if (n === 0) return { futureKeys, enc: [], dec: [], encDetail: {}, decDetail: {} };

        // Compute overall monthly totals for seasonal index
        const monthlyEncTotals = {};
        const monthlyDecTotals = {};
        rawData.forEach(r => {
            const mk = getMonthKey(r);
            if (!mk) return;
            if (r.montant > 0) monthlyEncTotals[mk] = (monthlyEncTotals[mk] || 0) + r.montant;
            else monthlyDecTotals[mk] = (monthlyDecTotals[mk] || 0) + Math.abs(r.montant);
        });

        // Compute seasonal indices by calendar month (1-12)
        // Group historical values by calendar month, then index = avg(month) / avg(all)
        function computeSeasonalIndices(monthlyTotals) {
            const byCalMonth = {};  // { 1: [val, val], 2: [...], ... }
            let allSum = 0, allCount = 0;
            histMonths.forEach(mk => {
                const calMonth = parseInt(mk.split('-')[1]);
                const val = monthlyTotals[mk] || 0;
                if (!byCalMonth[calMonth]) byCalMonth[calMonth] = [];
                byCalMonth[calMonth].push(val);
                allSum += val;
                allCount++;
            });
            const globalAvg = allCount > 0 ? allSum / allCount : 1;
            const indices = {};
            for (let m = 1; m <= 12; m++) {
                if (byCalMonth[m] && byCalMonth[m].length > 0) {
                    const monthAvg = byCalMonth[m].reduce((s, v) => s + v, 0) / byCalMonth[m].length;
                    indices[m] = globalAvg > 0 ? monthAvg / globalAvg : 1;
                } else {
                    indices[m] = 1; // no data for this month, assume average
                }
            }
            return indices;
        }

        const encSeasonalIdx = computeSeasonalIndices(monthlyEncTotals);
        const decSeasonalIdx = computeSeasonalIndices(monthlyDecTotals);

        // Median by category (baseline)
        function medianByCat(sens) {
            const catMap = getMonthlyByCat(sens);
            const result = {};
            for (const cat in catMap) {
                const vals = histMonths.map(mk => catMap[cat][mk] || 0);
                const recent = vals.slice(-6);
                if (recent.every(v => v === 0)) continue;
                const sorted = [...recent].filter(v => v > 0).sort((a, b) => a - b);
                if (sorted.length === 0) { result[cat] = 0; continue; }
                const mid = Math.floor(sorted.length / 2);
                result[cat] = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
            }
            return result;
        }

        const encMedians = medianByCat('Encaissement');
        const decMedians = medianByCat('Décaissement');

        const baseEnc = Object.values(encMedians).reduce((s, v) => s + v, 0);
        const baseDec = Object.values(decMedians).reduce((s, v) => s + v, 0);

        // Apply seasonal index per future month
        const enc = [];
        const dec = [];
        const encDetails = [];
        const decDetails = [];
        futureKeys.forEach(mk => {
            const calMonth = parseInt(mk.split('-')[1]);
            const encIdx = encSeasonalIdx[calMonth] || 1;
            const decIdx = decSeasonalIdx[calMonth] || 1;
            enc.push(baseEnc * encIdx);
            dec.push(baseDec * decIdx);
            // Per-category detail adjusted by seasonal index
            const ed = {};
            for (const cat in encMedians) ed[cat] = encMedians[cat] * encIdx;
            encDetails.push(ed);
            const dd = {};
            for (const cat in decMedians) dd[cat] = decMedians[cat] * decIdx;
            decDetails.push(dd);
        });

        return { futureKeys, enc, dec, encDetail: encDetails, decDetail: decDetails };
    }

    // ── MODEL 2: Weighted Moving Average ──
    function projectWMA() {
        const histMonths = getHistoricalMonths();
        const futureKeys = getFutureMonthKeys(SIM_MONTHS_AHEAD);
        const n = histMonths.length;
        if (n === 0) return { futureKeys, enc: [], dec: [], encDetail: {}, decDetail: {} };

        // Aggregate monthly totals
        const monthlyEnc = {};
        const monthlyDec = {};
        rawData.forEach(r => {
            const mk = getMonthKey(r);
            if (!mk) return;
            if (r.montant > 0) monthlyEnc[mk] = (monthlyEnc[mk] || 0) + r.montant;
            else monthlyDec[mk] = (monthlyDec[mk] || 0) + Math.abs(r.montant);
        });

        function wma(series, window) {
            const vals = histMonths.map(mk => series[mk] || 0);
            const w = Math.min(window, vals.length);
            const recent = vals.slice(-w);
            // Weights: 1, 2, 3, ... w (more recent = more weight)
            const totalWeight = w * (w + 1) / 2;
            let sum = 0;
            recent.forEach((v, i) => { sum += v * (i + 1); });
            return sum / totalWeight;
        }

        // Also compute WMA per category for detail
        function wmaByCat(sens) {
            const catMap = getMonthlyByCat(sens);
            const result = {};
            for (const cat in catMap) {
                const vals = histMonths.map(mk => catMap[cat][mk] || 0);
                const w = Math.min(6, vals.length);
                const recent = vals.slice(-w);
                if (recent.every(v => v === 0)) continue;
                const totalWeight = w * (w + 1) / 2;
                let s = 0;
                recent.forEach((v, i) => { s += v * (i + 1); });
                result[cat] = s / totalWeight;
            }
            return result;
        }

        const encWma = wma(monthlyEnc, 6);
        const decWma = wma(monthlyDec, 6);
        const encBaseCats = wmaByCat('Encaissement');
        const decBaseCats = wmaByCat('Décaissement');

        // Apply slight trend: compute growth rate from last 3 vs previous 3
        function trend(series) {
            const vals = histMonths.map(mk => series[mk] || 0);
            if (vals.length < 4) return 1;
            const recent3 = vals.slice(-3).reduce((s, v) => s + v, 0) / 3;
            const prev3 = vals.slice(-6, -3);
            if (prev3.length === 0) return 1;
            const prevAvg = prev3.reduce((s, v) => s + v, 0) / prev3.length;
            if (prevAvg === 0) return 1;
            const growth = recent3 / prevAvg;
            return Math.max(0.8, Math.min(1.2, growth));
        }

        const encTrend = trend(monthlyEnc);
        const decTrend = trend(monthlyDec);

        const enc = [];
        const dec = [];
        const encDetail = [];
        const decDetail = [];
        for (let i = 0; i < SIM_MONTHS_AHEAD; i++) {
            const encFactor = Math.pow(encTrend, i);
            const decFactor = Math.pow(decTrend, i);
            enc.push(encWma * encFactor);
            dec.push(decWma * decFactor);
            const ed = {};
            for (const cat in encBaseCats) ed[cat] = encBaseCats[cat] * encFactor;
            encDetail.push(ed);
            const dd = {};
            for (const cat in decBaseCats) dd[cat] = decBaseCats[cat] * decFactor;
            decDetail.push(dd);
        }

        return { futureKeys, enc, dec, encDetail, decDetail };
    }

    // ── Render projection ──
    function renderSimProjection() {
        const proj = simActiveModel === 'seasonal' ? projectSeasonal() : projectWMA();
        const futureKeys = proj.futureKeys;

        // Historical months for context (last 3)
        const histMonths = getHistoricalMonths().slice(-3);
        const monthlyEnc = {};
        const monthlyDec = {};
        rawData.forEach(r => {
            const mk = getMonthKey(r);
            if (!mk) return;
            if (r.montant > 0) monthlyEnc[mk] = (monthlyEnc[mk] || 0) + r.montant;
            else monthlyDec[mk] = (monthlyDec[mk] || 0) + Math.abs(r.montant);
        });

        const allKeys = [...histMonths, ...futureKeys];
        const labels = allKeys.map(monthKeyToLabel);
        const encVals = allKeys.map((k, i) => {
            if (i < histMonths.length) return monthlyEnc[k] || 0;
            return proj.enc[i - histMonths.length] || 0;
        });
        const decVals = allKeys.map((k, i) => {
            if (i < histMonths.length) return monthlyDec[k] || 0;
            return proj.dec[i - histMonths.length] || 0;
        });
        const netVals = encVals.map((e, i) => e - decVals[i]);

        // KPIs
        const totalEnc = proj.enc.reduce((s, v) => s + v, 0);
        const totalDec = proj.dec.reduce((s, v) => s + v, 0);
        $('#sim-proj-enc').textContent = formatCurrency(totalEnc);
        $('#sim-proj-dec').textContent = formatCurrency(-totalDec);
        $('#sim-proj-net').textContent = formatCurrency(totalEnc - totalDec);
        $('#sim-proj-net').className = 'sim-kpi-value ' + (totalEnc - totalDec >= 0 ? 'sim-positive' : 'sim-negative');

        // Chart
        destroyChart('simProjection');
        const ctx = $('#chart-sim-projection').getContext('2d');
        const defaults = getChartDefaults();

        const bgColors = allKeys.map((_, i) => i < histMonths.length ? 'rgba(99,102,241,0.6)' : 'rgba(99,102,241,0.25)');
        const bgColorsDec = allKeys.map((_, i) => i < histMonths.length ? 'rgba(248,113,113,0.6)' : 'rgba(248,113,113,0.25)');
        const borderDash = allKeys.map((_, i) => i < histMonths.length ? [] : [5, 5]);

        charts.simProjection = new Chart(ctx, {
            type: 'bar',
            data: {
                labels,
                datasets: [
                    {
                        label: 'Encaissements',
                        data: encVals,
                        backgroundColor: bgColors,
                        borderColor: 'rgba(99,102,241,0.8)',
                        borderWidth: 1,
                        borderDash: undefined,
                    },
                    {
                        label: 'Décaissements',
                        data: decVals.map(v => -v),
                        backgroundColor: bgColorsDec,
                        borderColor: 'rgba(248,113,113,0.8)',
                        borderWidth: 1,
                    },
                    {
                        label: 'Solde net',
                        data: netVals,
                        type: 'line',
                        borderColor: '#facc15',
                        backgroundColor: 'transparent',
                        borderWidth: 2,
                        pointRadius: 4,
                        pointBackgroundColor: '#facc15',
                        segment: {
                            borderDash: ctx2 => ctx2.p0DataIndex >= histMonths.length - 1 ? [5, 5] : undefined,
                        },
                    },
                ]
            },
            options: {
                ...defaults,
                plugins: {
                    ...defaults.plugins,
                    annotation: {
                        annotations: {
                            projLine: {
                                type: 'line',
                                xMin: histMonths.length - 0.5,
                                xMax: histMonths.length - 0.5,
                                borderColor: 'rgba(255,255,255,0.2)',
                                borderWidth: 1,
                                borderDash: [4, 4],
                                label: {
                                    display: true,
                                    content: 'Projection',
                                    position: 'start',
                                    color: 'rgba(255,255,255,0.5)',
                                    font: { size: 10 },
                                }
                            }
                        }
                    },
                    tooltip: {
                        callbacks: {
                            label: (ctx) => ctx.dataset.label + ': ' + formatCurrency(ctx.parsed.y)
                        }
                    }
                },
                scales: {
                    x: { ticks: { color: 'rgba(255,255,255,0.6)', font: { size: 11 } }, grid: { color: 'rgba(255,255,255,0.05)' } },
                    y: { ticks: { color: 'rgba(255,255,255,0.6)', callback: v => formatCurrency(v) }, grid: { color: 'rgba(255,255,255,0.05)' } }
                }
            }
        });

        // Detail table
        const thead = document.getElementById('sim-proj-thead');
        const tbody = document.getElementById('sim-proj-tbody');
        thead.innerHTML = `<tr><th>Catégorie</th>${futureKeys.map(k => `<th class="text-right">${monthKeyToLabel(k)}</th>`).join('')}<th class="text-right">Total</th></tr>`;

        // Collect all category names from detail arrays
        const encCats = new Set();
        const decCats = new Set();
        proj.encDetail.forEach(d => Object.keys(d).forEach(c => encCats.add(c)));
        proj.decDetail.forEach(d => Object.keys(d).forEach(c => decCats.add(c)));

        let rows = '';
        // Enc detail
        rows += `<tr class="sim-section-row"><td colspan="${futureKeys.length + 2}">Encaissements</td></tr>`;
        for (const cat of encCats) {
            rows += `<tr><td>${escapeHtml(cat)}</td>`;
            let total = 0;
            futureKeys.forEach((_, i) => {
                const v = proj.encDetail[i][cat] || 0;
                total += v;
                rows += `<td class="text-right">${formatCurrency(v)}</td>`;
            });
            rows += `<td class="text-right sim-total-cell">${formatCurrency(total)}</td></tr>`;
        }
        rows += `<tr class="sim-subtotal-row"><td>Total Encaissements</td>${futureKeys.map((_, i) => `<td class="text-right">${formatCurrency(proj.enc[i])}</td>`).join('')}<td class="text-right">${formatCurrency(totalEnc)}</td></tr>`;

        // Dec detail
        rows += `<tr class="sim-section-row"><td colspan="${futureKeys.length + 2}">Décaissements</td></tr>`;
        for (const cat of decCats) {
            rows += `<tr><td>${escapeHtml(cat)}</td>`;
            let total = 0;
            futureKeys.forEach((_, i) => {
                const v = proj.decDetail[i][cat] || 0;
                total += v;
                rows += `<td class="text-right">${formatCurrency(-v)}</td>`;
            });
            rows += `<td class="text-right sim-total-cell">${formatCurrency(-total)}</td></tr>`;
        }
        rows += `<tr class="sim-subtotal-row"><td>Total Décaissements</td>${futureKeys.map((_, i) => `<td class="text-right">${formatCurrency(-proj.dec[i])}</td>`).join('')}<td class="text-right">${formatCurrency(-totalDec)}</td></tr>`;

        // Net
        rows += `<tr class="sim-net-row"><td>Solde net</td>${futureKeys.map((_, i) => {
            const net = proj.enc[i] - proj.dec[i];
            return `<td class="text-right ${net >= 0 ? 'sim-positive' : 'sim-negative'}">${formatCurrency(net)}</td>`;
        }).join('')}<td class="text-right ${totalEnc - totalDec >= 0 ? 'sim-positive' : 'sim-negative'}">${formatCurrency(totalEnc - totalDec)}</td></tr>`;

        tbody.innerHTML = rows;
    }

    // ── Model explanations ──
    const MODEL_EXPLANATIONS = {
        seasonal: `<strong>Modèle saisonnier</strong> — Ce modèle calcule la <em>médiane</em> de chaque catégorie sur les 6 derniers mois, puis applique un <em>coefficient saisonnier</em> par mois calendaire. Ce coefficient est calculé en comparant la moyenne historique de chaque mois (janvier, février…) à la moyenne globale. <br><span class="sim-explain-tip">Interprétation : les montants projetés varient d'un mois à l'autre selon la saisonnalité observée dans vos données. Un mois historiquement fort (ex. septembre) aura un coefficient &gt; 1, un mois faible (ex. août) un coefficient &lt; 1. Plus vous avez de mois d'historique, plus la saisonnalité est fiable.</span>`,
        wma: `<strong>Moyennes mobiles pondérées</strong> — Ce modèle calcule une moyenne pondérée sur 6 mois (les mois récents pèsent davantage) et intègre la <em>tendance</em> observée entre les 3 derniers mois et les 3 précédents. <br><span class="sim-explain-tip">Interprétation : les projections reflètent la dynamique récente de votre trésorerie. Si vos revenus augmentent, la projection prolonge cette tendance (plafonnée à ±20% par mois). Préférez ce modèle si votre activité est en croissance ou en déclin.</span>`
    };

    function updateModelExplanation() {
        const el = document.getElementById('sim-model-explain');
        if (el) el.innerHTML = MODEL_EXPLANATIONS[simActiveModel] || '';
    }

    // ── Model toggle ──
    document.querySelectorAll('.sim-model-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.sim-model-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            simActiveModel = btn.dataset.model;
            renderSimProjection();
            updateModelExplanation();
        });
    });

    // ══════════════════════════════════════════════
    //  SIMULATION PANEL 2: Manual Inputs
    // ══════════════════════════════════════════════

    const SIM_ENC_CATS = ['B2B', 'Financement personnel', 'OPCO', 'CPF', 'Reconversion', 'Autres revenus'];
    const SIM_DEC_CATS = [
        'Salaires', 'URSSAF', 'Formateurs / Freelances', 'SaaS/IT',
        'Frais généraux & services', 'Note de frais', 'Marketing & Acquisition',
        'Prévoyance / Mutuelle', 'Ticket restaurant', 'Loyers & charges',
        'Banques/Dettes', 'Autres impôts',
    ];
    const SIM_ENC_DELAYS = { 'B2B': 45, 'Financement personnel': 0, 'OPCO': 60, 'CPF': 30, 'Reconversion': 30, 'Autres revenus': 0 };

    function buildSimInputs() {
        // Pre-fill from historical averages
        const histMonths = getHistoricalMonths();
        const n = Math.min(6, histMonths.length);

        function avgByCat(sens, cats) {
            const catMap = getMonthlyByCat(sens);
            const result = {};
            cats.forEach(cat => {
                const vals = histMonths.slice(-n).map(mk => (catMap[cat] && catMap[cat][mk]) || 0);
                result[cat] = n > 0 ? vals.reduce((s, v) => s + v, 0) / n : 0;
            });
            return result;
        }

        const encAvgs = avgByCat('Encaissement', SIM_ENC_CATS);
        const decAvgs = avgByCat('Décaissement', SIM_DEC_CATS);

        // Enc inputs
        const encContainer = document.getElementById('sim-enc-inputs');
        encContainer.innerHTML = SIM_ENC_CATS.map(cat => `
            <div class="sim-input-group">
                <label>${escapeHtml(cat)}</label>
                <div class="sim-input-pair">
                    <div class="sim-field">
                        <span class="sim-field-label">Ventes/mois (€)</span>
                        <input type="number" class="sim-input" data-cat="${escapeHtml(cat)}" data-field="amount"
                               value="${Math.round(encAvgs[cat] || 0)}" step="100" />
                    </div>
                    <div class="sim-field">
                        <span class="sim-field-label">Délai encaissement (j)</span>
                        <input type="number" class="sim-input" data-cat="${escapeHtml(cat)}" data-field="delay"
                               value="${SIM_ENC_DELAYS[cat] || 0}" step="5" min="0" />
                    </div>
                </div>
            </div>
        `).join('');

        // Dec inputs
        const decContainer = document.getElementById('sim-dec-inputs');
        decContainer.innerHTML = SIM_DEC_CATS.map(cat => `
            <div class="sim-input-group">
                <label>${escapeHtml(cat)}</label>
                <input type="number" class="sim-input" data-cat="${escapeHtml(cat)}" data-field="decAmount"
                       value="${Math.round(decAvgs[cat] || 0)}" step="100" />
            </div>
        `).join('');
    }

    function runSimulation() {
        const futureKeys = getFutureMonthKeys(SIM_MONTHS_AHEAD);
        const soldeInitial = parseFloat($('#sim-solde-initial').value) || 0;

        // Read enc inputs
        const encInputs = {};
        document.querySelectorAll('#sim-enc-inputs input[data-field="amount"]').forEach(inp => {
            encInputs[inp.dataset.cat] = { amount: parseFloat(inp.value) || 0 };
        });
        document.querySelectorAll('#sim-enc-inputs input[data-field="delay"]').forEach(inp => {
            if (encInputs[inp.dataset.cat]) encInputs[inp.dataset.cat].delay = parseInt(inp.value) || 0;
        });

        // Read dec inputs
        const decInputs = {};
        document.querySelectorAll('#sim-dec-inputs input[data-field="decAmount"]').forEach(inp => {
            decInputs[inp.dataset.cat] = parseFloat(inp.value) || 0;
        });

        // Compute monthly enc with delay offset
        const encByMonth = futureKeys.map(() => 0);
        const encDetailByMonth = {};
        for (const cat in encInputs) {
            const { amount, delay } = encInputs[cat];
            if (amount === 0) continue;
            const delayMonths = Math.round((delay || 0) / 30);
            encDetailByMonth[cat] = futureKeys.map(() => 0);
            futureKeys.forEach((_, i) => {
                const targetMonth = i + delayMonths;
                if (targetMonth < SIM_MONTHS_AHEAD) {
                    encByMonth[targetMonth] += amount;
                    encDetailByMonth[cat][targetMonth] += amount;
                }
            });
        }

        // Compute monthly dec
        const decByMonth = futureKeys.map(() => 0);
        const decDetailByMonth = {};
        for (const cat in decInputs) {
            const amount = decInputs[cat];
            if (amount === 0) continue;
            decDetailByMonth[cat] = futureKeys.map(() => amount);
            futureKeys.forEach((_, i) => { decByMonth[i] += amount; });
        }

        // Cumulative solde
        const solde = [];
        let running = soldeInitial;
        futureKeys.forEach((_, i) => {
            running += encByMonth[i] - decByMonth[i];
            solde.push(running);
        });

        // Show results
        const totalEnc = encByMonth.reduce((s, v) => s + v, 0);
        const totalDec = decByMonth.reduce((s, v) => s + v, 0);
        const soldeFinal = solde[solde.length - 1] || soldeInitial;

        $('#sim-man-enc').textContent = formatCurrency(totalEnc);
        $('#sim-man-dec').textContent = formatCurrency(-totalDec);
        $('#sim-man-solde').textContent = formatCurrency(soldeFinal);
        $('#sim-man-solde').className = 'sim-kpi-value ' + (soldeFinal >= 0 ? 'sim-positive' : 'sim-negative');

        $('#sim-manual-kpis').style.display = '';
        $('#sim-manual-chart-wrap').style.display = '';
        $('#sim-manual-table-wrap').style.display = '';

        // Chart
        destroyChart('simManual');
        const ctx = $('#chart-sim-manual').getContext('2d');
        const defaults = getChartDefaults();

        charts.simManual = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: futureKeys.map(monthKeyToLabel),
                datasets: [
                    {
                        label: 'Encaissements',
                        data: encByMonth,
                        backgroundColor: 'rgba(99,102,241,0.5)',
                        borderColor: 'rgba(99,102,241,0.8)',
                        borderWidth: 1,
                    },
                    {
                        label: 'Décaissements',
                        data: decByMonth.map(v => -v),
                        backgroundColor: 'rgba(248,113,113,0.5)',
                        borderColor: 'rgba(248,113,113,0.8)',
                        borderWidth: 1,
                    },
                    {
                        label: 'Solde cumulé',
                        data: solde,
                        type: 'line',
                        borderColor: '#4ade80',
                        backgroundColor: 'transparent',
                        borderWidth: 2,
                        pointRadius: 5,
                        pointBackgroundColor: solde.map(v => v >= 0 ? '#4ade80' : '#f87171'),
                        yAxisID: 'y1',
                    },
                ]
            },
            options: {
                ...defaults,
                plugins: {
                    ...defaults.plugins,
                    tooltip: {
                        callbacks: {
                            label: (ctx) => ctx.dataset.label + ': ' + formatCurrency(ctx.parsed.y)
                        }
                    }
                },
                scales: {
                    x: { ticks: { color: 'rgba(255,255,255,0.6)', font: { size: 11 } }, grid: { color: 'rgba(255,255,255,0.05)' } },
                    y: { position: 'left', ticks: { color: 'rgba(255,255,255,0.6)', callback: v => formatCurrency(v) }, grid: { color: 'rgba(255,255,255,0.05)' } },
                    y1: { position: 'right', ticks: { color: 'rgba(74,222,128,0.6)', callback: v => formatCurrency(v) }, grid: { display: false } }
                }
            }
        });

        // Detail table
        const thead = document.getElementById('sim-manual-thead');
        const tbody = document.getElementById('sim-manual-tbody');
        thead.innerHTML = `<tr><th>Catégorie</th>${futureKeys.map(k => `<th class="text-right">${monthKeyToLabel(k)}</th>`).join('')}<th class="text-right">Total</th></tr>`;

        let rows = '';
        rows += `<tr class="sim-section-row"><td colspan="${futureKeys.length + 2}">Encaissements</td></tr>`;
        for (const cat in encDetailByMonth) {
            const vals = encDetailByMonth[cat];
            const total = vals.reduce((s, v) => s + v, 0);
            if (total === 0) continue;
            rows += `<tr><td>${escapeHtml(cat)}</td>${vals.map(v => `<td class="text-right">${formatCurrency(v)}</td>`).join('')}<td class="text-right sim-total-cell">${formatCurrency(total)}</td></tr>`;
        }
        rows += `<tr class="sim-subtotal-row"><td>Total Encaissements</td>${encByMonth.map(v => `<td class="text-right">${formatCurrency(v)}</td>`).join('')}<td class="text-right">${formatCurrency(totalEnc)}</td></tr>`;

        rows += `<tr class="sim-section-row"><td colspan="${futureKeys.length + 2}">Décaissements</td></tr>`;
        for (const cat in decDetailByMonth) {
            const vals = decDetailByMonth[cat];
            const total = vals.reduce((s, v) => s + v, 0);
            if (total === 0) continue;
            rows += `<tr><td>${escapeHtml(cat)}</td>${vals.map(v => `<td class="text-right">${formatCurrency(-v)}</td>`).join('')}<td class="text-right sim-total-cell">${formatCurrency(-total)}</td></tr>`;
        }
        rows += `<tr class="sim-subtotal-row"><td>Total Décaissements</td>${decByMonth.map(v => `<td class="text-right">${formatCurrency(-v)}</td>`).join('')}<td class="text-right">${formatCurrency(-totalDec)}</td></tr>`;

        rows += `<tr class="sim-net-row"><td>Solde net mensuel</td>${futureKeys.map((_, i) => {
            const net = encByMonth[i] - decByMonth[i];
            return `<td class="text-right ${net >= 0 ? 'sim-positive' : 'sim-negative'}">${formatCurrency(net)}</td>`;
        }).join('')}<td class="text-right ${totalEnc - totalDec >= 0 ? 'sim-positive' : 'sim-negative'}">${formatCurrency(totalEnc - totalDec)}</td></tr>`;

        rows += `<tr class="sim-solde-row"><td>Solde cumulé</td>${solde.map(v => `<td class="text-right ${v >= 0 ? 'sim-positive' : 'sim-negative'}">${formatCurrency(v)}</td>`).join('')}<td></td></tr>`;

        tbody.innerHTML = rows;
    }

    // Wire simulation buttons
    $('#sim-btn-run').addEventListener('click', runSimulation);
    $('#sim-btn-reset').addEventListener('click', () => {
        buildSimInputs();
        $('#sim-manual-kpis').style.display = 'none';
        $('#sim-manual-chart-wrap').style.display = 'none';
        $('#sim-manual-table-wrap').style.display = 'none';
        destroyChart('simManual');
    });

    // ── Render projection tab ──
    function renderProjectionTab() {
        if (rawData.length === 0) return;
        renderSimProjection();
        updateModelExplanation();
    }

    // ── Render simulation tab ──
    function renderSimulationTab() {
        if (rawData.length === 0) return;
        buildSimInputs();
    }

    // ── Mouse glow ──
    document.addEventListener('mousemove', (e) => {
        document.documentElement.style.setProperty('--mouse-x', e.clientX + 'px');
        document.documentElement.style.setProperty('--mouse-y', e.clientY + 'px');
    });
})();
