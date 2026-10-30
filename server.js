const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

const registeredUsers = {
  "Ed": { password: "123", avatar: "https://cdn-icons-png.flaticon.com/512/3135/3135715.png", isOwner: true }
};

let gameState = {
  hostId: null,
  players: [],
  communityCards: [],
  pot: 0,
  currentTurn: 0,
  currentBet: 0,
  smallBlind: 10,
  bigBlind: 20,
  gameInProgress: false,
  phase: 'waiting',
  turnTimer: 15
};

let deck = [];
let turnInterval = null;

const createDeck = () => {
  const suits = ['♠', '♥', '♣', '♦'];
  const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  let newDeck = [];
  for (let s of suits) {
    for (let v of values) {
      newDeck.push(`${v}${s}`);
    }
  }
  return newDeck.sort(() => Math.random() - 0.5);
};

const resetTurnTimer = () => {
  if (turnInterval) clearInterval(turnInterval);
  gameState.turnTimer = 15;

  turnInterval = setInterval(() => {
    if (!gameState.gameInProgress) {
      clearInterval(turnInterval);
      return;
    }

    gameState.turnTimer -= 1;
    io.emit('game_state', gameState);

    if (gameState.turnTimer <= 5 && gameState.turnTimer > 0) {
      io.emit('play_sound', 'tick');
    }

    if (gameState.turnTimer <= 0) {
      clearInterval(turnInterval);
      handleTimeoutAction();
    }
  }, 1000);
};

const handleTimeoutAction = () => {
  const currentPlayer = gameState.players[gameState.currentTurn];
  if (currentPlayer) {
    currentPlayer.folded = true;
    io.emit('play_sound', 'fold');
  }
  advanceTurn();
};

const advanceTurn = () => {
  let nextTurn = (gameState.currentTurn + 1) % gameState.players.length;
  let attempts = 0;
  while (gameState.players[nextTurn].folded && attempts < gameState.players.length) {
    nextTurn = (nextTurn + 1) % gameState.players.length;
    attempts++;
  }

  if (nextTurn === 0 || attempts >= gameState.players.length - 1) {
    nextPhaseOrWinner();
  } else {
    gameState.currentTurn = nextTurn;
    resetTurnTimer();
    io.emit('game_state', gameState);
  }
};

const startNewRound = () => {
  const activePlayers = gameState.players.filter(p => p.chips > 0);
  if (activePlayers.length < 2) {
    gameState.gameInProgress = false;
    gameState.phase = 'waiting';
    if (turnInterval) clearInterval(turnInterval);
    io.emit('game_state', gameState);
    return;
  }

  deck = createDeck();
  gameState.communityCards = [];
  gameState.pot = 0;
  gameState.currentBet = gameState.bigBlind;
  gameState.phase = 'preflop';
  gameState.gameInProgress = true;
  gameState.currentTurn = 0;

  gameState.players.forEach((player, index) => {
    player.cards = [deck.pop(), deck.pop()];
    player.folded = false;
    player.currentBet = 0;

    if (index === 0) {
      const sb = Math.min(player.chips, gameState.smallBlind);
      player.chips -= sb;
      player.currentBet = sb;
      gameState.pot += sb;
    } else if (index === 1) {
      const bb = Math.min(player.chips, gameState.bigBlind);
      player.chips -= bb;
      player.currentBet = bb;
      gameState.pot += bb;
    }
  });

  resetTurnTimer();
  io.emit('game_state', gameState);
  io.emit('play_sound', 'deal');
};

