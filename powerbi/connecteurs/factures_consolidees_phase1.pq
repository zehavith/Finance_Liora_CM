// =====================================================================
//  FACTURES — Table consolidée · VERSION PHASE 1 (démarrage rapide)
//  Requête Power Query (M)
//  Nom de requête conseillé :  Factures   (celle-ci, on la CHARGE)
// ---------------------------------------------------------------------
//  ⚡ VERSION SIMPLIFIÉE pour démarrer le suivi recouvrement SANS avoir
//  à préparer le référentiel (type de client / dates de formation) ni
//  les avoirs. Vous basculerez sur factures_consolidees.pq (version
//  complète) en phase 2, quand vous ferez la balance âgée détaillée.
//
//  Sources utilisées (3 seulement) :
//    • Sellsy_Factures     = colonne vertébrale (factures émises)
//    • Pennylane_Paiements = vérité paiement (reste dû, statut)
//    • Monday_Suivi        = suivi opérationnel (relances)
//
//  ✅ CE QUE VOUS AVEZ EN PHASE 1
//     - Encours, payé, taux de recouvrement, DSO
//     - Factures "à jour" vs "en recouvrement"
//     - Factures manquantes sur Monday
//     - Balance âgée SIMPLE (par tranche de mois, sans ventilation
//       par type de client / financeur)
//
//  ⚠️ LIMITE ASSUMÉE EN PHASE 1
//     L'échéance vient de Pennylane (sinon Sellsy), PAS de vos règles
//     métier (fin de formation +30/45/60 j). Les chiffres de RETARD
//     sont donc INDICATIFS. Ils deviendront exacts en phase 2, quand
//     le référentiel (type de client + dates de formation) sera branché.
//     👉 En attendant, ne déclenchez pas de relance juridique sur ces
//        seuls chiffres : vérifiez la facture dans Pennylane/Sellsy.
// =====================================================================
let
    // --- Tranches de la balance âgée (EN MOIS de retard) --------------
    //  {borne_min_incluse ; borne_max_exclue ; libellé}  — mêmes tranches
    //  que votre balance actuelle, pour ne rien changer en phase 2.
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

    // --- 1) Colonne vertébrale : factures émises (Sellsy) -------------
    Spine = Sellsy_Factures,

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
        {"item_id","statut_relance","date_derniere_relance","date_prochaine_relance","responsable_reco",
         "type_client_monday","sous_categorie_monday","perimetre_monday","regle_base","regle_jours",
         "date_echeance_monday","date_echeance_calc_monday",
         "date_facture_monday","date_debut_formation_monday","date_fin_formation_monday"},
        {"m_item_id","m_statut_relance","m_derniere_relance","m_prochaine_relance","m_responsable",
         "type_client","sous_categorie","perimetre_monday","m_regle_base","m_regle_jours",
         "m_date_echeance","m_date_echeance_calc",
         "m_date_facture","date_debut_formation","date_fin_formation"}
    ),

    // --- 4) Champs consolidés -----------------------------------------
    A0 = ExpMonday,

    // Reste dû : Pennylane fait foi ; sinon on suppose dû = montant émis
    A1 = Table.AddColumn(A0, "reste_du_net", each
            if [p_reste_du] <> null then [p_reste_du]
            else if [p_paye] = true then 0
            else [montant_ttc], type number),

    // --- Échéance : cascade de priorité -------------------------------
    //  1. « Date échéance calculée / négociée » de Monday (échéance
    //     renégociée : c'est elle qui fait foi en recouvrement)
    //  2. « Date d'échéance » saisie dans Monday
    //  3. RÈGLE MÉTIER du tableau Monday, appliquée à la bonne date de
    //     base : date de facture / début de service / fin de service
    //     (les 3 dates viennent de Monday → règles complètes dès la phase 1)
    //  4. Échéance Pennylane, sinon Sellsy
    A2 = Table.AddColumn(A1, "date_echeance", each
            let
                baseDate =
                    if [m_regle_base] = "facture"
                        then (if [m_date_facture] <> null then [m_date_facture] else [date_emission])
                    else if [m_regle_base] = "debut" then [date_debut_formation]
                    else if [m_regle_base] = "fin"   then [date_fin_formation]
                    else null,
                echeanceRegle =
                    if baseDate = null then null
                    else Date.AddDays(baseDate, if [m_regle_jours] = null then 0 else [m_regle_jours])
            in
                if [m_date_echeance_calc] <> null then [m_date_echeance_calc]
                else if [m_date_echeance] <> null then [m_date_echeance]
                else if echeanceRegle <> null then echeanceRegle
                else if [p_date_echeance] <> null then [p_date_echeance]
                else [date_echeance_sellsy], type date),

    // Présences (analyse des trous de suivi)
    A3 = Table.AddColumn(A2, "present_monday",    each [m_item_id] <> null, type logical),
    A4 = Table.AddColumn(A3, "present_pennylane", each [p_reste_du] <> null or [p_paye] <> null, type logical),

    // Soldée ? (un montant négatif = avoir, pas "payé")
    A5 = Table.AddColumn(A4, "est_payee", each [reste_du_net] = 0, type logical),

    // Retard (recalculé à chaque refresh quotidien)
    A6 = Table.AddColumn(A5, "jours_retard", each
            if [date_echeance] = null then null
            else Duration.Days(DateTime.Date(DateTime.LocalNow()) - [date_echeance]),
            Int64.Type),
    A6b = Table.AddColumn(A6, "mois_retard", each
            if [jours_retard] = null then null
            else Number.RoundDown([jours_retard] / 30.4375), Int64.Type),

    // Statut de recouvrement
    A7 = Table.AddColumn(A6b, "statut_recouvrement", each
            if [est_payee] then "Payée"
            else if [reste_du_net] < 0 then "Avoir / trop-perçu"
            else if [jours_retard] = null then "Sans échéance"
            else if [jours_retard] <= 0 then "À jour"
            else "En recouvrement", type text),

    // --- PÉRIMÈTRE : ADV vs RECOUVREMENT ------------------------------
    //  Définition retenue : ADV = facture PAS EN RETARD ·
    //  Recouvrement = facture EN RETARD. Calculé sur l'échéance métier,
    //  donc recalculé à chaque rafraîchissement quotidien.
    A7b = Table.AddColumn(A7, "perimetre", each
            if [est_payee] then "Payée"
            else if [jours_retard] = null then "Non qualifié"
            else if [jours_retard] <= 0 then "ADV"
            else "Recouvrement", type text),

    // Contrôle : la facture est-elle rangée dans le bon tableau Monday ?
    //  « À déplacer » = en retard (donc recouvrement) mais encore côté ADV.
    A7c = Table.AddColumn(A7b, "coherence_monday", each
            if [perimetre_monday] = null or [perimetre_monday] = "Non qualifié"
                or [perimetre] = "Payée" or [perimetre] = "Non qualifié"
            then "Non évaluable"
            else if [perimetre] = [perimetre_monday] then "OK"
            else "À déplacer", type text),

    // Tranche d'âge EN MOIS
    A8 = Table.AddColumn(A7c, "tranche_age", each
            let m = [mois_retard] in
            if [est_payee] then "Soldé"
            else if m = null then "Sans échéance"
            else if [jours_retard] <= 0 then "Non échu"
            else
                let hits = List.Select(TranchesMois, (t) => m >= t{0} and m < t{1})
                in  if List.Count(hits) > 0 then hits{0}{2} else "> 48 mois",
            type text),

    // Ordre de tri des tranches
    A9 = Table.AddColumn(A8, "tranche_ordre", each
            let t = [tranche_age] in
            if t = "Non échu" then 0
            else if t = "Soldé" then 100
            else if t = "Sans échéance" then 99
            else List.PositionOf(List.Transform(TranchesMois, (x) => x{2}), t) + 1,
            Int64.Type),

    // --- 5) Nettoyage final -------------------------------------------
    Final = Table.SelectColumns(A9, {
        "cle","numero","client_nom","montant_ttc","type_client","sous_categorie",
        "date_emission","date_debut_formation","date_fin_formation","date_echeance",
        "reste_du_net","est_payee","statut_recouvrement",
        "perimetre","perimetre_monday","coherence_monday",
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
