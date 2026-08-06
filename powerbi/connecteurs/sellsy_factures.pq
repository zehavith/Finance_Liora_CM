// =====================================================================
//  SELLSY — Référentiel des factures ÉMISES
//  Requête Power Query (M) — API v2, OAuth2 client_credentials
//  Nom de requête conseillé :  Sellsy_Factures   (requête de staging)
// ---------------------------------------------------------------------
//  Rôle : liste COMPLÈTE des factures émises dans Sellsy. Elle sert de
//         "colonne vertébrale" : c'est en la comparant à Monday qu'on
//         détecte les FACTURES MANQUANTES sur le tableau de suivi.
//         (Le paiement, lui, viendra de Pennylane.)
//
//  Prérequis : 2 paramètres texte
//     pSellsyClientId       (client_id de l'app Sellsy)
//     pSellsyClientSecret   (client_secret)
//
//  ⚠️  Réglez cette source sur "Anonyme" dans le service (le secret
//      transite par le POST du token). Voir rafraichissement_service.md.
//  ⚠️  Vérifiez les noms de champs (bloc "Expand") selon votre compte.
//  Doc : https://api.sellsy.com/doc/v2/  (endpoint POST /invoices/search)
// =====================================================================
let
    ClientId     = pSellsyClientId,
    ClientSecret = pSellsyClientSecret,

    // --- 1) Jeton OAuth2 (client_credentials) -------------------------
    CorpsToken = "grant_type=client_credentials"
               & "&client_id="     & Uri.EscapeDataString(ClientId)
               & "&client_secret=" & Uri.EscapeDataString(ClientSecret),
    ReponseToken = Json.Document(
        Web.Contents(
            "https://login.sellsy.com",
            [
                RelativePath = "oauth2/access-tokens",
                Headers      = [ #"Content-Type" = "application/x-www-form-urlencoded" ],
                Content      = Text.ToBinary(CorpsToken)
            ]
        )
    ),
    Token = ReponseToken[access_token],

    // --- 2) Récupérer les factures, page par page ---------------------
    Limite = 100,
    GetPage = (offset as number) as record =>
        let
            R = Json.Document(
                Web.Contents(
                    "https://api.sellsy.com",
                    [
                        RelativePath = "v2/invoices",
                        Query        = [ limit = Text.From(Limite), offset = Text.From(offset) ],
                        Headers      = [
                            #"Authorization" = "Bearer " & Token,
                            #"Accept"        = "application/json"
                        ]
                    ]
                )
            )
        in R,

    Page1   = GetPage(0),
    Total   = try Number.From(Page1[pagination][total]) otherwise List.Count(Page1[data]),
    NbPages = Number.RoundUp(Total / Limite),
    Offsets = List.Transform({0 .. NbPages - 1}, each _ * Limite),
    Donnees = List.Combine(
        List.Transform(Offsets, each try GetPage(_)[data] otherwise {})
    ),

    // --- 3) Mise en table ---------------------------------------------
    T0 = Table.FromList(Donnees, Splitter.SplitByNothing(), {"Facture"}),
    T1 = Table.ExpandRecordColumn(
        T0, "Facture",
        {"id","number","date","due_date","status","amounts","related"},
        {"sellsy_id","numero","date_emission","date_echeance_sellsy","statut_sellsy","amounts_obj","related_obj"}
    ),
    // Montant TTC (structure amounts) + client (structure related)
    T2 = Table.AddColumn(T1, "montant_ttc", each
            try Number.From([amounts_obj][total_incl_tax]) otherwise null, type number),
    T3 = Table.AddColumn(T2, "client_nom", each
            try Text.From([related_obj]{0}[name]) otherwise
            try Text.From([related_obj][name]) otherwise null, type text),

    T4 = Table.RemoveColumns(T3, {"amounts_obj","related_obj"}),
    T5 = Table.TransformColumnTypes(
        T4,
        {
            {"sellsy_id", Int64.Type},
            {"numero", type text},
            {"date_emission", type date},
            {"date_echeance_sellsy", type date},
            {"statut_sellsy", type text}
        }
    ),

    // --- 4) Clé de réconciliation (n° normalisé) ----------------------
    Resultat = Table.AddColumn(T5, "cle", each
                    Text.Upper(Text.Trim(Text.From([numero]))), type text)

    // =================================================================
    //  §5 (OPTIONNEL) — TYPE DE CLIENT depuis un champ personnalisé Sellsy
    // =================================================================
    //  Si le "type de facture / type de client" existe dans Sellsy comme
    //  CHAMP PERSONNALISÉ (sur la facture ou le client), on peut le lire
    //  par l'API → plus AUCUNE saisie manuelle nulle part.
    //
    //  Étapes :
    //   1. Trouver l'id du champ : appel GET https://api.sellsy.com/v2/custom-fields
    //      (même en-tête Authorization) → notez l'id du champ voulu (ex. 12345).
    //   2. Dans GetPage ci-dessus, ajouter l'embed du champ à la Query :
    //        Query = [ limit = ..., offset = ..., #"embed[]" = "cf.12345" ]
    //   3. Les valeurs arrivent alors dans un objet "_embed" de chaque
    //      facture : ajouter après T5 une colonne
    //        type_client_sellsy = try [_embed][custom_fields]{0}[value] otherwise null
    //      (structure exacte à vérifier sur une réponse réelle de VOTRE compte).
    //   4. La table consolidée (factures_consolidees.pq §3ter) utilise
    //      automatiquement "type_client_sellsy" si la colonne existe.
    //
    //  ⚠️ La syntaxe d'embed des champs personnalisés varie selon les
    //     versions de l'API Sellsy — validez sur https://api.sellsy.com/doc/v2/
    //     ou testez l'appel dans leur console API avant de coder.
in
    Resultat
