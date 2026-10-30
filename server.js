const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;

// Centralny stan gry dla wszystkich
let gameState = {
  players: [],
  communityCards: [],
  pot: 0,
  currentTurn: 0,
  smallBlind: 10,
  bigBlind: 20,
  gameInProgress: false
};

const createDeck = () => {
  const suits = ['♠', '♥', '♣', '♦'];
  const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  let deck = [];
  for (let s of suits) {
    for (let v of values) {
      deck.push(`${v}${s}`);
    }
  }
  return deck.sort(() => Math.random() - 0.5);
};

let deck = [];

const startNewRound = () => {
  if (gameState.players.length < 2) return;
  
  deck = createDeck();
  gameState.communityCards = [deck.pop(), deck.pop(), deck.pop()]; // Flop na start
  gameState.pot = gameState.smallBlind + gameState.bigBlind;
  gameState.gameInProgress = true;
  gameState.currentTurn = 0;

  // Rozdaj po 2 karty każdemu graczowi
  gameState.players.forEach(player => {
    player.cards = [deck.pop(), deck.pop()];
    player.folded = false;
  });

  // ROZSYŁAMY STAN DO WSZYSTKICH
  io.emit('game_state', gameState);
};

io.on('connection', (socket) => {
  console.log('Nowe połączenie:', socket.id);

  // Po połączeniu od razu wyślij aktualny stan
  socket.emit('game_state', gameState);

  socket.on('join_game', (data) => {
    // Sprawdź czy gracz już istnieje
    const existingPlayer = gameState.players.find(p => p.id === socket.id);
    if (!existingPlayer) {
      gameState.players.push({
        id: socket.id,
        name: data.name || 'Gracz',
        chips: 1000,
        cards: [],
        folded: false
      });
    }

    // Jeśli jest min. 2 graczy i gra nie trwa - wystartuj
    if (gameState.players.length >= 2 && !gameState.gameInProgress) {
      startNewRound();
    } else {
      // Wyślij zaktualizowaną listę graczy do WSZYSTKICH
      io.emit('game_state', gameState);
    }
  });

  socket.on('player_action', (data) => {
    // Prosta obsługa akcji
    if (data.action === 'fold') {
      const player = gameState.players.find(p => p.id === socket.id);
      if (player) player.folded = true;
    }
    
    // Przejdź do następnego gracza
    gameState.currentTurn = (gameState.currentTurn + 1) % gameState.players.length;
    io.emit('game_state', gameState);
  });

  socket.on('send_chat', (msg) => {
    const player = gameState.players.find(p => p.id === socket.id);
    const sender = player ? player.name : 'Anonim';
    io.emit('chat_update', [{ sender, message: msg }]);
  });

  socket.on('disconnect', () => {
    gameState.players = gameState.players.filter(p => p.id !== socket.id);
    if (gameState.players.length < 2) {
      gameState.gameInProgress = false;
      gameState.communityCards = [];
    }
    io.emit('game_state', gameState);
  });
});

app.get('/', (req, res) => {
  res.send('Serwer Pokera Działa!');
});

server.listen(PORT, () => {
  console.log(`Serwer uruchomiony na porcie ${PORT}`);
});
