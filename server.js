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
let currentGameId = "init"; 
let players = {}; 
let currentRound = { 
    type: 'WAITING', question: '', options: [], pairs: [], targetPlayers: [], 
    min: 0, max: 100, revealed: false, answeringOpen: false, 
    correctAnswer: null // Neu: Lösung
};
let sessionHistory = [];
let globalRoundCounter = 1;

// --- DB HELPER ---
const getGameDoc = () => db.collection('games').doc(currentGameId);
const getArchiveCol = () => db.collection('games').doc(currentGameId).collection('archived_rounds');

async function initServer() {
    try {
        const meta = await META_DOC_REF.get();
        if (meta.exists && meta.data().activeGameId) {
            currentGameId = meta.data().activeGameId;
            await loadGameData();
        } else {
            await startNewGameInternal();
        }
    } catch (e) {
        await startNewGameInternal();
    }
}

async function startNewGameInternal() {
    currentGameId = `game_${Date.now()}`;
    players = {};
    currentRound = { type: 'WAITING', question: '', revealed: false, answeringOpen: false, options: [], pairs: [], targetPlayers: [], correctAnswer: null };
    sessionHistory = [];
    globalRoundCounter = 1;
    await META_DOC_REF.set({ activeGameId: currentGameId });
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
        for (let p in players) players[p].connected = false;
    } else {
        saveGame();
    }
}

function saveGame() {
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
        const publicPlayers = {};
        for (const [name, data] of Object.entries(players)) {
            if (!data.isVerified) continue;
            // Antwort nur senden wenn aufgedeckt
            const answerVisible = currentRound.revealed ? data.answer : null;
            publicPlayers[name] = { 
                lives: data.lives, 
                hasAnswered: data.hasAnswered,
                connected: data.connected,
                answer: answerVisible
            };
        }
        
        io.emit('update_game_state', {
            gameId: currentGameId,
            round: currentRound,
            players: publicPlayers,
            history: sessionHistory,
            roundNumber: globalRoundCounter
        });

        io.to('gamemaster_room').emit('gm_update_full', {
            gameId: currentGameId,
            round: currentRound,
            players: players, 
            history: sessionHistory,
            roundNumber: globalRoundCounter
        });
    };

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
        saveGame();
        await startNewGameInternal();
        broadcastState();
    });

    // --- GAME FLOW ---

    // 1. Neue Spielrunde (Archivieren + Reset)
    socket.on('gm_next_round_phase', () => {
        // Letzte Frage archivieren falls nötig
        archiveCurrentQuestion();

        // Runde in DB archivieren
        const livesSnapshot = {};
        for (const [name, p] of Object.entries(players)) livesSnapshot[name] = p.lives;

        getArchiveCol().add({
            roundId: globalRoundCounter,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            playerLives: livesSnapshot,
            questions: sessionHistory
        });

        // Reset für neue Runde
        sessionHistory = [];
        globalRoundCounter++;
        
        // Status auf Waiting setzen
        currentRound = {
            type: 'WAITING', question: 'Runde beendet.', revealed: false, answeringOpen: false, 
            options: [], pairs: [], targetPlayers: [], correctAnswer: null 
        };
        
        // Antworten resetten
        for (let p in players) {
            players[p].hasAnswered = false;
            players[p].answer = null;
        }

        saveGame();
        broadcastState();
    });

    // 2. Frage Starten
    socket.on('gm_start_round', (data) => {
        archiveCurrentQuestion(); // Alte Frage wegpacken

        currentRound = {
            type: data.type,
            question: data.question,
            options: data.options || [], 
            pairs: data.pairs || [],
            targetPlayers: data.targetPlayers || [], 
            min: data.min !== undefined ? Number(data.min) : 0,
            max: data.max !== undefined ? Number(data.max) : 100,
            correctAnswer: data.correctAnswer, // Die Lösung vom GM
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

    function archiveCurrentQuestion() {
        if (currentRound.type !== 'WAITING') {
            const roundAnswers = {};
            for(const [name, p] of Object.entries(players)) {
                if (p.hasAnswered && p.answer) roundAnswers[name] = p.answer;
            }
            sessionHistory.push({ 
                question: currentRound.question, 
                type: currentRound.type, 
                correctAnswer: currentRound.correctAnswer,
                answers: roundAnswers 
            });
        }
    }

    socket.on('gm_close_answering', () => { currentRound.answeringOpen = false; saveGame(); broadcastState(); });
    socket.on('gm_reveal', () => { currentRound.revealed = true; currentRound.answeringOpen = false; saveGame(); broadcastState(); });
    socket.on('gm_modify_lives', (data) => { if (players[data.user]) { players[data.user].lives += data.amount; saveGame(); broadcastState(); }});

    // --- PLAYER JOINING ---
    socket.on('gm_create_player', (name) => {
        if (!name) return;
        const code = Math.floor(1000 + Math.random() * 9000).toString();
        players[name] = { code, lives: 3, hasAnswered: false, answer: null, connected: false, isVerified: false };
        saveGame();
        io.to('gamemaster_room').emit('gm_player_joined', { name, code, isManual: true });
        broadcastState();
    });

    socket.on('player_announce', (name) => {
        let isNew = false;
        if (!players[name]) {
            players[name] = { code: Math.floor(1000 + Math.random() * 9000).toString(), lives: 3, hasAnswered: false, answer: null, connected: true, isVerified: false };
            saveGame();
            isNew = true;
        } else {
            players[name].connected = true;
            if(players[name].isVerified) socket.emit('player_login_success');
        }
        if (isNew || !players[name].isVerified) io.to('gamemaster_room').emit('gm_player_joined', { name, code: players[name].code, isManual: false });
        broadcastState();
    });

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
