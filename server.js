const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const GM_PASSWORD = "admin"; 

// --- STATUS SPEICHER ---
// players: { "Max": { code: "1234", lives: 3, hasAnswered: false, answer: null, connected: false } }
let players = {}; 

// Game State
let currentRound = {
    type: 'WAITING', // 'WAITING', 'MC', 'TEXT', 'PLAYER_VOTE'
    question: '',
    options: [] // Nur für MC relevant
};

// --- ROUTING ---
app.use(express.static('public'));

app.get('/', (req, res) => res.send('Server Online.'));
app.get('/gm', (req, res) => res.sendFile(path.join(__dirname, 'public', 'gamemaster.html')));
app.get('/p/:name', (req, res) => res.sendFile(path.join(__dirname, 'public', 'player.html')));

// --- ECHTZEIT LOGIK ---
io.on('connection', (socket) => {
    
    // --- HELPER: Status an alle senden ---
    const broadcastStatus = () => {
        // Sensible Daten filtern (Codes nicht an alle senden)
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
            players: publicPlayers
        });

        // GM bekommt alles (inkl. Antworten & Codes)
        io.to('gamemaster_room').emit('gm_update_full', {
            round: currentRound,
            players: players
        });
    };

    // --- GAMEMASTER ---
    socket.on('gm_login', (password) => {
        if (password === GM_PASSWORD) {
            socket.join('gamemaster_room');
            socket.emit('gm_login_success');
            broadcastStatus();
        } else {
            socket.emit('gm_login_fail');
        }
    });

    socket.on('gm_start_round', (data) => {
        // data: { type: 'TEXT'|'MC'|'PLAYER_VOTE', question: '...', options: [] }
        currentRound = {
            type: data.type,
            question: data.question,
            options: data.options || []
        };
        
        // Antworten zurücksetzen
        for (let p in players) {
            players[p].hasAnswered = false;
            players[p].answer = null;
        }
        
        broadcastStatus();
    });

    socket.on('gm_modify_lives', (data) => {
        // data: { user: "Max", amount: -1 }
        if (players[data.user]) {
            players[data.user].lives += data.amount;
            broadcastStatus();
        }
    });

    socket.on('gm_reveal', () => {
        // Optional: Antworten an alle aufdecken (hier vereinfacht nur im GM View sichtbar)
    });

    // --- SPIELER JOIN ---
    socket.on('player_announce', (name) => {
        if (!players[name]) {
            players[name] = { 
                code: Math.floor(1000 + Math.random() * 9000).toString(),
                lives: 3,
                hasAnswered: false,
                answer: null,
                connected: true
            };
        } else {
            players[name].connected = true;
        }
        broadcastStatus(); // GM sieht neuen Spieler sofort
    });

    socket.on('player_login', (data) => {
        const { name, code } = data;
        if (players[name] && players[name].code === code) {
            players[name].connected = true;
            socket.emit('player_login_success');
            broadcastStatus();
        } else {
            socket.emit('player_login_fail');
        }
    });

    // --- VOTING / ANTWORTEN ---
    socket.on('submit_answer', (data) => {
        // data: { user: "Max", answer: "Paris" }
        const p = players[data.user];
        if (p && !p.hasAnswered) {
            p.answer = data.answer;
            p.hasAnswered = true;
            
            socket.emit('answer_confirmed');
            broadcastStatus(); // Damit das "Häkchen" bei allen erscheint
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server läuft auf Port ${PORT}`);
});
