// =====================================================================
//  BANQUE — Rapprochement paiements ↔ factures (MODULE OPTIONNEL, phase 2)
//  Requête Power Query (M)
//  Nom de requête conseillé :  Banque_Rapprochement   (staging)
// ---------------------------------------------------------------------
//  BUT : "filet de sécurité" au lettrage Pennylane. On réutilise VOTRE
//  extraction des n° de facture depuis les libellés bancaires (déjà
//  faite dans Google Sheets) pour détecter les encaissements reçus mais
//  pas encore lettrés dans Pennylane → statut "Payée (à lettrer)".
//
//  ⚠️  On NE recode PAS vos REGEX ici (Power Query n'a pas de regex
//      natif). L'extraction reste dans Google Sheets. Cette requête ne
//      fait que : lire le résultat, éclater les multi-factures, normaliser.
//
//  PRÉREQUIS côté Google Sheets :
//    Créez un onglet propre (ex. "PowerBI_Rapprochement") avec 3 colonnes
//    alimentées par vos formules :
//        date_paiement     | montant_recu | numeros_factures
//        2025-07-14        | 8900         | FACT-2024-00123, FACT-2024-00124
//        2025-07-15        | 3120,75      | FCT-FILIZ-DST-2025-7
//    (numeros_factures = sortie de votre TEXTJOIN, séparée par ", ")
//
//  PRÉREQUIS côté Power BI :
//    Connectez d'abord la feuille via  Obtenir les données > Google Sheets
//    (collez l'URL de partage), sélectionnez l'onglet, et nommez cette
//    requête source  "Banque_Source".  La requête ci-dessous la transforme.
//    (Auth Google requise ; voir option_rapprochement_bancaire.md.)
// =====================================================================
let
    Source = Banque_Source,

    // On ne garde que les 3 colonnes utiles
    T1 = Table.SelectColumns(
            Source,
            {"date_paiement","montant_recu","numeros_factures"},
            MissingField.UseNull
         ),

    // Une transaction peut couvrir PLUSIEURS factures ("A, B") :
    // on éclate en une ligne par facture.
    T2 = Table.AddColumn(T1, "liste", each
            if [numeros_factures] = null then {}
            else Text.Split(Text.From([numeros_factures]), ", "), type list),
    T3 = Table.ExpandListColumn(T2, "liste"),

    // Clé de réconciliation normalisée (même logique que les autres sources)
    T4 = Table.AddColumn(T3, "cle", each
            Text.Upper(Text.Trim(Text.From([liste]))), type text),

    // On retire les lignes sans n° exploitable
    T5 = Table.SelectRows(T4, each [cle] <> null and [cle] <> ""),

    // Typage
    T6 = Table.TransformColumnTypes(T5, {
            {"date_paiement", type date},
            {"montant_recu", type number}
         }),

    // Un flag simple + on dédoublonne par clé (on garde le paiement le + récent)
    T7 = Table.Buffer(Table.Sort(T6, {{"date_paiement", Order.Descending}})),
    T8 = Table.Distinct(T7, {"cle"}),
    Resultat = Table.AddColumn(T8, "encaisse_banque", each true, type logical)

    // NB : ne SOMMEZ pas [montant_recu] par facture si un même virement
    //      couvre plusieurs factures (le montant serait dupliqué). Ce module
    //      sert surtout de FLAG "encaissé en banque" + date, pas de montant.
in
    Resultat
