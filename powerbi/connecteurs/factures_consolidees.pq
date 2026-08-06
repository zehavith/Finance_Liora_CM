// =====================================================================
//  FACTURES — Table consolidée (TABLE DE FAITS du modèle)
//  Requête Power Query (M)
//  Nom de requête conseillé :  Factures   (celle-ci, on la CHARGE)
// ---------------------------------------------------------------------
//  Fusionne les sources par n° de facture (colonne "cle") :
//
//    • Sellsy_Factures      = colonne vertébrale (toutes les factures émises)
//    • Pennylane_Paiements  = vérité paiement (reste dû, statut)
//    • Monday_Suivi         = suivi opérationnel (statut relance, responsable)
//    • Referentiel_Factures = type de client, sous-catégorie (financeur),
//                             dates de formation  → règles d'échéance métier
//
//  Produit, pour CHAQUE facture émise :
//    - son état de paiement (Pennylane fait foi)
//    - son ÉCHÉANCE calculée par RÈGLE MÉTIER (fin de formation +30/45/60 j
//      selon le type de client), sinon échéance Pennylane/Sellsy
//    - sa tranche d'âge EN MOIS (balance âgée) + type / sous-catégorie
//    - est-elle suivie sur Monday ? (sinon => "manquante sur Monday")
//
//  Prérequis : les requêtes de staging existent et renvoient une colonne
//  "cle" (n° de facture normalisé). Désactivez leur chargement.
//  Si le Referentiel n'est pas encore branché : voir bloc 3bis (fallback).
// =====================================================================
let
    // =================================================================
    //  ⚙️ PARAMÉTRAGE MÉTIER — les 2 tables à ajuster librement
    // =================================================================

    // --- Règles d'échéance par type de client -------------------------
    //  base : "facture" = date de facture | "debut" = début de formation
    //         | "fin" = fin de formation
    //  jours : délai ajouté à la date de base
    //  ✅ Règles validées (Région = +60 j ; B2C-Perso = début de formation)
    ReglesEcheance = #table(
        {"type_client","base","jours"},
        {
            {"B2C - Entreprise",        "facture", 30},
            {"B2C-Entreprise",          "facture", 30},
            {"Corporate - Alternance",  "facture", 30},
            {"B2B",                     "fin",     30},
            {"Alternance",              "fin",     30},
            {"Transition Pro",          "fin",     30},
            {"Region",                  "fin",     60},
            {"Interco",                 "fin",     30},
            {"Interne - DST Allemagne", "fin",     30},
            {"AIF",                     "fin",     45},
            {"CPF",                     "fin",     45},
            {"POEI",                    "fin",     60},
            {"Agefiph",                 "fin",     60},
            {"ETAT",                    "fin",     60},
            {"OPCO",                    "fin",     60},
            {"OPCO - Alternance",       "fin",     60},
            {"BTC-Perso",               "debut",   0},
            {"Perso-Alternance",        "debut",   0}
        }
    ),

    // --- Tranches de la balance âgée (EN MOIS de retard) --------------
    //  {borne_min_incluse ; borne_max_exclue ; libellé}
    //  ✅ Tranches validées (dont la tranche 3-4 mois)
    TranchesMois = {
        { 0,    3,    "0-3 mois"   },
        { 3,    4,    "3-4 mois"   },
        { 4,    8,    "4-8 mois"   },
        { 8,    12,   "8-12 mois"  },
        { 12,   18,   "12-18 mois" },
        { 18,   24,   "18-24 mois" },
        { 24,   36,   "24-36 mois" },
        { 36,   48,   "36-48 mois" },
        { 48,   9999, "> 48 mois"  }
    },

    // =================================================================
    //  1) Colonne vertébrale : factures émises + AVOIRS (Sellsy)
    // =================================================================
    //  Les avoirs (montants négatifs) viennent de sellsy_avoirs.pq.
    //  Si vous n'avez pas encore créé Sellsy_Avoirs, remplacez par :
    //     Spine = Sellsy_Factures,
    Spine = Table.Combine({Sellsy_Factures, Sellsy_Avoirs}),

    // --- 2) Fusion avec Pennylane (paiement) --------------------------
    JoinPenny = Table.NestedJoin(
        Spine, {"cle"},
        Pennylane_Paiements, {"cle"},
        "penny", JoinKind.LeftOuter
    ),
    ExpPenny = Table.ExpandTableColumn(
        JoinPenny, "penny",
        {"date_echeance","reste_du_net","paye","statut"},
        {"p_date_echeance","p_reste_du","p_paye","p_statut"}
    ),

    // --- 3) Fusion avec Monday (suivi) --------------------------------
    JoinMonday = Table.NestedJoin(
        ExpPenny, {"cle"},
        Monday_Suivi, {"cle"},
        "monday", JoinKind.LeftOuter
    ),
    ExpMonday = Table.ExpandTableColumn(
        JoinMonday, "monday",
        {"item_id","statut_relance","date_derniere_relance","date_prochaine_relance","responsable_reco"},
        {"m_item_id","m_statut_relance","m_derniere_relance","m_prochaine_relance","m_responsable"}
    ),

    // --- 3bis) Fusion avec le Référentiel (fallback + dates formation)
    //  💡 Pas encore branché ? Remplacez les 2 étapes ci-dessous par :
    //     ExpRef = Table.AddColumn(Table.AddColumn(Table.AddColumn(Table.AddColumn(
    //         ExpMonday, "ref_type_client", each null), "ref_sous_categorie", each null),
    //         "date_debut_formation", each null), "date_fin_formation", each null),
    JoinRef = Table.NestedJoin(
        ExpMonday, {"cle"},
        Referentiel_Factures, {"cle"},
        "ref", JoinKind.LeftOuter
    ),
    ExpRef = Table.ExpandTableColumn(
        JoinRef, "ref",
        {"type_client","sous_categorie","date_debut_formation","date_fin_formation"},
        {"ref_type_client","ref_sous_categorie","date_debut_formation","date_fin_formation"}
    ),

    // =================================================================
    //  3ter) TYPE DE CLIENT — cascade AUTOMATIQUE (zéro saisie manuelle)
    // =================================================================
    //  Priorité :
    //   1. Champ Sellsy (si le connecteur Sellsy expose "type_client_sellsy"
    //      — champ personnalisé lu par l'API, voir sellsy_factures.pq §5)
    //   2. Règles automatiques ci-dessous (déduction depuis le n° de
    //      facture ou le nom du client — reproduisez ici la logique de
    //      vos formules Drive, une bonne fois pour toutes)
    //   3. Référentiel Sheets (fallback temporaire, à terme inutile)
    //
    //  ⚙️ RÈGLES AUTO — {champ à tester ; texte contenu ; type ; sous-catégorie}
    //     champ : "numero" ou "client". Complétez avec VOS règles !
    ReglesTypeClient = {
        { "numero", "FILIZ-DST", "Interco",     "Interne - DST Allemagne" },
        { "client", "AKTO",      "Alternance",  "OPCO - Alternance" },
        { "client", "OPCO",      "Alternance",  "OPCO - Alternance" }
        // { "client", "REGION", "B2C", "Region" },   ← exemples à compléter
    },

    DeduireType = (ligne as record) as record =>
        let
            hits = List.Select(ReglesTypeClient, (r) =>
                let valeur = if r{0} = "numero"
                             then Text.From(ligne[numero] ?? "")
                             else Text.From(ligne[client_nom] ?? "")
                in Text.Contains(Text.Upper(valeur), Text.Upper(r{1}))),
            regle = if List.Count(hits) > 0 then hits{0} else null
        in
            [ type = if regle <> null then regle{2} else null,
              sc   = if regle <> null then regle{3} else null ],

    TC1 = Table.AddColumn(ExpRef, "auto", each DeduireType(_)),
    TC2 = Table.AddColumn(TC1, "type_client", each
            let sellsyType = Record.FieldOrDefault(_, "type_client_sellsy", null)
            in  if sellsyType <> null and sellsyType <> "" then sellsyType
                else if [auto][type] <> null then [auto][type]
                else [ref_type_client], type text),
    TC3 = Table.AddColumn(TC2, "sous_categorie", each
            let sellsySC = Record.FieldOrDefault(_, "sous_categorie_sellsy", null)
            in  if sellsySC <> null and sellsySC <> "" then sellsySC
                else if [auto][sc] <> null then [auto][sc]
                else [ref_sous_categorie], type text),
    TC4 = Table.RemoveColumns(TC3, {"auto"}),

    // =================================================================
    //  4) Champs consolidés
    // =================================================================
    A0 = TC4,

    // Reste dû : Pennylane fait foi. Si absent de Pennylane, on suppose
    // dû = montant émis (facture non encore rapprochée en compta).
    A1 = Table.AddColumn(A0, "reste_du_net", each
            if [p_reste_du] <> null then [p_reste_du]
            else if [p_paye] = true then 0
            else [montant_ttc], type number),

    // --- Échéance par RÈGLE MÉTIER ------------------------------------
    // 1. règle du type de client (fin/début de formation, date de facture)
    // 2. sinon échéance Pennylane, sinon échéance Sellsy
    A2 = Table.AddColumn(A1, "date_echeance", each
            let
                regle = try Table.SelectRows(ReglesEcheance,
                            (r) => Comparer.Equals(Comparer.OrdinalIgnoreCase,
                                                   r[type_client], [type_client])){0}
                        otherwise null,
                baseDate =
                    if regle = null then null
                    else if regle[base] = "facture" then [date_emission]
                    else if regle[base] = "debut"   then [date_debut_formation]
                    else [date_fin_formation],
                echeanceRegle =
                    if baseDate = null then null
                    else Date.AddDays(baseDate, regle[jours])
            in
                if echeanceRegle <> null then echeanceRegle
                else if [p_date_echeance] <> null then [p_date_echeance]
                else [date_echeance_sellsy], type date),

    // Présences (pour l'analyse des trous)
    A3 = Table.AddColumn(A2, "present_monday",    each [m_item_id] <> null, type logical),
    A4 = Table.AddColumn(A3, "present_pennylane", each [p_reste_du] <> null or [p_paye] <> null, type logical),

    // Payée / soldée ? (un avoir négatif n'est pas "payé" : il reste à
    // apurer → on ne solde que ce qui est exactement à 0)
    A5 = Table.AddColumn(A4, "est_payee", each
            [reste_du_net] = 0, type logical),

    // Retard (recalculé à chaque refresh quotidien)
    A6 = Table.AddColumn(A5, "jours_retard", each
            if [date_echeance] = null then null
            else Duration.Days(DateTime.Date(DateTime.LocalNow()) - [date_echeance]),
            Int64.Type),
    A6b = Table.AddColumn(A6, "mois_retard", each
            if [jours_retard] = null then null
            else Number.RoundDown([jours_retard] / 30.4375), Int64.Type),

    // Statut de recouvrement lisible
    A7 = Table.AddColumn(A6b, "statut_recouvrement", each
            if [est_payee] then "Payée"
            else if [reste_du_net] < 0 then "Avoir / trop-perçu"
            else if [jours_retard] = null then "Sans échéance"
            else if [jours_retard] <= 0 then "À jour"
            else "En recouvrement", type text),

    // --- Tranche d'âge EN MOIS (balance âgée) -------------------------
    A8 = Table.AddColumn(A7, "tranche_age", each
            let m = [mois_retard] in
            if [est_payee] then "Soldé"
            else if m = null then "Sans échéance"
            else if [jours_retard] <= 0 then "Non échu"
            else
                let hits = List.Select(TranchesMois, (t) => m >= t{0} and m < t{1})
                in  if List.Count(hits) > 0 then hits{0}{2} else "> 48 mois",
            type text),

    // Ordre de tri (Non échu → tranches croissantes → Soldé)
    A9 = Table.AddColumn(A8, "tranche_ordre", each
            let t = [tranche_age] in
            if t = "Non échu" then 0
            else if t = "Soldé" then 100
            else if t = "Sans échéance" then 99
            else List.PositionOf(List.Transform(TranchesMois, (x) => x{2}), t) + 1,
            Int64.Type),

    // =================================================================
    //  5) Nettoyage final
    // =================================================================
    Final = Table.SelectColumns(A9, {
        "cle","numero","client_nom","montant_ttc",
        "type_client","sous_categorie",
        "date_emission","date_debut_formation","date_fin_formation","date_echeance",
        "reste_du_net","est_payee","statut_recouvrement",
        "tranche_age","tranche_ordre","jours_retard","mois_retard",
        "present_monday","present_pennylane",
        "m_statut_relance","m_derniere_relance","m_prochaine_relance","m_responsable",
        "p_statut"
    }, MissingField.Ignore),

    Resultat = Table.RenameColumns(Final, {
        {"m_statut_relance","statut_relance"},
        {"m_derniere_relance","derniere_relance"},
        {"m_prochaine_relance","prochaine_relance"},
        {"m_responsable","responsable_reco"},
        {"p_statut","statut_pennylane"}
    }, MissingField.Ignore)
in
    Resultat
