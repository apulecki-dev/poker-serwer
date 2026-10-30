const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = process.env.PORT || 3000;

// STAN GRY NA SERWERZE
let gameState = {
  players: [],           // { id, name, chips, cards: [], currentBet: 0, folded: false }
  communityCards: [],    // Karty na stole
  pot: 0,                // Pula
  smallBlind: 10,
  bigBlind: 20,
  currentTurn: 0,        // Indeks gracza, który ma ruch
  dealerIndex: 0,        // Indeks krupiera
  gameStage: 'waiting',  // 'waiting', 'preflop', 'flop', 'turn', 'river', 'showdown'
  highestBet: 0
};

let deck = [];
let chatHistory = [];

// TWORZENIE I TASOWANIE TALII
function createDeck() {
  const suits = ['♠', '♥', '♦', '♣'];
  const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  let newDeck = [];
  for (let s of suits) {
    for (let v of values) {
      newDeck.push(v + s);
    }
  }
  return newDeck.sort(() => Math.random() - 0.5);
}

// ROZPOCZĘCIE NOWEJ RUNDY (KRUPIER ROZDAJE)
function startNewRound() {
  const activePlayers = gameState.players.filter(p => p.chips > 0);
  if (activePlayers.length < 2) {
    gameState.gameStage = 'waiting';
    broadcastState();
    return;
  }

  deck = createDeck();
  gameState.communityCards = [];
  gameState.pot = 0;
  gameState.highestBet = gameState.bigBlind;
  gameState.gameStage = 'preflop';

  // Przesunięcie krupiera
  gameState.dealerIndex = (gameState.dealerIndex + 1) % gameState.players.length;

  // Resetowanie graczy i rozdawanie kart
  gameState.players.forEach((p, idx) => {
    p.folded = false;
    p.currentBet = 0;
    p.cards = [deck.pop(), deck.pop()];
  });

  // Pobranie Blindów
  const sbIdx = (gameState.dealerIndex + 1) % gameState.players.length;
  const bbIdx = (gameState.dealerIndex + 2) % gameState.players.length;

  gameState.players[sbIdx].chips -= gameState.smallBlind;
  gameState.players[sbIdx].currentBet = gameState.smallBlind;

  gameState.players[bbIdx].chips -= gameState.bigBlind;
  gameState.players[bbIdx].currentBet = gameState.bigBlind;

  gameState.pot = gameState.smallBlind + gameState.bigBlind;
  gameState.currentTurn = (bbIdx + 1) % gameState.players.length;

  broadcastState();
}

// PRZEJŚCIE DO KOLEJNEJ FAZY (FLOP, TURN, RIVER)
function nextStage() {
  // Reset zakłądów na stół
  gameState.players.forEach(p => p.currentBet = 0);
  gameState.highestBet = 0;

  if (gameState.gameStage === 'preflop') {
    gameState.gameStage = 'flop';
    gameState.communityCards = [deck.pop(), deck.pop(), deck.pop()];
  } else if (gameState.gameStage === 'flop') {
    gameState.gameStage = 'turn';
    gameState.communityCards.push(deck.pop());
  } else if (gameState.gameStage === 'turn') {
    gameState.gameStage = 'river';
    gameState.communityCards.push(deck.pop());
  } else if (gameState.gameStage === 'river') {
    gameState.gameStage = 'showdown';
    resolveShowdown();
    return;
  }

  gameState.currentTurn = (gameState.dealerIndex + 1) % gameState.players.length;
  broadcastState();
}

// ROZSTRZYGNIĘCIE RUNDY (PRZYZNANIE PULI)
function resolveShowdown() {
  const active = gameState.players.filter(p => !p.folded);
  if (active.length > 0) {
    // Prosta logika: wygrany bierze pulę (przy braku pełnego silnika oceny układów wygrywa pierwszy aktywny gracz)
    const winner = active[0];
    winner.chips += gameState.pot;
    chatHistory.push({ sender: 'KRUPIER', message: `${winner.name} wygrywa pulę $${gameState.pot}!` });
  }

  setTimeout(() => {
    startNewRound();
  }, 4000);
}

// OBSŁUGA POŁĄCZEŃ SOCKET.IO
io.on('connection', (socket) => {
  // Dołączenie gracza
  socket.on('join_game', ({ name }) => {
    const existing = gameState.players.find(p => p.name === name);
    if (!existing) {
      gameState.players.push({
        id: socket.id,
        name: name,
        chips: 1000,
        cards: [],
        currentBet: 0,
        folded: false
      });
      chatHistory.push({ sender: 'SYSTEM', message: `${name} dołączył do stołu.` });
    }

    if (gameState.players.length >= 2 && gameState.gameStage === 'waiting') {
      startNewRound();
    } else {
      broadcastState();
    }
  });

  // Akcje gracza (Fold, Call, Raise)
  socket.on('player_action', ({ action, amount }) => {
    const player = gameState.players.find(p => p.id === socket.id);
    if (!player || player.folded) return;

    if (action === 'fold') {
      player.folded = true;
      chatHistory.push({ sender: 'GRA', message: `${player.name} pasuje (Fold).` });
    } else if (action === 'call') {
      const callAmount = gameState.highestBet - player.currentBet;
      player.chips -= callAmount;
      player.currentBet += callAmount;
      gameState.pot += callAmount;
      chatHistory.push({ sender: 'GRA', message: `${player.name} sprawdza.` });
    } else if (action === 'raise') {
      const raiseTotal = (gameState.highestBet - player.currentBet) + amount;
      player.chips -= raiseTotal;
      player.currentBet += raiseTotal;
      gameState.highestBet = player.currentBet;
      gameState.pot += raiseTotal;
      chatHistory.push({ sender: 'GRA', message: `${player.name} podbija o $${amount}.` });
    }

    // Przesunięcie tury do następnego aktywnego gracza
    let nextTurn = (gameState.currentTurn + 1) % gameState.players.length;
    while (gameState.players[nextTurn].folded && gameState.players.filter(p => !p.folded).length > 1) {
      nextTurn = (nextTurn + 1) % gameState.players.length;
    }
    gameState.currentTurn = nextTurn;

    // Sprawdzenie czy wszyscy pasowali
    const activePlayers = gameState.players.filter(p => !p.folded);
    if (activePlayers.length === 1) {
      activePlayers[0].chips += gameState.pot;
      chatHistory.push({ sender: 'KRUPIER', message: `${activePlayers[0].name} wygrywa $${gameState.pot} (reszta spasowała).` });
      setTimeout(startNewRound, 3000);
    } else {
      broadcastState();
    }
  });

  // Obsługa czatu
  socket.on('send_chat', (msg) => {
    const player = gameState.players.find(p => p.id === socket.id);
    if (player) {
      chatHistory.push({ sender: player.name, message: msg });
      if (chatHistory.length > 30) chatHistory.shift();
      io.emit('chat_update', chatHistory);
    }
  });

  socket.on('disconnect', () => {
    gameState.players = gameState.players.filter(p => p.id !== socket.id);
    broadcastState();
  });
});

function broadcastState() {
  io.emit('game_state', gameState);
  io.emit('chat_update', chatHistory);
}

server.listen(PORT, () => {
  console.log(`Serwer pokera działa na porcie ${PORT}`);
});
