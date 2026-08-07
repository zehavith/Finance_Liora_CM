// =====================================================================
//  MONDAY.COM — Suivi des factures / relances (COUCHE OPÉRATIONNELLE)
//  Requête Power Query (langage M) — API GraphQL v2
//  Nom de requête conseillé :  Monday_Suivi   (requête de staging)
// ---------------------------------------------------------------------
//  Rôle : ramène votre tableau de suivi des factures / relances
//         (statut de relance, dernière relance, responsable
//         recouvrement, commentaires…). Se relie aux factures
//         Pennylane par le N° de facture.
//
//  Prérequis : 2 paramètres dans Power BI
//     pMondayToken     (texte)  — jeton API personnel Monday
//     pMondayBoardId   (texte)  — ID du tableau de suivi des factures
//
//  ⚠️  Adaptez la liste des colonnes attendues (bloc "ColonnesVoulues")
//      aux titres EXACTS de votre tableau Monday.
//  Doc : https://developer.monday.com/api-reference/
// =====================================================================
let
    Token   = pMondayToken,
    BoardId = pMondayBoardId,

    // --- Requête GraphQL : items paginés par curseur -----------------
    // {cursor} est remplacé à chaque appel. On demande le titre de
    // chaque colonne pour pouvoir dépivoter proprement ensuite.
    RequetePremiere =
        "query { boards(ids: [" & BoardId & "]) { items_page(limit: 100) { cursor items { id name column_values { id text column { title } } } } } }",

    RequeteSuivante = (cursor as text) as text =>
        "query { next_items_page(limit: 100, cursor: """ & cursor & """) { cursor items { id name column_values { id text column { title } } } } }",

    // --- Appel HTTP GraphQL ------------------------------------------
    AppelGraphQL = (requete as text) as record =>
        let
            Corps = Json.FromValue([ query = requete ]),
            R = Json.Document(
                Web.Contents(
                    "https://api.monday.com",
                    [
                        RelativePath = "v2",
                        Headers      = [
                            #"Authorization" = Token,
                            #"Content-Type"  = "application/json",
                            #"API-Version"   = "2024-10"
                        ],
                        Content      = Corps
                    ]
                )
            )
        in R,

    // --- Première page ------------------------------------------------
    Rep1     = AppelGraphQL(RequetePremiere),
    Page1    = Rep1[data][boards]{0}[items_page],
    Curseur1 = Page1[cursor],
    Items1   = Page1[items],

    // --- Pages suivantes via curseur (List.Generate) -----------------
    Suite = List.Generate(
        () => [cur = Curseur1, items = Items1, stop = (Curseur1 = null)],
        each not [stop],
        each let
                rep  = AppelGraphQL(RequeteSuivante([cur])),
                page = rep[data][next_items_page]
             in [ cur = page[cursor], items = page[items], stop = (page[cursor] = null) ],
        each [items]
    ),

    TousItems = List.Combine({ Items1 } & Suite),

    // --- Transformation : 1 ligne par item, colonnes = titres Monday --
    LigneDepuisItem = (item as record) as record =>
        let
            paires = List.Transform(
                item[column_values],
                each { _[column][title], _[text] }
            ),
            base   = [ item_id = item[id], item_nom = item[name] ]
        in
            Record.Combine({ base, Record.FromList(List.Transform(paires, each _{1}),
                                                   List.Transform(paires, each _{0})) }),

    Enregs = List.Transform(TousItems, each LigneDepuisItem(_)),
    T0     = Table.FromRecords(Enregs, missingField.UseNull),

    // --- Sélection / renommage des colonnes de suivi ------------------
    // 👉 Remplacez les titres ci-dessous par CEUX de votre tableau.
    ColonnesVoulues = {
        {"N° facture",        "numero"},
        {"Client",            "client_nom_monday"},
        {"Statut relance",    "statut_relance"},
        {"Dernière relance",  "date_derniere_relance"},
        {"Prochaine relance", "date_prochaine_relance"},
        {"Responsable",       "responsable_reco"},
        {"Commentaire",       "commentaire"}
    },
    Presentes = List.Select(ColonnesVoulues, each List.Contains(Table.ColumnNames(T0), _{0})),
    T1 = Table.SelectColumns(T0, {"item_id","item_nom"} & List.Transform(Presentes, each _{0}), MissingField.Ignore),
    T2 = Table.RenameColumns(T1, Presentes, MissingField.Ignore),

    // Clé de réconciliation (n° de facture normalisé) — pour la fusion.
    // Si "numero" n'existe pas (colonne absente), on retombe sur item_nom.
    T3 = Table.AddColumn(T2, "cle", each
             Text.Upper(Text.Trim(Text.From(
                 if Record.HasFields(_, "numero") and [numero] <> null then [numero] else [item_nom]
             ))), type text),

    // --- Compatibilité de schéma --------------------------------------
    // Colonnes fournies par la version MULTI-TABLEAUX (monday_multi_boards.pq).
    // On les crée à vide ici pour que les deux connecteurs soient
    // interchangeables sans rien changer dans la table consolidée.
    Compat = {"type_client_monday","regle_base","regle_jours","date_echeance_monday"},
    T4 = List.Accumulate(
            List.Difference(Compat, Table.ColumnNames(T3)),
            T3,
            (etat, nom) => Table.AddColumn(etat, nom, each null)
         )
in
    T4
