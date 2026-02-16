const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- KONFIGURATION ---
const GM_PASSWORD = "admin"; // Das feste Passwort für den Gamemaster

// --- STATUS SPEICHER (RAM) ---
let currentVotes = {}; 
let votingOpen = false;

// Format: { "Max": "1234", "Anna": "9876" }
let playerAuth = {}; 

// --- ROUTING ---
app.use(express.static('public'));

app.get('/', (req, res) => {
    res.send('Voting Server ist online. Geh zu /gm für Gamemaster oder /p/DeinName für Spieler.');
});

app.get('/gm', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'gamemaster.html'));
});

app.get('/p/:name', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'player.html'));
});


// --- ECHTZEIT LOGIK ---

io.on('connection', (socket) => {
    console.log('Client verbunden:', socket.id);

    // --- GAMEMASTER AUTHENTIFIZIERUNG ---
    socket.on('gm_login', (password) => {
        if (password === GM_PASSWORD) {
            socket.emit('gm_login_success', {
                votes: currentVotes,
                votingOpen: votingOpen,
                players: playerAuth
            });
            // Socket einem Raum beitreten, falls wir später GM-spezifische Nachrichten haben
            socket.join('gamemaster_room');
        } else {
            socket.emit('gm_login_fail');
        }
    });

    // --- NEUEN SPIELER ERSTELLEN (Nur vom GM) ---
    socket.on('gm_create_player', (playerName) => {
        // Einfachen 4-stelligen Code generieren
        const code = Math.floor(1000 + Math.random() * 9000).toString();
        
        // Speichern
        playerAuth[playerName] = code;
        
        // GM Bescheid geben
        socket.emit('player_created', { name: playerName, code: code });
    });

    // --- SPIELER AUTHENTIFIZIERUNG ---
    socket.on('player_login', (data) => {
        const { name, code } = data;
        
        // Prüfen ob Name existiert und Code stimmt
        if (playerAuth[name] && playerAuth[name] === code) {
            socket.emit('player_login_success');
            // Aktuellen Status an den Spieler senden
            socket.emit('voting_status', votingOpen);
            // Falls er schon gevotet hatte
            if (currentVotes[name]) {
                socket.emit('vote_confirmed', currentVotes[name]);
            }
        } else {
            socket.emit('player_login_fail');
        }
    });

    // --- VOTING LOGIK ---
    socket.on('vote', (data) => {
        if (!votingOpen) return;

        // Optional: Hier könnte man nochmal serverseitig den Code prüfen, 
        // aber für dieses Level reicht der Client-Login Check.
        
        currentVotes[data.user] = data.choice;
        console.log(`Vote: ${data.user} -> ${data.choice}`);

        // Update an Gamemaster senden (an alle im GM Raum oder einfach Broadcast)
        io.emit('update_votes', currentVotes);
        socket.emit('vote_confirmed', data.choice);
    });

    // --- STEUERUNG ---
    socket.on('gm_control', (action) => {
        if (action === 'reset') {
            currentVotes = {};
            votingOpen = true;
            io.emit('update_votes', currentVotes);
            io.emit('voting_status', true);
        } else if (action === 'stop') {
            votingOpen = false;
            io.emit('voting_status', false);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server läuft auf Port ${PORT}`);
});
