// =====================================================================
//  FACTURES — Table consolidée (TABLE DE FAITS du modèle)
//  Requête Power Query (M)
//  Nom de requête conseillé :  Factures   (celle-ci, on la CHARGE)
// ---------------------------------------------------------------------
//  Fusionne les 3 sources par n° de facture (colonne "cle") :
//
//    • Sellsy_Factures     = colonne vertébrale (toutes les factures émises)
//    • Pennylane_Paiements = vérité paiement (reste dû, échéance, statut)
//    • Monday_Suivi        = suivi opérationnel (statut relance, responsable)
//
//  Produit, pour CHAQUE facture émise :
//    - son état de paiement (Pennylane)
//    - est-elle suivie sur Monday ? (sinon => "manquante sur Monday")
//    - sa tranche d'âge / son statut de recouvrement
//
//  Prérequis : les 3 requêtes de staging existent et renvoient une
//  colonne "cle" (n° de facture normalisé). Désactivez leur chargement
//  (clic droit > décocher "Activer le chargement").
// =====================================================================
let
    // --- 1) Colonne vertébrale : factures émises (Sellsy) -------------
    Spine = Sellsy_Factures,

    // --- 2) Fusion avec Pennylane (paiement) -------------------------
    JoinPenny = Table.NestedJoin(
        Spine, {"cle"},
        Pennylane_Paiements, {"cle"},
        "penny", JoinKind.LeftOuter
    ),
    ExpPenny = Table.ExpandTableColumn(
        JoinPenny, "penny",
        {"date_echeance","reste_du_net","montant_ttc","paye","statut","jours_retard"},
        {"p_date_echeance","p_reste_du","p_montant_penny","p_paye","p_statut","p_jours_retard"}
    ),

    // --- 3) Fusion avec Monday (suivi) -------------------------------
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

    // --- 4) Champs consolidés ----------------------------------------
    // Montant : on garde le TTC Sellsy (référentiel d'émission)
    A0 = ExpMonday,

    // Reste dû : Pennylane fait foi. Si absent de Pennylane, on suppose
    // dû = montant émis (facture non encore rapprochée en compta).
    A1 = Table.AddColumn(A0, "reste_du_net", each
            if [p_reste_du] <> null then [p_reste_du]
            else if [p_paye] = true then 0
            else [montant_ttc], type number),

    // Échéance : Pennylane prioritaire, sinon échéance Sellsy
    A2 = Table.AddColumn(A1, "date_echeance", each
            if [p_date_echeance] <> null then [p_date_echeance]
            else [date_echeance_sellsy], type date),

    // Présences (pour l'analyse des trous)
    A3 = Table.AddColumn(A2, "present_monday",    each [m_item_id] <> null, type logical),
    A4 = Table.AddColumn(A3, "present_pennylane", each [p_reste_du] <> null or [p_paye] <> null, type logical),

    // Payée ?
    A5 = Table.AddColumn(A4, "est_payee", each
            [reste_du_net] <= 0, type logical),

    // Jours de retard (positif = en retard), recalculé à chaque refresh
    A6 = Table.AddColumn(A5, "jours_retard", each
            if [date_echeance] = null then null
            else Duration.Days(DateTime.Date(DateTime.LocalNow()) - [date_echeance]),
            Int64.Type),

    // Statut de recouvrement lisible
    A7 = Table.AddColumn(A6, "statut_recouvrement", each
            if [est_payee] then "Payée"
            else if [jours_retard] = null then "Sans échéance"
            else if [jours_retard] <= 0 then "À jour"
            else "En recouvrement", type text),

    // Tranche d'âge (balance âgée)
    A8 = Table.AddColumn(A7, "tranche_age", each
            let r = [jours_retard] in
            if [est_payee] then "Soldé"
            else if r = null then "Sans échéance"
            else if r <= 0  then "Non échu"
            else if r <= 30 then "0-30 j"
            else if r <= 60 then "31-60 j"
            else if r <= 90 then "61-90 j"
            else "90 j +", type text),

    // Ordre de tri de la tranche (pour trier "tranche_age" par ce champ)
    A9 = Table.AddColumn(A8, "tranche_ordre", each
            let t = [tranche_age] in
            if t = "Non échu"      then 0
            else if t = "0-30 j"   then 1
            else if t = "31-60 j"  then 2
            else if t = "61-90 j"  then 3
            else if t = "90 j +"   then 4
            else if t = "Soldé"    then 5
            else 6, Int64.Type),

    // --- 5) Nettoyage final ------------------------------------------
    Final = Table.SelectColumns(A9, {
        "cle","numero","client_nom","montant_ttc",
        "date_emission","date_echeance",
        "reste_du_net","est_payee","statut_recouvrement","tranche_age","tranche_ordre","jours_retard",
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
