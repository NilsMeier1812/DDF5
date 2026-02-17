const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const admin = require('firebase-admin');

// --- FIREBASE SETUP ---
let serviceAccount;
try {
    if (process.env.FIREBASE_CREDENTIALS) {
        serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
    } else {
        serviceAccount = require('./service-account-key.json');
    }
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    console.log("✅ Firebase initialisiert.");
} catch (error) {
    console.error("❌ Firebase Fehler:", error.message);
}

const db = admin.firestore();
const META_DOC_REF = db.collection('settings').doc('server_state');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const GM_PASSWORD = "admin"; 

// --- GAME STATE ---
let currentGameId = "loading"; 
let players = {}; 
let currentRound = { 
    type: 'WAITING', question: '', options: [], pairs: [], targetPlayers: [], 
    min: 0, max: 100, revealed: false, answeringOpen: false 
};
let sessionHistory = [];
let globalRoundCounter = 1;

// --- DB HELPER ---
// WICHTIG: Wir speichern JEDES Spiel in einem eigenen Dokument
const getGameDoc = () => db.collection('games').doc(currentGameId);

async function initServer() {
    try {
        const meta = await META_DOC_REF.get();
        if (meta.exists && meta.data().activeGameId) {
            currentGameId = meta.data().activeGameId;
            console.log(`🔄 Lade aktives Spiel: ${currentGameId}`);
            await loadGameData();
        } else {
            await startNewGameInternal();
        }
    } catch (e) {
        console.error("Init Fehler:", e);
        await startNewGameInternal();
    }
}

async function startNewGameInternal() {
    // 1. Neues Spiel erstellen
    currentGameId = `game_${Date.now()}`;
    
    // 2. RAM komplett leeren
    players = {};
    currentRound = { type: 'WAITING', question: '', revealed: false, answeringOpen: false, options: [], pairs: [], targetPlayers: [] };
    sessionHistory = [];
    globalRoundCounter = 1;

    console.log(`✨ NEUES SPIEL GESTARTET: ${currentGameId}`);

    // 3. Pointer in Firebase aktualisieren
    await META_DOC_REF.set({ activeGameId: currentGameId });
    
    // 4. Leeren State speichern
    saveGame();
}

async function loadGameData() {
    const doc = await getGameDoc().get();
    if (doc.exists) {
        const data = doc.data();
        players = data.players || {};
        currentRound = data.currentRound || { type: 'WAITING', question: '', revealed: false, answeringOpen: false };
        sessionHistory = data.sessionHistory || [];
        globalRoundCounter = data.globalRoundCounter || 1;
        
        // Reset Connections (Socket-IDs sind flüchtig)
        for (let p in players) players[p].connected = false;
        
        console.log(`📥 Geladen: ${Object.keys(players).length} Spieler.`);
    } else {
        saveGame();
    }
}

function saveGame() {
    // Wir speichern ALLES in das Dokument der aktuellen Game-ID
    // Wenn reset gedrückt wird, ändert sich die ID, und das ALTE Dokument bleibt als Archiv bestehen.
    getGameDoc().set({
        gameId: currentGameId,
        players, currentRound, sessionHistory, globalRoundCounter,
        lastUpdated: admin.firestore.FieldValue.serverTimestamp()
    }).catch(e => console.error("Save Error:", e));
}

initServer();

app.use(express.static('public'));
app.get('/', (req, res) => res.send(`Server Online. Game: ${currentGameId}`));
app.get('/gm', (req, res) => res.sendFile(path.join(__dirname, 'public', 'gamemaster.html')));
app.get('/p/:name', (req, res) => res.sendFile(path.join(__dirname, 'public', 'player.html')));

