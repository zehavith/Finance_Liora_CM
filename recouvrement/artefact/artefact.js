// ══════════════════════════════════════════════════════════════════════
//  LES CLASSEURS SORTENT PAR LA PORTE DU CADRE
// ══════════════════════════════════════════════════════════════════════
//
// L'application produit dix-huit classeurs Excel, tous par le même geste :
// XLSX.writeFile(classeur, nom). En local, SheetJS fabrique un lien et le
// clique — le fichier arrive dans les téléchargements.
//
// Dans un artefact, ce geste est refusé. Pas d'erreur, pas de message : le
// clic ne fait rien. Le cadre a une porte à lui, la capacité « downloads » :
// la page propose un fichier, la lectrice voit son nom et sa taille, et
// accepte ou refuse. Rien ne part sans elle.
//
// Ce fichier n'ajoute pas un dix-neuvième chemin d'export : il remplace le
// geste par celui qui passe. Les dix-huit appels ne changent pas d'une ligne,
// et l'application reste la même des deux côtés. Il se charge après SheetJS,
// qu'il enveloppe, et avant app.js, qui s'en sert.
(function (global) {
    'use strict';

    const XLSX = global.XLSX;
    if (!XLSX || typeof XLSX.writeFile !== 'function') return;

    const natif = XLSX.writeFile;
    const TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

    // La porte s'ouvre une fois, et on garde la clé. claude.use() rend null
    // quand la capacité n'est pas servie — page ouverte hors de l'artefact,
    // ou capacité non accordée : dans ce cas on retombe sur le geste natif,
    // qui marche partout ailleurs.
    let canal, ouverture = null;
    function ouvrir() {
        if (ouverture) return ouverture;
        ouverture = (global.claude && typeof global.claude.use === 'function')
            ? global.claude.use('downloads').then(c => (canal = c || null), () => (canal = null))
            : Promise.resolve(null);
        return ouverture;
    }
    ouvrir();

    const dire = (texte, genre) => {
        const U = global.LioraUI;
        if (U && U.toast) U.toast(texte, genre);
        else console.warn('[artefact] ' + texte);
    };

    // Ce que la lectrice doit lire quand l'enregistrement n'aboutit pas. Un
    // refus n'est pas une panne : elle a dit non, et on le dit comme tel.
    const POURQUOI = {
        declined: null,
        rate_limited: 'Un enregistrement est déjà en attente de votre réponse.',
        too_large: 'Ce classeur est trop volumineux pour être enregistré ici. '
            + 'Filtrez avant d’exporter, ou ouvrez l’application sur votre poste.',
        rejected_extension: 'Ce format ne peut pas être enregistré depuis cette page.',
        extension_not_enabled: 'Le format Excel n’est pas disponible dans cette vue.',
        bad_request: 'Le classeur n’a pas pu être préparé.',
    };

    XLSX.writeFile = function (classeur, nom, options) {
        // Hors artefact — l'application lancée depuis le poste — rien ne
        // change : c'est le même fichier, et il tombe dans les
        // téléchargements comme avant.
        if (!global.claude || typeof global.claude.use !== 'function') {
            return natif.apply(XLSX, arguments);
        }

        // Les octets se fabriquent ici, dans le même tour que le clic : un
        // classeur tenu en mémoire pendant que la lectrice réfléchit n'est
        // pas garanti d'être encore intact. Un Blob est remis tel quel, sans
        // être lu ni transféré — c'est la forme qui coûte le moins sur les
        // gros classeurs, et la balance âgée en est un.
        // Le format se déduit de l'extension du nom, exactement comme le fait
        // SheetJS quand on ne la lui donne pas : figer « xlsx » ici ferait
        // mentir le jour où un export sortirait en .csv.
        const ext = String(nom || '').slice(String(nom || '').lastIndexOf('.') + 1).toLowerCase();
        let morceau;
        try {
            const bruts = XLSX.write(classeur, Object.assign(
                { bookType: /^[a-z]+$/.test(ext) ? ext : 'xlsx' },
                options || {}, { type: 'array' }));
            morceau = new Blob([bruts], { type: TYPE });
        } catch (e) {
            dire('Le classeur n’a pas pu être préparé : ' + (e && e.message || e), 'error');
            return;
        }

        ouvrir().then(function (c) {
            if (!c) {
                dire('Les enregistrements ne sont pas disponibles dans cette vue. '
                    + 'Ouvrez l’application sur votre poste pour exporter.', 'error');
                return;
            }
            return c.save({ filename: String(nom || 'export.xlsx'), data: morceau })
                .then(function () { dire('« ' + nom +' » enregistré.'); })
                .catch(function (err) {
                    const code = err && err.code;
                    if (code === 'declined') return;          // elle a dit non
                    const texte = Object.prototype.hasOwnProperty.call(POURQUOI, code)
                        ? POURQUOI[code]
                        : 'L’enregistrement n’a pas abouti' + (code ? ' (' + code + ')' : '') + '.';
                    if (texte) dire(texte, 'error');
                });
        });
    };

    // SheetJS consulte un global « saveAs » avant de fabriquer son lien.
    // L'application n'en définit aucun, donc le crochet est libre — mais s'il
    // venait à être défini ailleurs, il court-circuiterait tout ce qui
    // précède. On ferme la porte.
    try {
        Object.defineProperty(global, 'saveAs', { value: undefined, writable: false, configurable: false });
    } catch (e) { /* un global déjà défini et non configurable : rien à faire */ }
})(window);
