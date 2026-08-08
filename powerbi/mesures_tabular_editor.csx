// =====================================================================
//  CRÉATION DE TOUTES LES MESURES EN UN CLIC
//  Script Tabular Editor 2 (gratuit) — Power BI Desktop
// ---------------------------------------------------------------------
//  POURQUOI : créer ~35 mesures à la main prend 45 min de clics.
//  Ce script les crée toutes en 2 secondes, formatées et rangées
//  dans des dossiers d'affichage.
//
//  COMMENT :
//   1. Installez Tabular Editor 2 (gratuit) :
//      https://github.com/TabularEditor/TabularEditor/releases
//      → fichier TabularEditor.Installer.msi
//   2. Ouvrez votre rapport dans Power BI Desktop
//   3. Onglet « Outils externes » → « Tabular Editor »
//   4. Dans Tabular Editor : onglet « C# Script »
//   5. Collez CE FICHIER ENTIER → bouton ▶ (ou F5)
//   6. Ctrl+S pour renvoyer les mesures vers Power BI
//
//  ⚠️ Prérequis : la table « Factures » doit exister (requêtes chargées).
//  💡 Relancer le script est sans risque : les mesures existantes sont
//     mises à jour, pas dupliquées.
// =====================================================================

var t = Model.Tables["Factures"];

// Crée ou met à jour une mesure
Action<string, string, string, string> M = (nom, expr, format, dossier) => {
    Measure m = t.Measures.FirstOrDefault(x => x.Name == nom) ?? t.AddMeasure(nom);
    m.Expression      = expr;
    m.FormatString    = format;
    m.DisplayFolder   = dossier;
};

string EUR = "#,0 €";
string EUR2 = "#,0.00 €";
string NB  = "#,0";
string PCT = "0.0%";
string JRS = "#,0 \" j\"";

// ---------------------------------------------------------------------
//  1 · Base
// ---------------------------------------------------------------------
M("Montant facturé",   "SUM ( Factures[montant_ttc] )", EUR, "1 Base");
M("Encours total",     "SUM ( Factures[reste_du_net] )", EUR, "1 Base");
M("Montant encaissé",  "SUMX ( Factures, Factures[montant_ttc] - Factures[reste_du_net] )", EUR, "1 Base");
M("Nb factures",       "DISTINCTCOUNT ( Factures[numero] )", NB, "1 Base");
M("Taux de recouvrement", "DIVIDE ( [Montant encaissé], [Montant facturé] )", PCT, "1 Base");

// ---------------------------------------------------------------------
//  2 · ADV vs Recouvrement
// ---------------------------------------------------------------------
M("Encours ADV", "CALCULATE ( [Encours total], Factures[perimetre] = \"ADV\" )", EUR, "2 ADV vs Recouvrement");
M("Encours Recouvrement", "CALCULATE ( [Encours total], Factures[perimetre] = \"Recouvrement\" )", EUR, "2 ADV vs Recouvrement");
M("Nb factures ADV", "CALCULATE ( [Nb factures], Factures[perimetre] = \"ADV\" )", NB, "2 ADV vs Recouvrement");
M("Nb factures Recouvrement", "CALCULATE ( [Nb factures], Factures[perimetre] = \"Recouvrement\" )", NB, "2 ADV vs Recouvrement");
M("% encours en Recouvrement", "DIVIDE ( [Encours Recouvrement], [Encours ADV] + [Encours Recouvrement] )", PCT, "2 ADV vs Recouvrement");

// ---------------------------------------------------------------------
//  3 · Les 8 indicateurs de l'ancien dashboard
// ---------------------------------------------------------------------
M("Nb factures créées", "DISTINCTCOUNT ( Factures[numero] )", NB, "3 Parité dashboard");

M("Nb factures payées",
  "CALCULATE ( [Nb factures], CONTAINSSTRING ( Factures[statut_relance], \"Payée\" ) )",
  NB, "3 Parité dashboard");

