const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const admin = require('firebase-admin');

// --- FIREBASE INIT ---
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
const io = new Server(server, { cors: { origin: "*" }, maxHttpBufferSize: 1e7 });

const GM_PASSWORD = "admin"; 

// --- GAME STATE ---
let isServerReady = false; // Neu: Verhindert Race Conditions beim Start
let currentGameId = "init"; 
let players = {}; 

const DEFAULT_ROUND = { 
    type: 'WAITING', question: '', 
    options: [], pairs: [], shuffledRight: [], targetPlayers: [], 
    min: 0, max: 100, 
    revealed: false, answeringOpen: false, 
    correctAnswer: null,
    audioData: null, 
    imageData: null,
    powerVoter: []
};

let currentRound = { ...DEFAULT_ROUND };
let sessionHistory = [];
let globalRoundCounter = 1;

// --- HELPERS ---
function shuffleArray(array) {
    if(!array) return [];
    const arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

const getGameDoc = () => db.collection('games').doc(currentGameId);
const getArchiveCol = () => db.collection('games').doc(currentGameId).collection('archived_rounds');

// --- STARTUP ---
async function initServer() {
    try {
        const meta = await META_DOC_REF.get();
        if (meta.exists && meta.data().activeGameId) {
            currentGameId = meta.data().activeGameId;
            console.log(`🔄 Lade Spiel-ID: ${currentGameId}`);
            await loadGameData();
        } else {
            await startNewGameInternal();
        }
        isServerReady = true;
        console.log("🚀 Server ist bereit für Verbindungen.");
    } catch (e) {
        console.error("Critical Init Error:", e);
        await startNewGameInternal();
        isServerReady = true;
    }
}

async function startNewGameInternal() {
    currentGameId = `game_${Date.now()}`;
    players = {};
    currentRound = { ...DEFAULT_ROUND };
    sessionHistory = [];
    globalRoundCounter = 1;
    console.log(`✨ Neues Spiel erstellt: ${currentGameId}`);
    await META_DOC_REF.set({ activeGameId: currentGameId });
    saveGame();
}

async function loadGameData() {
    try {
        const doc = await getGameDoc().get();
        if (doc.exists) {
            const data = doc.data();
            players = data.players || {};
            const loadedRound = data.currentRound || {};
            currentRound = { 
                ...DEFAULT_ROUND, 
                ...loadedRound, 
                audioData: null, imageData: null,
                powerVoter: loadedRound.powerVoter || []
            };
            sessionHistory = data.sessionHistory || [];
            globalRoundCounter = data.globalRoundCounter || 1;
            
            // Reset connections
            for (let p in players) players[p].connected = false;
        } else {
            saveGame();
        }
    } catch (e) {
        console.error("Lade Fehler:", e);
    }
}

function saveGame() {
    const roundToSave = { ...currentRound };
    delete roundToSave.audioData; 
    delete roundToSave.imageData; 

    getGameDoc().set({
        gameId: currentGameId,
        players, 
        currentRound: roundToSave,
        sessionHistory, 
        globalRoundCounter,
        lastUpdated: admin.firestore.FieldValue.serverTimestamp()
    }).catch(e => console.error("Save Error:", e));
}

initServer();

app.use(express.static('public'));
app.get('/', (req, res) => res.send(`Server Online. Game: ${currentGameId}`));
app.get('/gm', (req, res) => res.sendFile(path.join(__dirname, 'public', 'gamemaster.html')));
app.get('/p/:name', (req, res) => res.sendFile(path.join(__dirname, 'public', 'player.html')));
app.get('/stats', (req, res) => res.sendFile(path.join(__dirname, 'public', 'analysis.html')));


io.on('connection', (socket) => {
    
    // Helper zum Senden des Status
    const broadcastState = () => {
        if(!isServerReady) return; 

        try {
            const publicPlayers = {};
            for (const [name, data] of Object.entries(players)) {
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
                gameId: currentGameId,
                round: currentRound, 
                players: publicPlayers,
                history: sessionHistory,
                roundNumber: globalRoundCounter
            });

            // GM bekommt ALLE (auch pending)
            io.to('gamemaster_room').emit('gm_update_full', {
                gameId: currentGameId,
                round: currentRound,
                players: players, 
                history: sessionHistory,
                roundNumber: globalRoundCounter
            });
        } catch (e) { console.error("Broadcast Error", e); }
    };

    // --- GM COMMANDS ---
    socket.on('gm_login', (pw) => {
        if(!isServerReady) return;
        console.log(`🔑 GM Login Versuch: ${pw}`);
        if (pw && pw.trim() === GM_PASSWORD) {
            socket.join('gamemaster_room');
            socket.emit('gm_login_success');
            console.log("✅ GM Room Joined via Login");
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

    socket.on('gm_audio_sync', (data) => io.emit('audio_sync_command', data));

    socket.on('gm_set_bulk_answers', (answersMap) => {
        for (const [name, val] of Object.entries(answersMap)) {
            if (players[name]) {
                players[name].answer = val;
                players[name].hasAnswered = true;
            }
        }
        saveGame();
        broadcastState();
    });

    socket.on('gm_next_round_phase', () => {
        archiveCurrentQuestion();
        const livesSnapshot = {};
        for (const [name, p] of Object.entries(players)) livesSnapshot[name] = p.lives;
        getArchiveCol().add({
            roundId: globalRoundCounter,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            playerLives: livesSnapshot,
            questions: sessionHistory
        });
        sessionHistory = [];
        globalRoundCounter++;
        currentRound = { ...DEFAULT_ROUND, question: 'Runde beendet.' };
        for (let p in players) {
            players[p].hasAnswered = false;
            players[p].answer = null;
        }
        saveGame();
        broadcastState();
    });

    socket.on('gm_start_round', (data) => {
        archiveCurrentQuestion();

        if (data.isNewGameRound) {
             const livesSnapshot = {};
            for (const [name, p] of Object.entries(players)) livesSnapshot[name] = p.lives;
            getArchiveCol().add({
                roundId: globalRoundCounter,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                playerLives: livesSnapshot,
                questions: sessionHistory
            });
            sessionHistory = []; 
            globalRoundCounter++;
        }

        let roundOptions = data.options || [];
        let correctAnswer = data.correctAnswer;
        let shuffledRight = [];

        if (data.type === 'MC') roundOptions = shuffleArray(data.options);
        else if (data.type === 'SEQUENCE') { correctAnswer = [...data.options]; roundOptions = shuffleArray(data.options); }
        else if (data.type === 'MATCHING') { const rightSide = data.pairs.map(p => p.right); shuffledRight = shuffleArray(rightSide); }

        currentRound = {
            type: data.type,
            question: data.question,
            options: roundOptions, 
            pairs: data.pairs || [], 
            shuffledRight: shuffledRight, 
            targetPlayers: data.targetPlayers || [], 
            min: data.min !== undefined ? Number(data.min) : 0,
            max: data.max !== undefined ? Number(data.max) : 100,
            correctAnswer: correctAnswer, 
            audioData: data.audioData || null, 
            imageData: data.imageData || null,
            powerVoter: data.powerVoter || [],
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
    socket.on('gm_modify_lives', (data) => { if (players[data.user]) { players[data.user].lives += data.amount; saveGame(); broadcastState(); } });
    
    socket.on('gm_create_player', (name) => {
        if (!name) return;
        const code = Math.floor(1000 + Math.random() * 9000).toString();
        players[name] = { code, lives: 3, hasAnswered: false, answer: null, connected: false, isVerified: false };
        saveGame();
        io.to('gamemaster_room').emit('gm_player_joined', { name, code, isManual: true });
        broadcastState();
        console.log("📝 GM Manuell erstellt:", name, code);
    });

    // --- PLAYER JOIN LOGIK ---
    socket.on('player_announce', (name) => {
        if(!isServerReady) return; // Warten bis Server bereit

        console.log(`👋 Player Announce: ${name}`);
        let isNew = false;
        
        if (!players[name]) {
            const code = Math.floor(1000 + Math.random() * 9000).toString();
            players[name] = { code, lives: 3, hasAnswered: false, answer: null, connected: true, isVerified: false };
            isNew = true;
            saveGame();
            console.log(`🆕 Neuer Spieler angelegt: ${name}`);
        } else {
            players[name].connected = true;
            if(players[name].isVerified) {
                 socket.emit('player_login_success');
            }
        }
        
        // PING AN GM SENDEN (Egal ob neu oder reconnect pending)
        if (isNew || !players[name].isVerified) {
            console.log(`🔔 Sende Ping an GM für ${name} (Code: ${players[name].code})`);
            io.to('gamemaster_room').emit('gm_player_joined', { name, code: players[name].code, isManual: false });
        }
        
        broadcastState();
    });

    socket.on('player_login', (data) => {
        if(!isServerReady) return;

        const { name, code } = data;
        const p = players[name];
        
        console.log(`🔑 Login Versuch: ${name} mit ${code}`);
        
        if (p && String(p.code).trim() === String(code).trim()) {
            p.isVerified = true;
            p.connected = true;
            socket.emit('player_login_success');
            if (p.hasAnswered) socket.emit('answer_confirmed');
            saveGame();
            broadcastState();
            console.log(`✅ ${name} Login erfolgreich.`);
        } else {
            console.log(`⛔ ${name} Login fehlgeschlagen.`);
            socket.emit('player_login_fail', 'Falscher Code');
        }
    });

    socket.on('submit_answer', (data) => {
        const p = players[data.user];
        if (!p || !p.isVerified || p.lives <= 0) return;
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
