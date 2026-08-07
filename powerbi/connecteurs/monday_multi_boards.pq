// =====================================================================
//  MONDAY.COM — PLUSIEURS TABLEAUX + règle d'échéance PAR TABLEAU
//  Requête Power Query (M) — API GraphQL v2
//  Nom de requête conseillé :  Monday_Suivi   (remplace monday_relances.pq)
// ---------------------------------------------------------------------
//  ⭐ POURQUOI CETTE VERSION
//  Si vos tableaux Monday sont déjà séparés par type de client
//  (B2C, Corporate, Alternance…), alors LE TABLEAU DIT LE TYPE.
//  On en déduit automatiquement :
//     • le type_client        → plus de saisie manuelle
//     • la règle d'échéance   → date de facture / début / fin de formation + N j
//
//  Résultat : les chiffres de retard deviennent JUSTES sans avoir à
//  préparer le référentiel Google Sheets. 🎯
//
//  Prérequis : paramètre  pMondayToken  (le board id n'est plus utilisé,
//  les tableaux sont listés dans BoardsConfig ci-dessous).
//
//  ⚠️ Ne couvre que les factures PRÉSENTES dans Monday. Celles qui n'y
//     sont pas restent sans type (→ page « factures manquantes sur
//     Monday » : plus votre suivi est complet, meilleure est la donnée).
// =====================================================================
let
    Token = pMondayToken,

    // =================================================================
    //  ⚙️ 1) VOS TABLEAUX — à compléter (une ligne par tableau Monday)
    // =================================================================
    //  board_id    : le nombre dans l'URL  …/boards/1234567890
    //  type_client : le type porté par ce tableau (libre)
    //  base        : "facture" = date de facture | "debut" = début de
    //                formation | "fin" = fin de formation | "" = aucune règle
    //  jours       : délai ajouté à la date de base
    //
    //  💡 Si un tableau mélange plusieurs types, laissez type_client = ""
    //     et base = "" : la catégorisation retombera sur les autres
    //     sources (champ Sellsy / règles auto / référentiel).
    BoardsConfig = #table(
        {"board_id","type_client","base","jours"},
        {
            {"1111111111", "B2C - Entreprise",       "facture", 30},
            {"2222222222", "Corporate - Alternance", "facture", 30},
            {"3333333333", "B2C",                    "debut",    0}
            // {"4444444444", "CPF",  "fin", 45},
            // {"5555555555", "POEI", "fin", 60},
            // … ajoutez vos tableaux ici
        }
    ),

    // =================================================================
    //  ⚙️ 2) VOS COLONNES — titres EXACTS de vos tableaux Monday
    // =================================================================
    //  Les titres absents d'un tableau sont simplement ignorés.
    //  "Date d'échéance" est FACULTATIF : s'il existe, il est prioritaire
    //  sur la règle du tableau (option A : saisie explicite).
    ColonnesVoulues = {
        {"N° facture",        "numero"},
        {"Client",            "client_nom_monday"},
        {"Statut relance",    "statut_relance"},
        {"Dernière relance",  "date_derniere_relance"},
        {"Prochaine relance", "date_prochaine_relance"},
        {"Responsable",       "responsable_reco"},
        {"Commentaire",       "commentaire"},
        {"Date d'échéance",   "date_echeance_monday"}
    },

    // =================================================================
    //  3) Appel GraphQL
    // =================================================================
    AppelGraphQL = (requete as text) as record =>
        Json.Document(
            Web.Contents(
                "https://api.monday.com",
                [
                    RelativePath = "v2",
                    Headers      = [
                        #"Authorization" = Token,
                        #"Content-Type"  = "application/json",
                        #"API-Version"   = "2024-10"
                    ],
                    Content      = Json.FromValue([ query = requete ])
                ]
            )
        ),

    // --- Tous les items d'un tableau (pagination par curseur) ---------
    ItemsDuBoard = (boardId as text) as list =>
        let
            Req1  = "query { boards(ids: [" & boardId & "]) { items_page(limit: 100) "
                  & "{ cursor items { id name column_values { id text column { title } } } } } }",
            Rep1  = AppelGraphQL(Req1),
            Page1 = Rep1[data][boards]{0}[items_page],

            ReqSuite = (cursor as text) as text =>
                "query { next_items_page(limit: 100, cursor: """ & cursor & """) "
              & "{ cursor items { id name column_values { id text column { title } } } } }",

            Suite = List.Generate(
                () => [cur = Page1[cursor], items = Page1[items], stop = (Page1[cursor] = null)],
                each not [stop],
                each let
                        rep  = AppelGraphQL(ReqSuite([cur])),
                        page = rep[data][next_items_page]
                     in [ cur = page[cursor], items = page[items], stop = (page[cursor] = null) ],
                each [items]
            )
        in
            List.Combine({ Page1[items] } & Suite),

    // --- Un item → un enregistrement (colonnes = titres Monday) -------
    LigneDepuisItem = (item as record) as record =>
        let
            paires = List.Transform(item[column_values], each { _[column][title], _[text] })
        in
            Record.Combine({
                [ item_id = item[id], item_nom = item[name] ],
                Record.FromList(
                    List.Transform(paires, each _{1}),
                    List.Transform(paires, each _{0})
                )
            }),

    // =================================================================
    //  4) Un tableau Monday → une table typée
    // =================================================================
    TableDuBoard = (cfg as record) as table =>
        let
            Items  = ItemsDuBoard(cfg[board_id]),
            Enregs = List.Transform(Items, each LigneDepuisItem(_)),
            T0     = Table.FromRecords(Enregs, missingField.UseNull),

            // Sélection / renommage des colonnes présentes dans CE tableau
            Presentes = List.Select(ColonnesVoulues,
                            each List.Contains(Table.ColumnNames(T0), _{0})),
            T1 = Table.SelectColumns(
                    T0,
                    {"item_id","item_nom"} & List.Transform(Presentes, each _{0}),
                    MissingField.Ignore),
            T2 = Table.RenameColumns(T1, Presentes, MissingField.Ignore),

            // On garantit la présence des colonnes attendues en aval
            Attendues = List.Transform(ColonnesVoulues, each _{1}),
            Manquantes = List.Difference(Attendues, Table.ColumnNames(T2)),
            T3 = List.Accumulate(Manquantes, T2,
                    (etat, nom) => Table.AddColumn(etat, nom, each null)),

            // Métadonnées du tableau : type + règle d'échéance
            T4 = Table.AddColumn(T3, "board_id",         each cfg[board_id], type text),
            T5 = Table.AddColumn(T4, "type_client_monday", each
                    if cfg[type_client] = "" then null else cfg[type_client], type text),
            T6 = Table.AddColumn(T5, "regle_base",  each
                    if cfg[base] = "" then null else cfg[base], type text),
            T7 = Table.AddColumn(T6, "regle_jours", each cfg[jours], Int64.Type),

            // Clé de réconciliation (n° de facture normalisé)
            T8 = Table.AddColumn(T7, "cle", each
                    Text.Upper(Text.Trim(Text.From(
                        if [numero] <> null and [numero] <> "" then [numero] else [item_nom]
                    ))), type text)
        in
            T8,

    // =================================================================
    //  5) Tous les tableaux, empilés
    // =================================================================
    Configs = Table.ToRecords(BoardsConfig),
    Tables  = List.Transform(Configs, each try TableDuBoard(_) otherwise null),
    Valides = List.RemoveNulls(Tables),
    Empile  = Table.Combine(Valides),

    // Typage des dates éventuelles
    Resultat = Table.TransformColumnTypes(
        Empile,
        {
            {"date_echeance_monday", type date},
            {"date_derniere_relance", type date},
            {"date_prochaine_relance", type date}
        },
        "fr-FR"
    )
in
    Resultat