io.on('connection', (socket) => {
    
    const broadcastState = () => {
        // Filtern für Public (Spieler)
        const publicPlayers = {};
        for (const [name, data] of Object.entries(players)) {
            // Nur Spieler anzeigen, die den Code eingegeben haben
            if (!data.isVerified) continue;

            const answerVisible = currentRound.revealed ? data.answer : null;
            publicPlayers[name] = { 
                lives: data.lives, 
                hasAnswered: data.hasAnswered,
                connected: data.connected,
                answer: answerVisible
            };
        }
        
        io.emit('update_game_state', {
            gameId: currentGameId, // WICHTIG: Client prüft das für Reset
            round: currentRound,
            players: publicPlayers,
            history: sessionHistory,
            roundNumber: globalRoundCounter
        });

        // GM bekommt alles
        io.to('gamemaster_room').emit('gm_update_full', {
            gameId: currentGameId,
            round: currentRound,
            players: players, 
            history: sessionHistory,
            roundNumber: globalRoundCounter
        });
    };

    // --- GM ---
    socket.on('gm_login', (pw) => {
        if (pw === GM_PASSWORD) {
            socket.join('gamemaster_room');
            socket.emit('gm_login_success');
            broadcastState();
        } else {
            socket.emit('gm_login_fail');
        }
    });

    socket.on('gm_reset_all', async () => {
        console.log("🧨 GM RESET triggered");
        // Alten Stand ein letztes Mal speichern (wird automatisch archiviert, da wir gleich ID wechseln)
        saveGame();
        
        // Neues Spiel starten (leert RAM und wechselt ID)
        await startNewGameInternal();
        
        // Alle Clients informieren (die merken dann: "Huch, neue ID, ich muss raus")
        broadcastState();
    });

    // --- GAME CONTROL ---
    socket.on('gm_start_round', (data) => {
        // Archivieren der letzten Frage
        if (currentRound.type !== 'WAITING') {
            const roundAnswers = {};
            for(const [name, p] of Object.entries(players)) {
                if (p.hasAnswered && p.answer) roundAnswers[name] = p.answer;
            }
            sessionHistory.push({ question: currentRound.question, type: currentRound.type, answers: roundAnswers });
        }

        // Neue RUNDE (z.B. nach 3 Fragen) -> Speichert Block in Subcollection
        if (data.isNewGameRound) {
            // Wir speichern es in eine Subcollection des AKTUELLEN Spiels
            // Dadurch bleibt die Haupt-Collection sauber
            getGameDoc().collection('archived_rounds').add({
                roundId: globalRoundCounter,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                questions: sessionHistory
            });
            sessionHistory = []; 
            globalRoundCounter++;
        } 

        currentRound = {
            type: data.type,
            question: data.question,
            options: data.options || [], 
            pairs: data.pairs || [],
            targetPlayers: data.targetPlayers || [], 
            min: data.min || 0, max: data.max || 100,
            revealed: false,
            answeringOpen: true 
        };
        
        for (let p in players) {
            players[p].hasAnswered = false;
            players[p].answer = null;
        }
        
        saveGame();
        broadcastState();
    });

    socket.on('gm_close_answering', () => { currentRound.answeringOpen = false; saveGame(); broadcastState(); });
    socket.on('gm_reveal', () => { currentRound.revealed = true; currentRound.answeringOpen = false; saveGame(); broadcastState(); });
    socket.on('gm_modify_lives', (data) => { if (players[data.user]) { players[data.user].lives += data.amount; saveGame(); broadcastState(); }});

    // --- PLAYERS JOIN ---
    
    // 1. GM erstellt manuell Code
    socket.on('gm_create_player', (name) => {
        if (!name) return;
        const code = Math.floor(1000 + Math.random() * 9000).toString();
        players[name] = { 
            code, lives: 3, hasAnswered: false, answer: null, connected: false, isVerified: false 
        };
        saveGame();
        io.to('gamemaster_room').emit('gm_player_joined', { name, code, isManual: true });
        broadcastState();
    });

    // 2. Spieler öffnet URL
    socket.on('player_announce', (name) => {
        let isNew = false;
        
        if (!players[name]) {
            // Spieler existiert im aktuellen Spiel nicht -> Neu anlegen
            const code = Math.floor(1000 + Math.random() * 9000).toString();
            players[name] = { 
                code, lives: 3, hasAnswered: false, answer: null, connected: true, isVerified: false 
            };
            isNew = true;
            saveGame();
        } else {
            // Spieler existiert -> Reconnect
            players[name].connected = true;
            // Wenn er schon verified ist, Auto-Login
            if(players[name].isVerified) {
                socket.emit('player_login_success');
            }
        }
        
        // Wenn noch nicht verified (egal ob neu oder reconnect vor Login), GM benachrichtigen
        if (!players[name].isVerified) {
            io.to('gamemaster_room').emit('gm_player_joined', { name, code: players[name].code, isManual: false });
        }
        
        broadcastState();
    });

    // 3. Login Code Check
    socket.on('player_login', (data) => {
        const { name, code } = data;
        const p = players[name];
        
        if (p && String(p.code).trim() === String(code).trim()) {
            p.isVerified = true;
            p.connected = true;
            socket.emit('player_login_success');
            if (p.hasAnswered) socket.emit('answer_confirmed');
            saveGame();
            broadcastState();
        } else {
            socket.emit('player_login_fail', 'Falscher Code');
        }
    });

    socket.on('submit_answer', (data) => {
        const p = players[data.user];
        if (!p || !p.isVerified) return;
        
        // Stechen Check
        if (currentRound.targetPlayers?.length > 0 && !currentRound.targetPlayers.includes(data.user)) return;

        if (currentRound.answeringOpen) {
            p.answer = data.answer;
            p.hasAnswered = true;
            saveGame();
            socket.emit('answer_confirmed');
            broadcastState();
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server läuft auf Port ${PORT}`);
});
