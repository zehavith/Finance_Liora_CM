// =====================================================================
//  SELLSY — AVOIRS (credit notes)
//  Requête Power Query (M) — API v2, OAuth2 client_credentials
//  Nom de requête conseillé :  Sellsy_Avoirs   (staging)
// ---------------------------------------------------------------------
//  Rôle : les avoirs sont des objets SÉPARÉS des factures dans Sellsy
//  (endpoint /v2/credit-notes). Pour que la balance âgée reflète vos
//  lignes négatives (avoirs / trop-perçus, ex. "Clients - Alma"), on
//  les ramène avec un MONTANT NÉGATIF puis on les combine à la colonne
//  vertébrale dans factures_consolidees.pq :
//      Spine = Table.Combine({Sellsy_Factures, Sellsy_Avoirs})
//
//  Mêmes prérequis que sellsy_factures.pq (pSellsyClientId / Secret).
//  ⚠️ Vérifiez les noms de champs sur votre compte (bloc Expand).
// =====================================================================
let
    ClientId     = pSellsyClientId,
    ClientSecret = pSellsyClientSecret,

    // --- 1) Jeton OAuth2 ----------------------------------------------
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

    // --- 2) Récupérer les avoirs, page par page -----------------------
    Limite = 100,
    GetPage = (offset as number) as record =>
        let
            R = Json.Document(
                Web.Contents(
                    "https://api.sellsy.com",
                    [
                        RelativePath = "v2/credit-notes",
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

    // --- 3) Mise en table (même schéma que Sellsy_Factures) -----------
    T0 = Table.FromList(Donnees, Splitter.SplitByNothing(), {"Avoir"}),
    T1 = Table.ExpandRecordColumn(
        T0, "Avoir",
        {"id","number","date","status","amounts","related"},
        {"sellsy_id","numero","date_emission","statut_sellsy","amounts_obj","related_obj"}
    ),
    // Montant TTC en NÉGATIF (c'est un avoir)
    T2 = Table.AddColumn(T1, "montant_ttc", each
            try - Number.Abs(Number.From([amounts_obj][total_incl_tax])) otherwise null,
            type number),
    T3 = Table.AddColumn(T2, "client_nom", each
            try Text.From([related_obj]{0}[name]) otherwise
            try Text.From([related_obj][name]) otherwise null, type text),

    // Pas d'échéance propre : la date d'avoir sert d'échéance Sellsy
    T4 = Table.AddColumn(T3, "date_echeance_sellsy", each [date_emission], type date),

    T5 = Table.RemoveColumns(T4, {"amounts_obj","related_obj"}),
    T6 = Table.TransformColumnTypes(
        T5,
        {
            {"sellsy_id", Int64.Type},
            {"numero", type text},
            {"date_emission", type date},
            {"statut_sellsy", type text}
        }
    ),

    // --- 4) Clé de réconciliation -------------------------------------
    Resultat = Table.AddColumn(T6, "cle", each
                    Text.Upper(Text.Trim(Text.From([numero]))), type text)
in
    Resultat
