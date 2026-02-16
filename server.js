const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- STATUS SPEICHER (RAM) ---
// Hier werden die Votes gespeichert, solange der Server läuft.
// Neustart = Alles weg (gut für Testzwecke)
let currentVotes = {}; 
let votingOpen = false;

// --- ROUTING ---

// 1. Statische Dateien (falls wir später CSS/Bilder haben)
app.use(express.static('public'));

// 2. Keep-Alive Endpunkt (für den Ping vom Gamemaster)
app.get('/', (req, res) => {
    res.send('Voting Server ist online. Geh zu /gm für Gamemaster oder /p/DeinName für Spieler.');
});

// 3. Gamemaster Ansicht
app.get('/gm', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'gamemaster.html'));
});

// 4. Spieler Ansicht (Dynamische URL)
app.get('/p/:name', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'player.html'));
});


// --- ECHTZEIT LOGIK (Socket.io) ---

io.on('connection', (socket) => {
    console.log('Neuer Client verbunden:', socket.id);

    // Initialen Status senden, damit keiner auf "Loading..." starrt
    socket.emit('update_votes', currentVotes);
    socket.emit('voting_status', votingOpen);

    // EVENT: Spieler stimmt ab
    socket.on('vote', (data) => {
        if (!votingOpen) return; // Cheater-Schutz (falls jemand via Console votet)

        // Speichern: "Max wählt A"
        currentVotes[data.user] = data.choice;
        
        console.log(`Vote: ${data.user} -> ${data.choice}`);

        // Update an ALLE senden (damit Gamemaster es sofort sieht)
        io.emit('update_votes', currentVotes);
        
        // Bestätigung nur an den Spieler zurück
        socket.emit('vote_confirmed', data.choice);
    });

    // EVENT: Gamemaster steuert das Spiel
    socket.on('gm_control', (action) => {
        if (action === 'reset') {
            console.log('GM: Reset Voting');
            currentVotes = {};      // Alles löschen
            votingOpen = true;      // Tore öffnen
            io.emit('update_votes', currentVotes);
            io.emit('voting_status', true);
        } else if (action === 'stop') {
            console.log('GM: Stop Voting');
            votingOpen = false;     // Tore schließen
            io.emit('voting_status', false);
        }
    });
});

// Server starten
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server läuft auf Port ${PORT}`);
});
