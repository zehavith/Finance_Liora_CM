// =====================================================================
//  MONDAY.COM — TOUS VOS TABLEAUX + règle d'échéance PAR TABLEAU
//  Requête Power Query (M) — API GraphQL v2
//  Nom de requête conseillé :  Monday_Suivi   (remplace monday_relances.pq)
// ---------------------------------------------------------------------
//  ⭐ PRINCIPE
//  Vos tableaux Monday sont déjà organisés par type de financement
//  (1. Corporate / 2. B2C, puis CPF, AIF, Région, OPCO…). Le tableau
//  d'origine d'une facture suffit donc à déterminer :
//     • son type de client      → plus aucune saisie manuelle
//     • sa sous-catégorie       → ventilation de la balance âgée
//     • sa règle d'échéance     → date de facture / début / fin de
//                                 formation + N jours
//
//  Et comme TOUS vos tableaux portent les 3 dates (facture, début et fin
//  de formation), l'échéance métier est calculée intégralement ici :
//  aucun référentiel externe n'est nécessaire. 🎯
//
//  Les tableaux sont retrouvés PAR LEUR NOM (préfixe « 1.1. », « 2.2. »…),
//  donc vous n'avez AUCUN board id à aller chercher.
//
//  Prérequis : paramètre  pMondayToken  uniquement.
//
//  ⚠️ Ne couvre que les factures présentes dans Monday. Celles qui n'y
//     sont pas ressortent dans la page « factures manquantes sur Monday ».
// =====================================================================
let
    Token = pMondayToken,

    // =================================================================
    //  ⚙️ 1) VOS TABLEAUX — pré-rempli d'après votre arborescence
    // =================================================================
    //  prefixe        : début du nom du tableau dans Monday (unique)
    //  type_client    : type porté par ce tableau
    //  sous_categorie : financeur / détail (colonnes de votre balance)
    //  base           : "facture" | "debut" | "fin" | "" (aucune règle)
    //  jours          : délai ajouté à la date de base
    //
    //  ⚠️ À VALIDER : les règles ci-dessous sont déduites de votre table
    //     « Règle date d'échéance ». Vérifiez surtout les lignes 1.0 à 1.3.
    //  💡 Tableaux « Technique », « Zone Kairos », « RIB Reçus »,
    //     « Transactions » : volontairement ABSENTS (pas du suivi de
    //     facture). Ajoutez-les seulement s'ils contiennent des factures.
    BoardsConfig = #table(
        {"prefixe","type_client","sous_categorie","base","jours"},
        {
            // --- 1. Corporate ---------------------------------------
            {"1.0.", "B2C - Entreprise", "Entreprise - Tampon",       "facture", 30},
            {"1.1.", "B2C - Entreprise", "Entreprise - ADV",          "facture", 30},
            {"1.2.", "B2C - Entreprise", "Entreprise - Recouvrement", "facture", 30},
            {"1.3.", "OPCO",             "Entreprise - OPCO",         "fin",     60},

            // --- 2. B2C ---------------------------------------------
            {"2.1.", "BTC-Perso",        "Financement Personnel",     "debut",    0},
            {"2.2.", "CPF",              "Financement CPF",           "fin",     45},
            {"2.3.", "AIF",              "Financement pôle emploi",   "fin",     45},
            {"2.4.", "Region",           "Financement complexe",      "fin",     60}

            // --- Optionnel : factures déjà payées (contrôle) ---------
            // ,{"0.1.", "", "ALL - Factures payées", "", 0}
        }
    ),

    // =================================================================
    //  ⚙️ 2) VOS COLONNES — titres EXACTS dans Monday
    // =================================================================
    //  Les titres absents d'un tableau sont ignorés sans erreur.
    //  ⚠️ Adaptez ces libellés à ceux affichés dans vos tableaux.
    ColonnesVoulues = {
        {"N° facture",         "numero"},
        {"Client",             "client_nom_monday"},
        // ⭐ Les 3 dates présentes dans tous vos tableaux
        {"Date de facture",    "date_facture_monday"},
        {"Début de formation", "date_debut_formation_monday"},
        {"Fin de formation",   "date_fin_formation_monday"},
        {"Statut relance",     "statut_relance"},
        {"Dernière relance",   "date_derniere_relance"},
        {"Prochaine relance",  "date_prochaine_relance"},
        {"Responsable",        "responsable_reco"},
        {"Commentaire",        "commentaire"},
        // Facultatif : si rempli, prioritaire sur la règle du tableau
        {"Date d'échéance",    "date_echeance_monday"}
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

    // --- Liste de TOUS vos tableaux (id + nom) ------------------------
    GetBoardsPage = (page as number) as list =>
        let
            r = AppelGraphQL("query { boards(limit: 100, page: " & Text.From(page) & ") { id name } }")
        in
            try r[data][boards] otherwise {},

    ListeBoards = List.Combine(
        List.Generate(
            () => [p = 1, items = GetBoardsPage(1)],
            each List.Count([items]) > 0,
            each [p = [p] + 1, items = GetBoardsPage([p] + 1)],
            each [items]
        )
    ),

    // --- Résolution nom → board id ------------------------------------
    Configs = Table.ToRecords(BoardsConfig),
    Resolus = List.Transform(Configs, (cfg) =>
        let
            trouves = List.Select(ListeBoards,
                        (b) => Text.StartsWith(Text.Trim(Text.From(b[name])), cfg[prefixe]))
        in
            if List.Count(trouves) = 0 then null
            else cfg & [ board_id  = Text.From(trouves{0}[id]),
                         board_nom = Text.From(trouves{0}[name]) ]
    ),
    ConfigsOk = List.RemoveNulls(Resolus),

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

            Presentes = List.Select(ColonnesVoulues,
                            each List.Contains(Table.ColumnNames(T0), _{0})),
            T1 = Table.SelectColumns(
                    T0,
                    {"item_id","item_nom"} & List.Transform(Presentes, each _{0}),
                    MissingField.Ignore),
            T2 = Table.RenameColumns(T1, Presentes, MissingField.Ignore),

            // Garantir la présence des colonnes attendues en aval
            Attendues  = List.Transform(ColonnesVoulues, each _{1}),
            Manquantes = List.Difference(Attendues, Table.ColumnNames(T2)),
            T3 = List.Accumulate(Manquantes, T2,
                    (etat, nom) => Table.AddColumn(etat, nom, each null)),

            // Métadonnées du tableau : type, sous-catégorie, règle
            T4 = Table.AddColumn(T3, "board_id",  each cfg[board_id], type text),
            T5 = Table.AddColumn(T4, "board_nom", each cfg[board_nom], type text),
            T6 = Table.AddColumn(T5, "type_client_monday", each
                    if cfg[type_client] = "" then null else cfg[type_client], type text),
            T7 = Table.AddColumn(T6, "sous_categorie_monday", each
                    if cfg[sous_categorie] = "" then null else cfg[sous_categorie], type text),
            T8 = Table.AddColumn(T7, "regle_base", each
                    if cfg[base] = "" then null else cfg[base], type text),
            T9 = Table.AddColumn(T8, "regle_jours", each cfg[jours], Int64.Type),

            // Clé de réconciliation (n° de facture normalisé)
            T10 = Table.AddColumn(T9, "cle", each
                    Text.Upper(Text.Trim(Text.From(
                        if [numero] <> null and [numero] <> "" then [numero] else [item_nom]
                    ))), type text)
        in
            T10,

    // =================================================================
    //  5) Tous les tableaux, empilés
    // =================================================================
    Tables  = List.Transform(ConfigsOk, each try TableDuBoard(_) otherwise null),
    Valides = List.RemoveNulls(Tables),
    Empile  = Table.Combine(Valides),

    // Typage des dates (Monday renvoie du texte)
    // 💡 Si une date ne se convertit pas, adaptez la culture ("fr-FR" ↔ "en-US").
    Resultat = Table.TransformColumnTypes(
        Empile,
        {
            {"date_facture_monday", type date},
            {"date_debut_formation_monday", type date},
            {"date_fin_formation_monday", type date},
            {"date_echeance_monday", type date},
            {"date_derniere_relance", type date},
            {"date_prochaine_relance", type date}
        },
        "fr-FR"
    )
in
    Resultat
