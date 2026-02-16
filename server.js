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
const GAME_DOC_REF = db.collection('gamestate').doc('current_session');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const GM_PASSWORD = "admin"; 

// --- STATUS ---
let players = {}; 
// Neu: 'revealed' Flag
let currentRound = { type: 'WAITING', question: '', options: [], revealed: false };
let sessionHistory = [];

// --- DATABASE ---
async function loadGame() {
    try {
        const doc = await GAME_DOC_REF.get();
        if (doc.exists) {
            const data = doc.data();
            players = data.players || {};
            currentRound = data.currentRound || { type: 'WAITING', question: '', revealed: false };
            sessionHistory = data.sessionHistory || [];
            for (let p in players) players[p].connected = false;
        } else {
            saveGame();
        }
    } catch (e) { console.error("Load Error:", e); }
}

function saveGame() {
    GAME_DOC_REF.set({
        players, currentRound, sessionHistory,
        lastUpdated: admin.firestore.FieldValue.serverTimestamp()
    }).catch(e => console.error("Save Error:", e));
}
loadGame();

app.use(express.static('public'));
app.get('/', (req, res) => res.send('Server Online (Firebase Mode).'));
app.get('/gm', (req, res) => res.sendFile(path.join(__dirname, 'public', 'gamemaster.html')));
app.get('/p/:name', (req, res) => res.sendFile(path.join(__dirname, 'public', 'player.html')));

io.on('connection', (socket) => {
    
    // --- STATUS AN ALLE SENDEN ---
    const broadcastStatus = () => {
        const publicPlayers = {};
        for (const [name, data] of Object.entries(players)) {
            // WICHTIG: Antwort nur mitschicken, wenn aufgedeckt wurde!
            // (Oder wenn es der Spieler selbst ist, das handhaben wir aber clientseitig meistens)
            const answerVisible = currentRound.revealed ? data.answer : null;

            publicPlayers[name] = { 
                lives: data.lives, 
                hasAnswered: data.hasAnswered,
                connected: data.connected,
                answer: answerVisible // Hier ist das Geheimnis
            };
        }
        
        io.emit('update_game_state', {
            round: currentRound,
            players: publicPlayers,
            history: sessionHistory 
        });

        // GM sieht IMMER alles
        io.to('gamemaster_room').emit('gm_update_full', {
            round: currentRound,
            players: players,
            history: sessionHistory
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

    // --- AUFDECKEN ---
    socket.on('gm_reveal', () => {
        currentRound.revealed = true;
        saveGame();
        broadcastStatus();
    });

    // --- STARTEN ---
    socket.on('gm_start_round', (data) => {
        // 1. NEUE SPIELRUNDE (Alles resetten)
        if (data.isNewGameRound) {
            // Vorher speichern wir den finalen Stand der letzten Runde nochmal explizit
            saveGame(); 
            sessionHistory = []; // RAM leeren für neue Runde
        } 
        // 2. NÄCHSTE FRAGE (Alte archivieren)
        else if (currentRound.type !== 'WAITING') {
            const roundAnswers = {};
            for(const [name, p] of Object.entries(players)) {
                if (p.hasAnswered && p.answer) {
                    roundAnswers[name] = p.answer;
                }
            }
            sessionHistory.push({
                question: currentRound.question,
                answers: roundAnswers
            });
        }

        // Neue Runde init
        currentRound = {
            type: data.type,
            question: data.question,
            options: [],
            revealed: false // Reset Reveal
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

    socket.on('player_announce', (name) => {
        if (!players[name]) {
            players[name] = { 
                code: Math.floor(1000 + Math.random() * 9000).toString(),
                lives: 3, hasAnswered: false, answer: null, connected: true
            };
            saveGame();
        } else {
            players[name].connected = true;
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
        // Antworten nur erlaubt, wenn noch NICHT aufgedeckt wurde
        if (p && !p.hasAnswered && !currentRound.revealed) {
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
