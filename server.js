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
    console.log("🔥 Firebase erfolgreich initialisiert!");
} catch (error) {
    console.error("❌ FEHLER: Firebase Credentials fehlen.");
}

const db = admin.firestore();
const META_DOC_REF = db.collection('settings').doc('server_state');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const GM_PASSWORD = "admin"; 

// --- STATUS ---
let currentGameId = "init_session";
let players = {}; 
let currentRound = { 
    type: 'WAITING', 
    question: '', 
    options: [], 
    pairs: [], 
    targetPlayers: [], 
    min: 0, 
    max: 100, 
    revealed: false,
    answeringOpen: false 
};
let sessionHistory = [];
let globalRoundCounter = 1;

// --- DATABASE HELPER ---
const getGameDoc = () => db.collection('games').doc(currentGameId);
const getArchiveCol = () => db.collection('games').doc(currentGameId).collection('archives');

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
        console.error("Init Error:", e);
        await startNewGameInternal();
    }
}

async function startNewGameInternal() {
    currentGameId = `game_${Date.now()}`;
    players = {};
    currentRound = { type: 'WAITING', question: '', revealed: false, answeringOpen: false, options: [], pairs: [], targetPlayers: [] };
    sessionHistory = [];
    globalRoundCounter = 1;

    console.log(`✨ STARTE NEUES SPIEL: ${currentGameId}`);
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
app.get('/', (req, res) => res.send(`Server Online. Active Game: ${currentGameId}`));
app.get('/gm', (req, res) => res.sendFile(path.join(__dirname, 'public', 'gamemaster.html')));
app.get('/p/:name', (req, res) => res.sendFile(path.join(__dirname, 'public', 'player.html')));

io.on('connection', (socket) => {
    
    const broadcastStatus = () => {
        const publicPlayers = {};
        for (const [name, data] of Object.entries(players)) {
            const answerVisible = currentRound.revealed ? data.answer : null;
            publicPlayers[name] = { 
                lives: data.lives, 
                hasAnswered: data.hasAnswered,
                connected: data.connected,
                answer: answerVisible
            };
        }
        
        io.emit('update_game_state', {
            round: currentRound,
            players: publicPlayers,
            history: sessionHistory,
            roundNumber: globalRoundCounter,
            gameId: currentGameId
        });

        io.to('gamemaster_room').emit('gm_update_full', {
            round: currentRound,
            players: players,
            history: sessionHistory,
            roundNumber: globalRoundCounter,
            gameId: currentGameId
        });
    };

    socket.on('gm_login', (pw) => {
        if (pw === GM_PASSWORD) {
            socket.join('gamemaster_room');
            socket.emit('gm_login_success');
            broadcastStatus();
        } else {
            socket.emit('gm_login_fail');
        }
    });

    socket.on('gm_reset_all', async () => {
        saveGame();
        await startNewGameInternal();
        broadcastStatus();
    });

    // --- GAME CONTROL ---
    socket.on('gm_close_answering', () => {
        currentRound.answeringOpen = false;
        saveGame();
        broadcastStatus();
    });

    socket.on('gm_reveal', () => {
        currentRound.revealed = true;
        currentRound.answeringOpen = false;
        saveGame();
        broadcastStatus();
    });

    socket.on('gm_start_round', async (data) => {
        if (currentRound.type !== 'WAITING') {
            const roundAnswers = {};
            for(const [name, p] of Object.entries(players)) {
                if (p.hasAnswered && p.answer) {
                    roundAnswers[name] = p.answer;
                }
            }
            sessionHistory.push({
                question: currentRound.question,
                type: currentRound.type,
                answers: roundAnswers
            });
        }

        if (data.isNewGameRound) {
            const livesSnapshot = {};
            for (const [name, p] of Object.entries(players)) livesSnapshot[name] = p.lives;

            getArchiveCol().add({
                roundId: globalRoundCounter,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                playerLives: livesSnapshot,
                questions: sessionHistory
            }).catch(e => console.error("Archiv Fehler:", e));

            sessionHistory = []; 
            globalRoundCounter++;
        } 

        currentRound = {
            type: data.type,
            question: data.question,
            options: data.options || [], 
            pairs: data.pairs || [],
            targetPlayers: data.targetPlayers || [], 
            min: data.min !== undefined ? Number(data.min) : 0,
            max: data.max !== undefined ? Number(data.max) : 100,
            revealed: false,
            answeringOpen: true 
        };
        
        for (let p in players) {
            players[p].hasAnswered = false;
            players[p].answer = null;
        }
        
        saveGame();
        broadcastStatus();
    });

    socket.on('gm_modify_lives', (data) => {
        if (players[data.user]) {
            players[data.user].lives += data.amount;
            saveGame();
            broadcastStatus();
        }
    });

    // --- PLAYER MANAGEMENT ---
    
    // 1. Manuell erstellt vom GM
    socket.on('gm_create_player', (name) => {
        if (!name) return;
        const code = Math.floor(1000 + Math.random() * 9000).toString();
        
        if (!players[name]) {
            players[name] = { 
                code: code,
                lives: 3, hasAnswered: false, answer: null, connected: false
            };
            saveGame();
            socket.emit('gm_player_joined', { name, code, isManual: true });
            broadcastStatus();
        }
    });

    // 2. Automatisch durch URL Aufruf (WICHTIG: Hier fehlte die Benachrichtigung)
    socket.on('player_announce', (name) => {
        let isNew = false;
        
        if (!players[name]) {
            // Spieler existiert noch nicht -> Neu anlegen
            players[name] = { 
                code: Math.floor(1000 + Math.random() * 9000).toString(),
                lives: 3, hasAnswered: false, answer: null, connected: true
            };
            saveGame();
            isNew = true;
        } else {
            players[name].connected = true;
        }
        
        // Benachrichtigung an GM senden, wenn es ein neuer Spieler ist
        if (isNew) {
            io.to('gamemaster_room').emit('gm_player_joined', { name, code: players[name].code, isManual: false });
        }
        
        broadcastStatus();
    });

    socket.on('player_login', (data) => {
        const { name, code } = data;
        if (players[name] && String(players[name].code) === String(code)) {
            players[name].connected = true;
            socket.emit('player_login_success');
            if (players[name].hasAnswered) socket.emit('answer_confirmed');
            broadcastStatus();
        } else {
            socket.emit('player_login_fail');
        }
    });

    socket.on('submit_answer', (data) => {
        const p = players[data.user];
        if (!p) return;

        if (currentRound.targetPlayers && currentRound.targetPlayers.length > 0) {
            if (!currentRound.targetPlayers.includes(data.user)) return;
        }

        if (currentRound.answeringOpen) {
            p.answer = data.answer;
            p.hasAnswered = true;
            saveGame();
            socket.emit('answer_confirmed');
            broadcastStatus();
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server läuft auf Port ${PORT}`);
});
