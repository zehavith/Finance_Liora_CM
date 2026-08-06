// =====================================================================
//  PENNYLANE — Factures clients (SOURCE DE VÉRITÉ du recouvrement)
//  Requête Power Query (langage M)
// ---------------------------------------------------------------------
//  Rôle : ramène toutes les factures clients avec leur état financier
//         réel (montant, reste dû, statut de paiement, échéance).
//         C'est la table de faits centrale du modèle.
//
//  Nom de requête conseillé :  Pennylane_Paiements  (requête de staging)
//
//  Comment l'utiliser :
//    Power BI Desktop > Accueil > Transformer les données
//    > Nouvelle source > Requête vide > Éditeur avancé
//    > coller ce code > renommer la requête "Pennylane_Paiements".
//
//  Prérequis : créer le paramètre texte  pPennylaneApiKey
//    (Accueil > Gérer les paramètres > Nouveau paramètre, type Texte).
//
//  ⚠️  Vérifiez les NOMS DE CHAMPS renvoyés par VOTRE version de l'API
//      (bloc "Expand" ci-dessous) : ouvrez une première fois
//      /api/external/v1/customer_invoices et ajustez si besoin.
//      Doc : https://pennylane.readme.io/
// =====================================================================
let
    // --- Paramètres ---------------------------------------------------
    BaseUrl  = "https://app.pennylane.com",
    ApiKey   = pPennylaneApiKey,
    PageSize = 100,

    // --- Récupère UNE page de factures --------------------------------
    // On passe par RelativePath/Query : indispensable pour que le
    // service Power BI reconnaisse la source et autorise le refresh auto.
    GetPage = (page as number) as record =>
        let
            Reponse = Json.Document(
                Web.Contents(
                    BaseUrl,
                    [
                        RelativePath = "api/external/v1/customer_invoices",
                        Query        = [ page = Text.From(page), per_page = Text.From(PageSize) ],
                        Headers      = [
                            #"Authorization" = "Bearer " & ApiKey,
                            #"Accept"        = "application/json"
                        ]
                    ]
                )
            )
        in
            Reponse,

    // --- Pagination : on lit la 1re page pour connaître le total ------
    Page1      = GetPage(1),
    TotalPages = try Number.From(Page1[total_pages]) otherwise 1,

    ToutesPages   = List.Transform({1 .. TotalPages}, each GetPage(_)),
    // La liste des factures est sous la clé "customer_invoices"
    ListeFactures = List.Combine(
        List.Transform(ToutesPages, each try _[customer_invoices] otherwise {})
    ),

    // --- Mise en table ------------------------------------------------
    T0 = Table.FromList(ListeFactures, Splitter.SplitByNothing(), {"Facture"}),
    T1 = Table.ExpandRecordColumn(
        T0, "Facture",
        // clés API                                         -> noms lisibles
        {"id","invoice_number","label","date","deadline","currency","amount","remaining_amount","paid","status","customer"},
        {"id","numero","libelle","date_emission","date_echeance","devise","montant_ttc","reste_du","paye","statut","client_obj"}
    ),

    // Le client est un objet imbriqué : on extrait id + nom
    T2 = Table.ExpandRecordColumn(
        T1, "client_obj",
        {"id","name"},
        {"client_id","client_nom"}
    ),

    // --- Typage -------------------------------------------------------
    T3 = Table.TransformColumnTypes(
        T2,
        {
            {"id", Int64.Type},
            {"numero", type text},
            {"libelle", type text},
            {"date_emission", type date},
            {"date_echeance", type date},
            {"devise", type text},
            {"montant_ttc", type number},
            {"reste_du", type number},
            {"paye", type logical},
            {"statut", type text},
            {"client_id", Int64.Type},
            {"client_nom", type text}
        }
    ),

    // --- Colonnes calculées utiles au recouvrement --------------------
    // Reste dû fiable (si l'API ne renvoie pas remaining_amount, on le déduit)
    T4 = Table.AddColumn(T3, "reste_du_net", each
            if [reste_du] <> null then [reste_du]
            else if [paye] = true then 0
            else [montant_ttc], type number),

    // Jours de retard (positif = en retard) — recalculé à chaque refresh
    T5 = Table.AddColumn(T4, "jours_retard", each
            if [date_echeance] = null then null
            else Duration.Days(DateTime.Date(DateTime.LocalNow()) - [date_echeance]),
            Int64.Type),

    // Facture encore due ?
    T6 = Table.AddColumn(T5, "est_en_cours", each [reste_du_net] > 0, type logical),

    // Clé de réconciliation (n° de facture normalisé) — pour les fusions
    T7 = Table.AddColumn(T6, "cle", each
             Text.Upper(Text.Trim(Text.From([numero]))), type text),

    Resultat = T7
in
    Resultat
