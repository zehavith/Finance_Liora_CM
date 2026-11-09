/* Suivi recouvrement v2 — normalisation des tableaux Monday.
   Un seul code pour l'instantané (exports CSV) et l'actualisation en direct
   (connecteur monday.com) : chaque ligne est lue par le TITRE de ses colonnes,
   qui est le même dans les deux cas. */
(function (G) {
  'use strict';

  var BOARDS = [
    { key: 'payees', id: 1842356810, nom: '0.1. ALL - Factures payées', fin: null, paid: true },
    { key: 'tampon', id: 1818713092, nom: '1.0. Entreprise - Tampon', fin: 'Entreprise' },
    { key: 'adv', id: 1817877566, nom: '1.1. Entreprise - ADV', fin: 'Entreprise' },
    { key: 'recouv', id: 1840539926, nom: '1.2. Entreprise - Recouvrement', fin: 'Entreprise' },
    { key: 'opco', id: 5099882263, nom: '1.3. Entreprise - OPCO', fin: 'OPCO' },
    { key: 'perso', id: 1909949610, nom: '2.1. Financement Personnel', fin: 'Financement personnel' },
    { key: 'cpf', id: 1912012437, nom: '2.2. Financement CPF', fin: 'CPF' },
    { key: 'ft', id: 1912012068, nom: '2.3. Financement pôle emploi : AIF / POEI', fin: 'France Travail' },
    { key: 'region', id: 1912012597, nom: '2.4. Financement complexe : REGION / TRANSITION / AGEFIPH', fin: 'Région / Transition / Agefiph' }
  ];

  var FINANCEURS = ['Entreprise', 'OPCO', 'Financement personnel', 'CPF', 'France Travail', 'Région / Transition / Agefiph'];

  // Les cinq files de travail de la maquette, plus « en cours » (pas encore
  // à traiter) et « autre » (groupe que rien ne classe).
  var FILES = [
    { k: 'adv', n: 'Rendre payable', t: 'ADV', svc: 'ADV', cible: 10, ref: 'facture', d: 'Factures non conformes ou incomplètes, à rendre payables' },
    { k: 'rec', n: 'Relancer', t: 'Recouvrement', svc: 'Recouvrement', cible: 15, ref: 'echeance', d: 'Factures échues à relancer' },
    { k: 'fin', n: 'Clôture', t: 'Contentieux', svc: 'Contentieux', cible: 90, ref: 'echeance', d: 'Contentieux, perdu, attente de décision de passage en perte' },
    { k: 'cor', n: 'Corriger', t: 'Comptabilité', svc: 'Comptabilité', cible: 30, ref: 'echeance', d: 'Paiement reçu non lettré, facture à annuler, toute autre clôture' }
  ];

  // Numéro de groupe Monday → file. Les groupes « Technique » / « Archive »
  // sont écartés comme dans la v1.
  var GROUP_FILE = {
    '1.0.1': 'adv',
    '1.1.1': 'adv', '1.1.2': 'adv', '1.1.3': 'adv', '1.1.4': 'adv', '1.1.5': 'cours',
    '1.2.1': 'rec', '1.2.2': 'adv', '1.2.3': 'rec', '1.2.4': 'fin', '1.2.5': 'fin', '1.2.6': 'rec', '1.2.7': 'rec', '1.2.8': 'cor',
    '1.3.1': 'adv', '1.3.5': 'cours',
    '2.1.1': 'rec', '2.1.1.1': 'rec', '2.1.2': 'cor', '2.1.3': 'cor', '2.1.4': 'rec', '2.1.5': 'rec', '2.1.6': 'fin', '2.1.7': 'cours', '2.1.8': 'cor',
    '2.2.1': 'adv', '2.2.2': 'rec', '2.2.3': 'cor', '2.2.4': 'cor', '2.2.5': 'cours', '2.2.6': 'cor', '2.2.9': 'cor', '2.2.10': 'cor',
    '2.3.1': 'rec', '2.3.3': 'rec', '2.3.5': 'cours', '2.3.6': 'cours', '2.3.7': 'cours', '2.3.9': 'cor', '2.3.10': 'cor',
    '2.4.2': 'rec', '2.4.3': 'rec', '2.4.7': 'cours', '2.4.9': 'cor', '2.4.10': 'cor'
  };

  var PAID_FIN = {
    '0.1.1': 'Entreprise', '0.1.2': 'Entreprise', '0.1.3': 'Entreprise', '0.1.4': 'OPCO',
    '0.1.5': 'Financement personnel', '0.1.6': 'CPF', '0.1.7': 'Région / Transition / Agefiph',
    '0.1.8': 'Région / Transition / Agefiph', '0.1.10': 'France Travail', '0.1.11': 'France Travail'
  };

  function norm(t) {
    return String(t || '').toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();
  }

  // Alias de colonnes, par ordre de préférence.
  var ALIAS = {
    num: ['numero de facture', 'n° facture'],
    reste: ['reste à devoir ttc', 'montant dû ttc', "reste à payer ( d'après le grand livre )", 'montant restant penny', 'montant en recouvrement'],
    total: ['total ttc', 'montant', 'total facture'],
    echeance: ['date échéance calculée / négociée', "date d'échéance calculée", 'date échéance négociée', "date d'échéance facture", "date d'échéance", 'date échéance'],
    facture: ['date facture', 'date de facture'],
    paiement: ['date paiement'],
    client: ['entreprise', 'client', 'raison sociale'],
    apprenant: ['nom prénom apprenant', 'apprenant', "nom & prénom de l'apprenant", 'nom et prénom apprenant', 'nom et prénom'],
    proprio: ['propriétaire'],
    typeClient: ['type de client', 'type client'],
    statut: ['statut', 'statut créance', 'statut 1', 'etat de la facture', 'etat facture'],
    qualif: ['qualifaction recouvrement avec basculement', 'qualification recouvrement', 'qualification générale', 'qualification adv',
      'qualification facture opco', 'groupe / qualification', 'compta qualification', 'avancée etat facture', 'qualification apprenant', 'etat dossier cpf', 'etat dossier'],
    etape: ['etape process recouvrement'],
    promesse: ['date de paiement prévu post-échéance', 'date de paiement prévu recouv', 'date paiement prévue pré ech', 'date de paiement prévue'],
    relance: ['date dernière relance manuelle'],
    bascule: ['date bascule en recouvrement', 'date basculement en recouvrement', 'date passage en recouvrement', 'date qualif recouvrement'],
    commentaire: ['commentaire post echeance', 'commentaire post-échéance', 'commentaire post-échéance / recouvrement ( service recouvrement )',
      'commentaire général', 'commentaires', 'commentaire', 'notes', 'commentaire pré-échance'],
    groupePaye: ['groupe'],
    pb: ['problématique pré-échéance', 'problématique pré-échéance ( service recouvrement )'],
    detape: ['date maj qualif adv', 'date qualif recouvrement', 'date bascule en recouvrement', 'date basculement en recouvrement', 'date passage en recouvrement', 'date bascule - facture déposée non payée']
  };
  var ALL_TITLES = {};
  Object.keys(ALIAS).forEach(function (k) { ALIAS[k].forEach(function (t) { ALL_TITLES[t] = 1; }); });

  function prefix(title) {
    var m = /^\s*(\d+(?:\.\d+)+)/.exec(title || '');
    return m ? m[1] : '';
  }
  function technique(title) { return /technique|archive/i.test(title || ''); }
  function fileOf(groupTitle, overrides) {
    var p = prefix(groupTitle);
    if (overrides && overrides[p]) return overrides[p] === 'cpt' ? 'cor' : overrides[p];
    if (GROUP_FILE[p]) return GROUP_FILE[p];
    return technique(groupTitle) ? null : 'autre';
  }

  function num(v) {
    if (v == null) return null;
    var s = String(v).replace(/\s/g, '').replace(/€/g, '');
    if (!s) return null;
    if (/,\d{1,2}$/.test(s) && s.indexOf('.') < 0) s = s.replace(',', '.');
    s = s.replace(/,/g, '');
    var n = parseFloat(s);
    return isFinite(n) ? Math.round(n * 100) / 100 : null;
  }
  function date(v) {
    if (!v) return null;
    var s = String(v).trim();
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) return m[1] + '-' + m[2] + '-' + m[3];
    m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(s);
    if (m) return m[3] + '-' + m[2] + '-' + m[1];
    return null;
  }
  function pick(map, key) {
    var list = ALIAS[key];
    for (var i = 0; i < list.length; i++) {
      var v = map[list[i]];
      if (v != null && String(v).trim() !== '') return String(v).trim();
    }
    return '';
  }

  /* map : { titreNormalisé: valeur } d'une ligne. */
  function record(board, groupTitle, name, map, itemId, overrides) {
    var montantReste = num(pick(map, 'reste'));
    var total = num(pick(map, 'total'));
    if (board.paid) {
      var p = prefix(groupTitle);
      return {
        b: board.key, id: itemId || null, g: groupTitle,
        n: pick(map, 'num') || name,
        fin: PAID_FIN[p] || 'Entreprise',
        mt: num(map['montant']) != null ? num(map['montant']) : (montantReste != null ? montantReste : total),
        de: date(pick(map, 'echeance')), df: date(pick(map, 'facture')), dp: date(pick(map, 'paiement')),
        ow: pick(map, 'proprio'), cl: pick(map, 'client')
      };
    }
    var f = fileOf(groupTitle, overrides);
    if (!f) return null;
    return {
      b: board.key, id: itemId || null, g: groupTitle, f: f,
      n: pick(map, 'num') || name,
      fin: board.fin,
      mt: montantReste != null ? montantReste : total,
      tt: total,
      de: date(pick(map, 'echeance')), df: date(pick(map, 'facture')),
      dpr: date(pick(map, 'promesse')), drl: date(pick(map, 'relance')), dba: date(pick(map, 'bascule')),
      cl: pick(map, 'client'), ap: pick(map, 'apprenant'), ow: pick(map, 'proprio'), tc: pick(map, 'typeClient'),
      pb: pick(map, 'pb'), det: date(pick(map, 'detape')),
      st: pick(map, 'statut'), q: pick(map, 'qualif'), e: pick(map, 'etape'), c: pick(map, 'commentaire').slice(0, 240)
    };
  }

  /* Valeur affichée d'une colonne renvoyée par l'API Monday. */
  function cvText(cv) {
    if (!cv) return '';
    if (cv.display_value != null && String(cv.display_value).trim() !== '') return String(cv.display_value);
    if (cv.text != null) return String(cv.text);
    return '';
  }

  G.LioraNorm = {
    BOARDS: BOARDS, FINANCEURS: FINANCEURS, FILES: FILES, GROUP_FILE: GROUP_FILE,
    norm: norm, prefix: prefix, technique: technique, fileOf: fileOf, record: record, cvText: cvText,
    wanted: function (title) { return !!ALL_TITLES[norm(title)]; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