M("Nb factures en recouvrement",
  "CALCULATE ( [Nb factures], Factures[perimetre] = \"Recouvrement\" )",
  NB, "3 Parité dashboard");

// ⚠️ DEUX définitions possibles — elles ne mesurent PAS la même chose.
//
// (A) FACTUELLE — payée APRÈS son échéance. Universelle, tous financements.
//     C'est la mesure par défaut : elle sera complète dès que Pennylane
//     fournira la date de paiement de chaque facture.
M("Nb factures recouvrées",
  "CALCULATE ( [Nb factures], Factures[date_paiement] > Factures[date_echeance] )",
  NB, "3 Parité dashboard");

// (B) ORGANISATIONNELLE — passée par le service recouvrement.
//     ⚠️ Le statut « Payée - Recouvrement » n'existe que pour CORPORATE ;
//     les financements B2C utilisent « Payée - CPF », « Payée B2C »… qui
//     ne disent pas s'il y a eu recouvrement. À n'utiliser que filtré
//     sur Corporate.
M("Nb recouvrées (service Corporate)",
  "CALCULATE ( [Nb factures], CONTAINSSTRING ( Factures[statut_relance], \"Payée - Recouvrement\" ) )",
  NB, "3 Parité dashboard");

M("Somme en recouvrement", "CALCULATE ( [Encours total], Factures[perimetre] = \"Recouvrement\" )", EUR, "3 Parité dashboard");

M("Somme recouvrée",
  "CALCULATE ( SUM ( Factures[montant_ttc] ), Factures[date_paiement] > Factures[date_echeance] )",
  EUR, "3 Parité dashboard");

M("Nb Bad Debt", "CALCULATE ( [Nb factures], Factures[jours_retard] > 360 )", NB, "3 Parité dashboard");
M("Nb Bad Debt payée",
  "CALCULATE ( [Nb factures], Factures[jours_retard] > 360, CONTAINSSTRING ( Factures[statut_relance], \"Payée\" ) )",
  NB, "3 Parité dashboard");
M("Somme Bad Debt", "CALCULATE ( [Encours total], Factures[jours_retard] > 360 )", EUR, "3 Parité dashboard");

// ---------------------------------------------------------------------
//  4 · Les taux
// ---------------------------------------------------------------------
M("Taux de facture en recouvrement", "DIVIDE ( [Nb factures en recouvrement], [Nb factures créées] )", PCT, "4 Taux");
M("Taux nb factures recouvrées",     "DIVIDE ( [Nb factures recouvrées], [Nb factures en recouvrement] )", PCT, "4 Taux");
M("Taux montant recouvré",           "DIVIDE ( [Somme recouvrée], [Somme en recouvrement] )", PCT, "4 Taux");
M("Taux de facture Bad Debt",        "DIVIDE ( [Nb Bad Debt], [Nb factures créées] )", PCT, "4 Taux");
M("Taux Bad Debt recouvrée",         "DIVIDE ( [Nb Bad Debt payée], [Nb Bad Debt] )", PCT, "4 Taux");

// ---------------------------------------------------------------------
//  5 · DSO et sa VARIATION
// ---------------------------------------------------------------------
M("DSO",
  "AVERAGEX ( FILTER ( Factures, NOT ISBLANK ( Factures[delai_paiement] ) ), Factures[delai_paiement] )",
  JRS, "5 DSO");

M("DSO médian",
  "MEDIANX ( FILTER ( Factures, NOT ISBLANK ( Factures[delai_paiement] ) ), Factures[delai_paiement] )",
  JRS, "5 DSO");

M("DSO mois précédent",
  "CALCULATE ( [DSO], DATEADD ( Calendrier[Date], -1, MONTH ) )",
  JRS, "5 DSO");

M("Variation DSO",
  "VAR a = [DSO] VAR b = [DSO mois précédent] RETURN IF ( ISBLANK ( b ), BLANK (), a - b )",
  "+#,0 \" j\";-#,0 \" j\";0 \" j\"", "5 DSO");

