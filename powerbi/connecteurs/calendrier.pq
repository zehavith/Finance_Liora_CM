// =====================================================================
//  CALENDRIER — Table de dates (dimension temps)
//  Requête Power Query (langage M)
// ---------------------------------------------------------------------
//  Rôle : table de dates continue pour l'analyse temporelle (DSO,
//         évolution de l'encours, filtres par mois/trimestre).
//         À marquer ensuite comme "Table de dates" dans Power BI
//         (Modèle > clic droit sur la table > Marquer comme table de dates).
//
//  Relation recommandée :
//     Calendrier[Date] --(1:*)--> Factures_Pennylane[date_echeance]  (active)
//     Calendrier[Date] --(1:*)--> Factures_Pennylane[date_emission]  (inactive)
//
//  Prérequis : paramètre  pAnneeDebut  (nombre, ex : 2023)
// =====================================================================
let
    AnneeDebut = try Number.From(pAnneeDebut) otherwise 2023,
    DateDebut  = #date(AnneeDebut, 1, 1),
    // On va jusqu'à fin de l'année en cours
    DateFin    = #date(Date.Year(DateTime.Date(DateTime.LocalNow())), 12, 31),

    NbJours = Duration.Days(DateFin - DateDebut) + 1,
    Liste   = List.Dates(DateDebut, NbJours, #duration(1,0,0,0)),

    T0 = Table.FromList(Liste, Splitter.SplitByNothing(), {"Date"}),
    T1 = Table.TransformColumnTypes(T0, {{"Date", type date}}),

    T2 = Table.AddColumn(T1, "Année",       each Date.Year([Date]), Int64.Type),
    T3 = Table.AddColumn(T2, "N° Mois",     each Date.Month([Date]), Int64.Type),
    T4 = Table.AddColumn(T3, "Mois",        each Date.ToText([Date], "MMMM", "fr-FR"), type text),
    T5 = Table.AddColumn(T4, "Année-Mois",  each Date.ToText([Date], "yyyy-MM"), type text),
    T6 = Table.AddColumn(T5, "Trimestre",   each "T" & Text.From(Date.QuarterOfYear([Date])), type text),
    T7 = Table.AddColumn(T6, "Jour semaine",each Date.ToText([Date], "dddd", "fr-FR"), type text)
in
    T7
