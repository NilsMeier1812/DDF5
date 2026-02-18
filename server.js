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
const io = new Server(server, { 
    cors: { origin: "*" },
    maxHttpBufferSize: 1e7 
});

const GM_PASSWORD = "admin"; 

// --- GAME STATE ---
let currentGameId = "init"; 
let players = {}; 
const DEFAULT_ROUND = { 
    type: 'WAITING', question: '', 
    options: [], pairs: [], shuffledRight: [], targetPlayers: [], 
    min: 0, max: 100, 
    answerCount: 1, 
    revealed: false, answeringOpen: false, 
    isInputBlocked: false, 
    correctAnswer: null,
    audioData: null, 
    imageData: null,
    imageRevealed: false, 
    textRevealed: true, 
    videoData: null,
    powerVoter: [],
    revealedAnswers: [], // Liste der Namen, die einzeln aufgedeckt wurden
    startTime: null, 
    endTime: null    
};
let currentRound = { ...DEFAULT_ROUND };
let sessionHistory = [];
let globalRoundCounter = 1;

// --- HELPERS ---
function shuffleArray(array) {
    const arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

// --- DB HELPER ---
const getGameDoc = () => db.collection('games').doc(currentGameId);
const getArchiveCol = () => db.collection('games').doc(currentGameId).collection('archived_rounds');

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
    } catch (e) {
        console.error("Fehler beim Server-Start:", e);
        await startNewGameInternal();
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
                audioData: null, 
                imageData: null,
                videoData: loadedRound.videoData || null,
                powerVoter: loadedRound.powerVoter || [],
                imageRevealed: loadedRound.imageRevealed || false,
                textRevealed: loadedRound.textRevealed !== undefined ? loadedRound.textRevealed : true,
                isInputBlocked: loadedRound.isInputBlocked || false,
                revealedAnswers: loadedRound.revealedAnswers || []
            };
            
            sessionHistory = data.sessionHistory || [];
            globalRoundCounter = data.globalRoundCounter || 1;
            
            for (let p in players) players[p].connected = false;
            console.log(`📥 Daten geladen. ${Object.keys(players).length} Spieler.`);
        } else {
            saveGame();
        }
    } catch (e) {
        console.error("Fehler beim Laden:", e);
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

// --- ROUTING ---
app.use(express.static('public'));
app.get('/', (req, res) => res.send(`Server Online. Game: ${currentGameId}`));
app.get('/gm', (req, res) => res.sendFile(path.join(__dirname, 'public', 'gamemaster.html')));
app.get('/p/:name', (req, res) => res.sendFile(path.join(__dirname, 'public', 'player.html')));
app.get('/stats', (req, res) => res.sendFile(path.join(__dirname, 'public', 'analysis.html')));


io.on('connection', (socket) => {
    
    // --- GAME LOGIK ---
    const broadcastState = () => {
        try {
            const publicPlayers = {};
            for (const [name, data] of Object.entries(players)) {
                if (!data.isVerified) continue;
                
                let answerVisible = null;
                const isGloballyRevealed = currentRound.revealed;
                // Prüfen, ob dieser spezifische Spieler aufgedeckt wurde
                const isIndividuallyRevealed = currentRound.revealedAnswers && currentRound.revealedAnswers.includes(name);

                if (isGloballyRevealed || isIndividuallyRevealed) {
                    answerVisible = data.answer;
                }

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
        } catch (e) {
            console.error("Fehler beim Broadcast:", e);
        }
    };

    // --- ANALYSE / STATS LOGIK ---
    socket.on('request_gamelist', async () => {
        try {
            const snapshot = await db.collection('games').orderBy('lastUpdated', 'desc').limit(20).get();
            const games = [];
            snapshot.forEach(doc => {
                const d = doc.data();
                let dateVal = new Date();
                if (d.lastUpdated && typeof d.lastUpdated.toDate === 'function') {
                    dateVal = d.lastUpdated.toDate();
                }

                games.push({
                    id: doc.id,
                    date: dateVal,
                    playersCount: d.players ? Object.keys(d.players).length : 0
                });
            });
            socket.emit('receive_gamelist', games);
        } catch (e) {
            console.error("Fehler bei Gamelist:", e);
            socket.emit('receive_gamelist', []); 
        }
    });

    socket.on('request_game_details', async (gameId) => {
        try {
            const docRef = db.collection('games').doc(gameId);
            const doc = await docRef.get();
            if (!doc.exists) { socket.emit('error_details', "Spiel nicht gefunden."); return; }

            const gameData = doc.data();
            if(gameData.lastUpdated && typeof gameData.lastUpdated.toDate === 'function') {
                gameData.lastUpdated = gameData.lastUpdated.toDate(); 
            }

            const roundsSnap = await docRef.collection('archived_rounds').orderBy('roundId', 'asc').get();
            const rounds = [];
            roundsSnap.forEach(r => rounds.push(r.data()));

            socket.emit('receive_game_details', { meta: gameData, rounds: rounds });
        } catch (e) {
            console.error("Fehler bei Game Details:", e);
            socket.emit('error_details', "Fehler beim Laden der Daten.");
        }
    });

    // --- GM COMMANDS ---
    socket.on('gm_login', (pw) => {
        if (pw && pw.trim() === GM_PASSWORD) {
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

    socket.on('gm_audio_sync', (data) => {
        io.emit('audio_sync_command', data);
    });
    
    socket.on('gm_toggle_image', (shouldShow) => {
        currentRound.imageRevealed = !!shouldShow;
        saveGame();
        broadcastState();
    });

    socket.on('gm_toggle_text', (shouldShow) => {
        currentRound.textRevealed = !!shouldShow;
        saveGame();
        broadcastState();
    });

    socket.on('gm_toggle_input_block', (isBlocked) => {
        currentRound.isInputBlocked = isBlocked;
        saveGame();
        broadcastState();
    });

    // --- EINZELNES AUFDECKEN ---
    socket.on('gm_reveal_single', (playerName) => {
        // Sicherstellen, dass Array existiert
        if (!currentRound.revealedAnswers) currentRound.revealedAnswers = [];
        
        // Nur hinzufügen, wenn noch nicht drin
        if (!currentRound.revealedAnswers.includes(playerName)) {
            currentRound.revealedAnswers.push(playerName); // Name ans Ende (neuestes Element)
            saveGame();
            broadcastState();
        }
    });

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

        let roundOptions = data.options || [];
        let correctAnswer = data.correctAnswer;
        let shuffledRight = [];

        if (data.type === 'MC') {
            roundOptions = shuffleArray(data.options);
        }
        else if (data.type === 'SEQUENCE') {
            correctAnswer = [...data.options]; 
            roundOptions = shuffleArray(data.options);
        }
        else if (data.type === 'MATCHING') {
            const rightSide = data.pairs.map(p => p.right);
            shuffledRight = shuffleArray(rightSide);
        }

        let shouldOpen = true;
        if (data.type === 'INFO' || data.type === 'VIDEO_STREAM' || data.type === 'OFFLINE_RESULTS') {
            shouldOpen = false;
        }

        currentRound = {
            type: data.type,
            question: data.question,
            options: roundOptions, 
            pairs: data.pairs || [], 
            shuffledRight: shuffledRight, 
            targetPlayers: data.targetPlayers || [], 
            min: data.min !== undefined ? Number(data.min) : 0,
            max: data.max !== undefined ? Number(data.max) : 100,
            answerCount: data.answerCount !== undefined ? Number(data.answerCount) : 1,
            correctAnswer: correctAnswer, 
            audioData: data.audioData || null, 
            imageData: data.imageData || null,
            imageRevealed: false, 
            textRevealed: true, 
            videoData: data.videoData || null,
            powerVoter: data.powerVoter || [],
            revealedAnswers: [], // Reset für neue Runde
            revealed: false,
            answeringOpen: shouldOpen,
            isInputBlocked: false, 
            startTime: Date.now(), 
            endTime: null
        };
        
        for (let p in players) {
            players[p].hasAnswered = false;
            players[p].answer = null;
        }
        
        saveGame(); 
        broadcastState(); 
    });

    function archiveCurrentQuestion() {
        if (currentRound.type !== 'WAITING' && currentRound.type !== 'INFO') { 
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

    socket.on('gm_close_answering', () => { 
        currentRound.answeringOpen = false;
        currentRound.endTime = Date.now(); 
        saveGame(); 
        broadcastState(); 
    });

    socket.on('gm_open_answering', () => { 
        currentRound.answeringOpen = true; 
        currentRound.revealed = false; 
        currentRound.endTime = null;
        saveGame(); 
        broadcastState(); 
    });
    
    socket.on('gm_reveal', () => { 
        currentRound.revealed = true; 
        currentRound.answeringOpen = false;
        if(!currentRound.endTime) currentRound.endTime = Date.now();
        saveGame(); 
        broadcastState(); 
    });
    
    socket.on('gm_modify_lives', (data) => { 
        if (players[data.user]) { 
            let newLives = players[data.user].lives + data.amount;
            if (newLives > 5) newLives = 5;
            if (newLives < 0) newLives = 0;
            players[data.user].lives = newLives; 
            saveGame(); 
            broadcastState(); 
        }
    });

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
        if (p.lives <= 0) return;
        if (currentRound.targetPlayers?.length > 0 && !currentRound.targetPlayers.includes(data.user)) return;
        
        if (currentRound.answeringOpen && !currentRound.isInputBlocked) {
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
