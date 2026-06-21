// viruses.json handler
const VIRUS_DATA_PATH = path.join(__dirname, 'viruses.json');
let viruses = {};

function loadViruses() {
    try { viruses = JSON.parse(fs.readFileSync(VIRUS_DATA_PATH, 'utf8')); }
    catch { viruses = {}; }
}

function saveViruses() {
    try { fs.writeFileSync(VIRUS_DATA_PATH, JSON.stringify(viruses, null, 2)); }
    catch (err) { console.error('[AIDS] Failed to save viruses.json:', err); }
}

loadViruses();
