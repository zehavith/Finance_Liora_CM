// =====================================================================
//  MONDAY.COM — TOUS VOS TABLEAUX DE SUIVI FACTURES
//  Requête Power Query (M) — API GraphQL v2
//  Nom de requête conseillé :  Monday_Suivi   (remplace monday_relances.pq)
// ---------------------------------------------------------------------
//  ⭐ CONÇU D'APRÈS L'EXPORT RÉEL DE VOS 6 TABLEAUX
//
//  Constat : les titres de colonnes DIFFÈRENT fortement d'un tableau à
//  l'autre (28 à 102 colonnes ; seule « Name » est commune) —
//     « Début de service » / « Début de formation » / « Début Formation »
//     « Date d’échéance facture » (apostrophe typographique) vs
//     « Date d'échéance » (apostrophe droite) vs « Date échéance »
//
//  ➜ On ne mappe donc PAS par titre exact : chaque CONCEPT (date de
//    facture, échéance, montant…) possède une liste de titres possibles,
//    comparés de façon insensible à la casse, aux accents, aux
//    apostrophes et aux espaces multiples. Ajouter un tableau ou
//    renommer une colonne ne casse rien : il suffit d'ajouter une
//    variante dans la liste du concept concerné.
//
//  Prérequis : paramètre  pMondayToken  uniquement.
//  ⏱️ Volumétrie : ~3 000 items par tableau → le 1er chargement peut
//     prendre plusieurs minutes. C'est normal.
// =====================================================================
let
    Token = pMondayToken,

    // =================================================================
    //  ⚙️ 1) VOS TABLEAUX
    // =================================================================
    //  type_client / sous_categorie : utilisés en SECOURS quand la
    //    colonne « Type de client » du tableau est vide ou absente
    //    (cas des tableaux 2.2 CPF et 2.4 REGION, qui n'ont pas la colonne).
    //  base / jours : règle d'échéance de secours, appliquée uniquement
    //    si aucune date d'échéance n'est renseignée dans Monday.
    //      "facture" = date de facture | "debut" = début de service
    //      "fin" = fin de service      | "" = pas de règle
    //
    //  ⚠️ ORDRE = PRIORITÉ pour la déduplication (§6).
    //  perimetre : « ADV » ou « Recouvrement » — visibilité demandée.
    //    Laisser "" quand le tableau ne tranche pas : le périmètre est
    //    alors déduit du statut / de la catégorie de dette / du groupe
    //    (voir DeduirePerimetre §5).
    //  ⚠️ À VALIDER : seuls 1.1 (ADV) et 1.2 (Recouvrement) sont certains.
    //     Pour les tableaux B2C (2.x) et OPCO, dites-moi s'ils relèvent
    //     de l'ADV ou du recouvrement et je fige la valeur.
    BoardsConfig = #table(
        {"prefixe","type_client","sous_categorie","perimetre","base","jours"},
        {
            {"1.0.", "B2C - Entreprise", "Entreprise - Tampon",       "ADV",          "facture", 30},
            {"1.1.", "B2C - Entreprise", "Entreprise - ADV",          "ADV",          "facture", 30},
            {"1.2.", "B2C - Entreprise", "Entreprise - Recouvrement", "Recouvrement", "facture", 30},
            {"1.3.", "OPCO",             "Entreprise - OPCO",         "",             "fin",     60},
            {"2.1.", "BTC-Perso",        "Financement Personnel",     "",             "debut",    0},
            {"2.2.", "CPF",              "Financement CPF",           "",             "fin",     45},
            // 2.3 mélange AIF et POEI — même règle (+60 j), distingués
            // pour l'analyse via GroupesConfig ↓
            {"2.3.", "AIF",              "Financement pôle emploi",   "",             "fin",     60},
            {"2.4.", "Region",           "Financement complexe",      "",             "fin",     60},
            // EN DERNIER : complément uniquement
            {"0.1.", "",                 "ALL - Factures payées",     "",             "facture", 30}
        }
    ),

    // =================================================================
    //  ⚙️ 1bis) AFFINAGE PAR GROUPE (quand un tableau mélange 2 types)
    // =================================================================
    //  Cas réel : « 2.3. Financement pôle emploi : AIF / POEI » contient
    //  les deux financements, avec des règles différentes (+45 j / +60 j).
    //  Le GROUPE de l'item permet de trancher.
    //
    //  prefixe  : tableau concerné · contient : texte cherché dans le nom
    //  du groupe (insensible casse/accents). Première ligne qui matche
    //  l'emporte sur la configuration du tableau.
    //
    //  ✅ AIF et POEI ont la MÊME règle (fin de formation +60 j) : cet
    //     affinage ne sert donc qu'à les DISTINGUER dans les analyses.
    //     Les groupes neutres gardent le défaut du tableau, sans impact
    //     sur l'échéance.
    GroupesConfig = #table(
        {"prefixe","contient","type_client","sous_categorie","base","jours"},
        {
            {"2.3.", "poei", "POEI", "Financement POEI", "fin", 60},
            {"2.3.", "aif",  "AIF",  "Financement AIF",  "fin", 60}
        }
    ),

    // =================================================================
    //  ⚙️ 1ter) ADV vs RECOUVREMENT — mots-clés de détection
    // =================================================================
    //  Cherchés (en minuscules, sans accents) dans le statut, la
    //  catégorie de dette puis le nom du groupe. Le premier trouvé gagne.
    MotsRecouvrement = {"payee - recouvrement", "recouvrement"},
    MotsADV          = {"payee - adv", "adv pas en retard", "adv"},

    // =================================================================
    //  ⚙️ 2) CONCEPTS → titres possibles (par ORDRE DE PRIORITÉ)
    // =================================================================
    //  Écrivez les variantes en minuscules sans accent : la comparaison
    //  est faite après normalisation. Pour ajouter une colonne, ajoutez
    //  simplement une ligne (ou une variante dans une ligne existante).
    Concepts = {
        // --- Dates -----------------------------------------------------
        {"date_facture",      {"date facture", "date de facture",
                               "date depot de la facture", "date envoi facture initial"}},
        {"date_echeance",     {"date d'echeance facture", "date d'echeance", "date echeance"}},
        // ⚠️ 2 graphies réelles : avec ET sans espaces autour du « / »
        {"date_echeance_calc",{"date echeance calculee / negociee",
                               "date d'echeance calculee/negociee",
                               "date d'echeance calculee / negociee",
                               "date echeance calculee/negociee",
                               "date d'echeance calculee"}},
        {"date_debut",        {"debut de service", "debut de formation", "debut formation"}},
        {"date_fin",          {"fin de service", "fin de formation", "fin formation"}},
        {"date_paiement",     {"date paiement", "date de paiement"}},

        // --- Montants (contrôle ; Pennylane reste la vérité paiement) --
        {"total_ttc",         {"total ttc", "total facture", "montant", "montant ttc"}},
        {"reste_du",          {"reste a devoir ttc",
                               "reste a payer ( d'apres le grand livre )",
                               "reste a payer", "restant a payer",
                               "montant restant penny", "montant restant sellsy",
                               "montant en recouvrement"}},
        {"montant_partiel",   {"montant partiel recu", "total paid"}},

        // --- Identité --------------------------------------------------
        //  « apprenant » en dernier : en B2C, l'apprenant EST le client.
        {"client",            {"client", "entreprise", "apprenant",
                               "nom & prenom de l'apprenant",
                               "nom et prenom apprenant", "nom prenom apprenant"}},
        {"type_client",       {"type de client"}},
        {"num_zoho",          {"n° zoho", "no zoho"}},
        {"id_client_sellsy",  {"id client sellsy"}},

        // --- Statuts / qualification -----------------------------------
        {"qualif_recouvrement",{"qualifaction recouvrement", "qualification recouvrement"}},
        {"qualif_adv",        {"qualification adv", "qualifaction adv"}},
        {"statut",            {"statut", "statut 1", "statut initiale",
                               "statut paiement", "statut creance"}},
        {"etape_process",     {"etape process recouvrement"}},
        {"categorie_dette",   {"categorie de dette"}},
        {"categorie_retard",  {"categorie de retard"}},
        {"jours_retard_m",    {"j de retard"}},

        // --- Relances ---------------------------------------------------
        {"derniere_relance",  {"date derniere relance manuelle", "date derniere relance"}},
        {"prochaine_relance", {"date prochaine relance", "prochaine relance",
                               "date de paiement prevu post-echeance",
                               "date paiement prevue pre-echeance"}},
        {"responsable_reco",  {"responsable", "responsable recouvrement"}},
        {"relance_1",         {"relance 1 - j"}},
        {"date_relance_1",    {"date 1 - recouvrement"}},
        {"relance_2",         {"relance 2 - j+10"}},
        {"date_relance_2",    {"date 2 - recouvrement"}},
        {"relance_3",         {"relance 3 - j+30"}},
        {"date_relance_3",    {"date 3 - recouvrement"}},

        // --- Divers -----------------------------------------------------
        {"formation",         {"nom de la formation"}},
        {"lien_facture",      {"lien public"}},
        {"commentaire",       {"commentaire post echeance", "commentaire pre-echance",
                               "commentaire"}}
    },

    // =================================================================
    //  3) Normalisation des titres
    // =================================================================
    SansAccents = (t as text) as text =>
        List.Accumulate(
            {
                {"à","a"},{"á","a"},{"â","a"},{"ä","a"},
                {"é","e"},{"è","e"},{"ê","e"},{"ë","e"},
                {"í","i"},{"î","i"},{"ï","i"},
                {"ó","o"},{"ô","o"},{"ö","o"},
                {"ù","u"},{"ú","u"},{"û","u"},{"ü","u"},
                {"ç","c"},{"’","'"},{"`","'"},{"‘","'"}
            },
            Text.Lower(t),
            (s, p) => Text.Replace(s, p{0}, p{1})
        ),

    Norm = (t as any) as text =>
        if t = null then ""
        else Text.Trim(Text.Combine(
                List.Select(Text.Split(SansAccents(Text.From(t)), " "), each _ <> ""), " ")),

    // =================================================================
    //  4) Appel GraphQL
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

    // --- Résolution nom → board id (+ rang de priorité) ---------------
    ListeConfigs = Table.ToRecords(BoardsConfig),
    Configs = List.Transform(
        List.Positions(ListeConfigs),
        (i) => ListeConfigs{i} & [ordre = i]
    ),
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

    // --- Items d'un tableau (pagination par curseur) ------------------
    ItemsDuBoard = (boardId as text) as list =>
        let
            Champs = "{ cursor items { id name group { title } "
                   & "column_values { id text column { title } } } }",
            Req1   = "query { boards(ids: [" & boardId & "]) { items_page(limit: 100) "
                   & Champs & " } }",
            Rep1   = AppelGraphQL(Req1),
            Page1  = Rep1[data][boards]{0}[items_page],

            ReqSuite = (cursor as text) as text =>
                "query { next_items_page(limit: 100, cursor: """ & cursor & """) "
              & Champs & " }",

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

    // =================================================================
    //  5) Un item → une ligne normalisée (concepts résolus)
    // =================================================================
    //  Certains tableaux ont DEUX colonnes de même titre (ex. « Statut »
    //  en double dans 1.1) : on dédoublonne en gardant la 1re valeur
    //  non vide.
    DicoDepuisItem = (item as record) as record =>
        let
            paires = List.Transform(item[column_values],
                        each { Norm(try _[column][title] otherwise null), _[text] }),
            cles   = List.Distinct(List.Transform(paires, each _{0})),
            valeur = (k) =>
                let v = List.Select(paires, each _{0} = k and _{1} <> null and _{1} <> "")
                in  if List.Count(v) > 0 then v{0}{1} else null
        in
            Record.FromList(List.Transform(cles, each valeur(_)), cles),

    // Première variante renseignée pour un concept donné
    ValeurConcept = (dico as record, variantes as list) as nullable text =>
        let
            ok = List.Select(variantes, (v) =>
                    Record.HasFields(dico, v)
                    and Record.Field(dico, v) <> null
                    and Record.Field(dico, v) <> "")
        in
            if List.Count(ok) = 0 then null else Record.Field(dico, ok{0}),

    LigneDepuisItem = (item as record) as record =>
        let
            dico = DicoDepuisItem(item),
            base = [ item_id       = item[id],
                     item_nom      = item[name],
                     groupe_monday = try item[group][title] otherwise null ],
            champs = Record.FromList(
                        List.Transform(Concepts, each ValeurConcept(dico, _{1})),
                        List.Transform(Concepts, each _{0}))
        in
            Record.Combine({ base, champs }),

    // =================================================================
    //  6) Un tableau → une table ; puis empilage et déduplication
    // =================================================================
    TableDuBoard = (cfg as record) as table =>
        let
            Items  = ItemsDuBoard(cfg[board_id]),
            Enregs = List.Transform(Items, each LigneDepuisItem(_)),
            T0     = Table.FromRecords(Enregs, missingField.UseNull),

            // Affinage éventuel par groupe (ex. AIF vs POEI dans 2.3)
            Raffinements = List.Select(Table.ToRecords(GroupesConfig),
                              (g) => g[prefixe] = cfg[prefixe]),
            RegleLigne = (groupe as nullable text) as record =>
                let
                    g = Norm(groupe),
                    hits = List.Select(Raffinements, (r) => Text.Contains(g, r[contient]))
                in
                    if List.Count(hits) > 0 then hits{0}
                    else [type_client = cfg[type_client], sous_categorie = cfg[sous_categorie],
                          base = cfg[base], jours = cfg[jours]],

            // Métadonnées du tableau (affinées par groupe si applicable)
            T1 = Table.AddColumn(T0, "board_nom",   each cfg[board_nom], type text),
            T2 = Table.AddColumn(T1, "board_ordre", each cfg[ordre], Int64.Type),
            TR = Table.AddColumn(T2, "regle", each RegleLigne([groupe_monday])),
            T3 = Table.AddColumn(TR, "sous_categorie_monday", each
                    if [regle][sous_categorie] = "" then null else [regle][sous_categorie], type text),
            T4 = Table.AddColumn(T3, "regle_base", each
                    if [regle][base] = "" then null else [regle][base], type text),
            T5 = Table.AddColumn(T4, "regle_jours", each [regle][jours], Int64.Type),

            // Type de client : colonne Monday d'abord, groupe/tableau en secours
            T6 = Table.AddColumn(T5, "type_client_monday", each
                    if [type_client] <> null and [type_client] <> ""
                       and [type_client] <> "Type de client"
                    then [type_client]
                    else if [regle][type_client] = "" then null else [regle][type_client], type text),

            // Statut de suivi : qualification > statut > groupe
            T7 = Table.AddColumn(T6, "statut_relance", each
                    if [qualif_recouvrement] <> null then [qualif_recouvrement]
                    else if [statut] <> null then [statut]
                    else [groupe_monday], type text),

            // --- Où la facture est-elle rangée DANS MONDAY ? ----------
            //  ⚠️ Ceci n'est PAS le périmètre de référence : ADV vs
            //     Recouvrement se calcule sur le RETARD (voir la table
            //     consolidée). On garde l'info Monday pour la comparer
            //     au calcul et repérer les factures mal rangées
            //     (ex. en retard mais toujours dans un tableau ADV).
            T7b = Table.AddColumn(T7, "perimetre_monday", each
                    let
                        Cherche = (txt as nullable text, mots as list) as logical =>
                            let t = Norm(txt)
                            in  t <> "" and List.AnyTrue(
                                    List.Transform(mots, (m) => Text.Contains(t, m))),
                        parStatut =
                            if Cherche([statut], {"payee - recouvrement"}) then "Recouvrement"
                            else if Cherche([statut], {"payee - adv"}) then "ADV"
                            else null,
                        parDette =
                            if Cherche([categorie_dette], {"adv pas en retard"}) then "ADV"
                            else if Cherche([categorie_dette], MotsRecouvrement) then "Recouvrement"
                            else null,
                        parGroupe =
                            if Cherche([groupe_monday], MotsRecouvrement) then "Recouvrement"
                            else if Cherche([groupe_monday], MotsADV) then "ADV"
                            else null,
                        parQualif =
                            if [qualif_recouvrement] <> null then "Recouvrement"
                            else if [qualif_adv] <> null then "ADV"
                            else null
                    in
                        if parStatut <> null then parStatut
                        else if parDette <> null then parDette
                        else if parGroupe <> null then parGroupe
                        else if parQualif <> null then parQualif
                        else if cfg[perimetre] <> "" then cfg[perimetre]
                        else "Non qualifié", type text),

            // Clé = n° de facture = nom de l'item (FACT-xxxx-xxxxx)
            T8 = Table.AddColumn(T7b, "cle", each
                    Text.Upper(Text.Trim(
                        if [item_nom] = null then "" else Text.From([item_nom])
                    )), type text),

            // Ligne renseignée ou coquille vide ? (cf. déduplication)
            T9 = Table.AddColumn(T8, "a_des_donnees", each
                    if [total_ttc] <> null or [date_facture] <> null or [reste_du] <> null
                    then 1 else 0, Int64.Type),
            T10 = Table.RemoveColumns(T9, {"regle"})
        in
            T10,

    Tables  = List.Transform(ConfigsOk, each try TableDuBoard(_) otherwise null),
    Valides = List.RemoveNulls(Tables),
    Empile  = Table.Combine(Valides),

    SansVides = Table.SelectRows(Empile, each [cle] <> null and [cle] <> ""),

    // ⚠️ Une facture peut figurer dans PLUSIEURS tableaux (notamment dans
    //    « ALL - Factures payées »), et vos tableaux contiennent beaucoup
    //    de lignes « coquilles » sans données (groupes Technique/Archive).
    //    Sans cette étape, la fusion en aval dupliquerait les factures et
    //    GONFLERAIT les montants. On trie : lignes renseignées d'abord,
    //    puis priorité de tableau — Table.Distinct garde la première.
    Trie   = Table.Sort(SansVides, {
                 {"a_des_donnees", Order.Descending},
                 {"board_ordre",   Order.Ascending}
             }),
    Unique = Table.Distinct(Table.Buffer(Trie), {"cle"}),

    // =================================================================
    //  7) Typage
    // =================================================================
    //  💡 Si une date/un montant ne se convertit pas, vérifiez le format
    //     affiché dans Monday et adaptez la culture ("fr-FR" ↔ "en-US").
    Typé = Table.TransformColumnTypes(
        Unique,
        {
            {"date_facture", type date},
            {"date_echeance", type date},
            {"date_echeance_calc", type date},
            {"date_debut", type date},
            {"date_fin", type date},
            {"date_paiement", type date},
            {"derniere_relance", type date},
            {"prochaine_relance", type date},
            {"date_relance_1", type date},
            {"date_relance_2", type date},
            {"date_relance_3", type date},
            {"total_ttc", type number},
            {"reste_du", type number},
            {"montant_partiel", type number},
            {"jours_retard_m", Int64.Type}
        },
        "fr-FR"
    ),

    // Noms de sortie attendus par la table consolidée
    Resultat = Table.RenameColumns(Typé, {
        {"date_facture",       "date_facture_monday"},
        {"date_echeance",      "date_echeance_monday"},
        {"date_echeance_calc", "date_echeance_calc_monday"},
        {"date_debut",         "date_debut_formation_monday"},
        {"date_fin",           "date_fin_formation_monday"},
        {"date_paiement",      "date_paiement_monday"},
        {"derniere_relance",   "date_derniere_relance"},
        {"prochaine_relance",  "date_prochaine_relance"},
        {"total_ttc",          "total_ttc_monday"},
        {"reste_du",           "reste_du_monday"},
        {"client",             "client_nom_monday"}
    }, MissingField.Ignore)
in
    Resultat