M("Variation DSO %",
  "DIVIDE ( [Variation DSO], [DSO mois précédent] )",
  "+0.0%;-0.0%;0.0%", "5 DSO");

M("DSO 3 mois glissants",
  "CALCULATE ( [DSO], DATESINPERIOD ( Calendrier[Date], MAX ( Calendrier[Date] ), -3, MONTH ) )",
  JRS, "5 DSO");

M("DSO année précédente",
  "CALCULATE ( [DSO], SAMEPERIODLASTYEAR ( Calendrier[Date] ) )",
  JRS, "5 DSO");

// Flèche de tendance : ↓ = on encaisse plus vite = bon
M("Tendance DSO",
  "VAR v = [Variation DSO] RETURN SWITCH ( TRUE (), ISBLANK ( v ), \"\", v < -2, \"▼ s'améliore\", v > 2, \"▲ se dégrade\", \"= stable\" )",
  null, "5 DSO");

// Couleur à brancher sur « Mise en forme conditionnelle > Couleur de police »
M("Couleur variation DSO",
  "VAR v = [Variation DSO] RETURN SWITCH ( TRUE (), ISBLANK ( v ), \"#8B91A5\", v < -2, \"#0CA30C\", v > 2, \"#D03B3B\", \"#5B6178\" )",
  null, "5 DSO");

M("Écart à l'objectif DSO",
  "VAR objectif = 90 RETURN [DSO] - objectif",
  "+#,0 \" j\";-#,0 \" j\";0 \" j\"", "5 DSO");

// ---------------------------------------------------------------------
//  6 · Retard et balance âgée
// ---------------------------------------------------------------------
M("Total échu", "CALCULATE ( [Encours total], Factures[jours_retard] > 0 )", EUR, "6 Retard");
M("% échu", "DIVIDE ( [Total échu], [Encours total] )", PCT, "6 Retard");
M("Retard moyen pondéré",
  "DIVIDE ( SUMX ( FILTER ( Factures, Factures[jours_retard] > 0 ), Factures[reste_du_net] * Factures[jours_retard] ), [Total échu] )",
  JRS, "6 Retard");
M("Encours positif", "SUMX ( FILTER ( Factures, Factures[reste_du_net] > 0 ), Factures[reste_du_net] )", EUR, "6 Retard");
M("Encours négatif (avoirs)", "SUMX ( FILTER ( Factures, Factures[reste_du_net] < 0 ), Factures[reste_du_net] )", EUR, "6 Retard");
M("Encours net", "[Encours positif] + [Encours négatif (avoirs)]", EUR, "6 Retard");

// ---------------------------------------------------------------------
//  7 · Contrôles de cohérence
// ---------------------------------------------------------------------
M("Nb factures manquantes sur Monday",
  "CALCULATE ( [Nb factures], Factures[present_monday] = FALSE (), Factures[reste_du_net] > 0 )",
  NB, "7 Contrôles");
M("Encours manquant sur Monday",
  "CALCULATE ( [Encours total], Factures[present_monday] = FALSE (), Factures[reste_du_net] > 0 )",
  EUR, "7 Contrôles");
M("Nb factures à déplacer",
  "CALCULATE ( [Nb factures], Factures[coherence_monday] = \"À déplacer\" )",
  NB, "7 Contrôles");
M("Encours à déplacer",
  "CALCULATE ( [Encours total], Factures[coherence_monday] = \"À déplacer\" )",
  EUR, "7 Contrôles");
M("% couverture Monday",
  "DIVIDE ( CALCULATE ( [Nb factures], Factures[present_monday] = TRUE () ), [Nb factures] )",
  PCT, "7 Contrôles");

Info("✅ " + t.Measures.Count + " mesures présentes sur la table Factures. Ctrl+S pour les envoyer vers Power BI.");
