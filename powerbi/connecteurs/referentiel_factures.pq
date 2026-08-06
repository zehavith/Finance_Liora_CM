// =====================================================================
//  RÉFÉRENTIEL FACTURES — Type de client, financeur, dates de formation
//  Requête Power Query (M)
//  Nom de requête conseillé :  Referentiel_Factures   (staging)
// ---------------------------------------------------------------------
//  Rôle : apporte, PAR FACTURE, les informations métier que vous
//  calculez déjà dans vos Google Sheets (grand livre enrichi) :
//    - type_client       : B2C, B2C-Entreprise, B2B, Alternance, POEI, Interco…
//    - sous_categorie    : CPF, Transition Pro, OPCO, Région, Agefiph, AIF…
//    - date_debut_formation / date_fin_formation
//
//  Ces champs permettent :
//    1. la balance âgée par Type → Sous-catégorie (vos onglets actuels)
//    2. le calcul de l'ÉCHÉANCE par règle métier (fin de formation +30/45/60 j)
//
//  SOURCE DES DONNÉES (validé) : l'ANCIEN GRAND LIVRE CLASSÉ fournit le
//  mapping historique client → type / sous-catégorie (chargement UNIQUE,
//  pas d'entretien manuel) ; les nouvelles factures sont classées par la
//  cascade automatique (champ Sellsy / règles) de factures_consolidees.pq.
//
//  PRÉREQUIS côté Google Sheets :
//    Créez un onglet propre (ex. "PowerBI_Referentiel") — alimenté par vos
//    formules existantes — avec ces 5 colonnes, en-têtes en ligne 1 :
//        numero_facture | type_client | sous_categorie | date_debut_formation | date_fin_formation
//
//  PRÉREQUIS côté Power BI :
//    Obtenir les données > Google Sheets (URL du classeur) > onglet
//    "PowerBI_Referentiel" > nommer la requête source "Referentiel_Source".
//    La requête ci-dessous la nettoie. Désactivez le chargement des deux.
//
//  💡 Alternative sans Google : un fichier Excel sur OneDrive/SharePoint
//     avec les mêmes colonnes (refresh natif dans le service Power BI).
// =====================================================================
let
    Source = Referentiel_Source,

    T1 = Table.SelectColumns(
            Source,
            {"numero_facture","type_client","sous_categorie",
             "date_debut_formation","date_fin_formation"},
            MissingField.UseNull
         ),

    // Clé de réconciliation normalisée (même logique que les autres sources)
    T2 = Table.AddColumn(T1, "cle", each
            Text.Upper(Text.Trim(Text.From([numero_facture]))), type text),
    T3 = Table.SelectRows(T2, each [cle] <> null and [cle] <> ""),

    // Typage
    T4 = Table.TransformColumnTypes(T3, {
            {"type_client", type text},
            {"sous_categorie", type text},
            {"date_debut_formation", type date},
            {"date_fin_formation", type date}
         }),

    // Une seule ligne par facture
    Resultat = Table.Distinct(T4, {"cle"})
in
    Resultat
