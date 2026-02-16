const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const admin = require('firebase-admin');

// --- FIREBASE SETUP ---
// Wir versuchen, die Credentials aus der Environment Variable zu lesen (für Render)
// Falls das lokal nicht existiert, stürzt der Server ab -> Anleitung unten beachten!
let serviceAccount;
try {
    if (process.env.FIREBASE_CREDENTIALS) {
        serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
    } else {
        // Fallback für lokale Entwicklung (optional, falls du eine Datei hast)
        serviceAccount = require('./service-account-key.json');
    }

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log("🔥 Firebase erfolgreich initialisiert!");
} catch (error) {
    console.error("❌ FEHLER: Firebase konnte nicht gestartet werden.");
    console.error("Hast du die Environment Variable FIREBASE_CREDENTIALS gesetzt?");
    console.error(error.message);
}

const db = admin.firestore();
const GAME_DOC_REF = db.collection('gamestate').doc('current_session');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const GM_PASSWORD = "admin"; 

// --- STATUS SPEICHER (In-Memory Cache) ---
// Wir halten die Daten im RAM für Geschwindigkeit, synchronisieren aber alles zur DB
let players = {}; 
let currentRound = { type: 'WAITING', question: '', options: [] };
let sessionHistory = [];

// --- DATENBANK FUNKTIONEN ---

async function loadGame() {
    try {
        const doc = await GAME_DOC_REF.get();
        if (doc.exists) {
            const data = doc.data();
            players = data.players || {};
            currentRound = data.currentRound || { type: 'WAITING', question: '' };
            sessionHistory = data.sessionHistory || [];
            
            // Connected Status resetten beim Neustart
            for (let p in players) {
                players[p].connected = false;
            }
            console.log("📥 Spielstand aus Firebase geladen!");
        } else {
            console.log("🆕 Kein Spielstand gefunden, starte neu.");
            saveGame(); // Leeres Dokument anlegen
        }
    } catch (e) {
        console.error("Fehler beim Laden von Firebase:", e);
    }
}

// Speichern (Fire & Forget - wir warten nicht auf das Ergebnis, um Lag zu vermeiden)
function saveGame() {
    const data = {
        players: players,
        currentRound: currentRound,
        sessionHistory: sessionHistory,
        lastUpdated: admin.firestore.FieldValue.serverTimestamp()
    };
    
    GAME_DOC_REF.set(data).catch(err => {
        console.error("Fehler beim Speichern in Firebase:", err);
    });
}

// Initial laden
loadGame();

// --- ROUTING ---
app.use(express.static('public'));
app.get('/', (req, res) => res.send('Server Online with Firebase.'));
app.get('/gm', (req, res) => res.sendFile(path.join(__dirname, 'public', 'gamemaster.html')));
app.get('/p/:name', (req, res) => res.sendFile(path.join(__dirname, 'public', 'player.html')));

io.on('connection', (socket) => {
    
    const broadcastStatus = () => {
        const publicPlayers = {};
        for (const [name, data] of Object.entries(players)) {
            publicPlayers[name] = { 
                lives: data.lives, 
                hasAnswered: data.hasAnswered,
                connected: data.connected
            };
        }
        
        io.emit('update_game_state', {
            round: currentRound,
            players: publicPlayers,
            history: sessionHistory 
        });

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

    socket.on('gm_start_round', (data) => {
        if (data.isNewGameRound) {
            sessionHistory = [];
        } else if (currentRound.type !== 'WAITING' && currentRound.type !== 'PLAYER_VOTE') {
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

        currentRound = {
            type: data.type,
            question: data.question,
            options: []
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
        if (p && !p.hasAnswered) {
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