const nextPhaseOrWinner = () => {
  const activePlayers = gameState.players.filter(p => !p.folded);

  if (activePlayers.length === 1) {
    if (turnInterval) clearInterval(turnInterval);
    const winner = activePlayers[0];
    winner.chips += gameState.pot;
    gameState.pot = 0;
    setTimeout(startNewRound, 3000);
    io.emit('game_state', gameState);
    io.emit('play_sound', 'win');
    return;
  }

  if (gameState.phase === 'preflop') {
    gameState.phase = 'flop';
    gameState.communityCards = [deck.pop(), deck.pop(), deck.pop()];
  } else if (gameState.phase === 'flop') {
    gameState.phase = 'turn';
    gameState.communityCards.push(deck.pop());
  } else if (gameState.phase === 'turn') {
    gameState.phase = 'river';
    gameState.communityCards.push(deck.pop());
  } else if (gameState.phase === 'river') {
    if (turnInterval) clearInterval(turnInterval);
    activePlayers[0].chips += gameState.pot;
    gameState.pot = 0;
    setTimeout(startNewRound, 4000);
    io.emit('game_state', gameState);
    io.emit('play_sound', 'win');
    return;
  }

  gameState.currentBet = 0;
  gameState.players.forEach(p => p.currentBet = 0);
  gameState.currentTurn = 0;
  resetTurnTimer();
  io.emit('game_state', gameState);
  io.emit('play_sound', 'card_flop');
};

io.on('connection', (socket) => {
  socket.emit('game_state', gameState);

  socket.on('register_or_login', (data) => {
    const nick = (data.nick || '').trim();
    const pass = (data.password || '').trim();
    const avatar = data.avatar || "https://cdn-icons-png.flaticon.com/512/847/847969.png";

    if (!nick || !pass) {
      return socket.emit('error_msg', 'Wpisz Nick oraz Hasło!');
    }

    if (registeredUsers[nick]) {
      if (registeredUsers[nick].password !== pass) {
        return socket.emit('error_msg', 'Błędne hasło dla konta ' + nick);
      }
    } else {
      registeredUsers[nick] = { password: pass, avatar: avatar, isOwner: nick === 'Ed' };
    }

    if (nick === 'Ed') gameState.hostId = socket.id;

    gameState.players.push({
      id: socket.id,
      name: nick,
      avatar: registeredUsers[nick].avatar,
      chips: 1000,
      cards: [],
      folded: false,
      currentBet: 0
    });

    socket.emit('login_success', { nick, avatar: registeredUsers[nick].avatar });
    io.emit('game_state', gameState);
  });

  socket.on('start_game_manual', () => {
    if (socket.id === gameState.hostId && gameState.players.length >= 2 && !gameState.gameInProgress) {
      startNewRound();
    }
  });

  socket.on('player_action', (data) => {
    const playerIndex = gameState.players.findIndex(p => p.id === socket.id);
    if (playerIndex !== gameState.currentTurn || !gameState.gameInProgress) return;

    const player = gameState.players[playerIndex];

    if (data.action === 'fold') {
      player.folded = true;
      io.emit('play_sound', 'fold');
    } else if (data.action === 'call') {
      const callAmount = gameState.currentBet - player.currentBet;
      const actualCall = Math.min(player.chips, callAmount);
      player.chips -= actualCall;
      player.currentBet += actualCall;
      gameState.pot += actualCall;
      io.emit('play_sound', 'chips');
    } else if (data.action === 'raise') {
      const raiseBy = Number(data.amount) || 50;
      const totalBetNeeded = (gameState.currentBet - player.currentBet) + raiseBy;
      const actualRaise = Math.min(player.chips, totalBetNeeded);
      player.chips -= actualRaise;
      player.currentBet += actualRaise;
      gameState.currentBet = player.currentBet;
      gameState.pot += actualRaise;
      io.emit('play_sound', 'chips');
    }

    advanceTurn();
  });

  socket.on('send_chat', (msg) => {
    const player = gameState.players.find(p => p.id === socket.id);
    io.emit('chat_update', [{ sender: player ? player.name : 'Gracz', message: msg }]);
  });

  socket.on('disconnect', () => {
    gameState.players = gameState.players.filter(p => p.id !== socket.id);
    if (gameState.players.length < 2) {
      gameState.gameInProgress = false;
      gameState.phase = 'waiting';
      if (turnInterval) clearInterval(turnInterval);
    }
    io.emit('game_state', gameState);
  });
});

app.get('/', (req, res) => res.send('Poker Server Online'));
server.listen(PORT, () => console.log(`Serwer na porcie ${PORT}`));
