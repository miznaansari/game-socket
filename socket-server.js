const http = require("http");
const { Server } = require("socket.io");
const { PrismaClient } = require("@prisma/client");
const { PrismaMariaDb } = require("@prisma/adapter-mariadb");
const fs = require("fs");
const path = require("path");

let prisma;
try {
  let dbUrl = process.env.DATABASE_URL;

  // If DATABASE_URL is not in system env, try reading from local .env
  if (!dbUrl) {
    const envPath = path.join(__dirname, ".env");
    if (fs.existsSync(envPath)) {
      const envFile = fs.readFileSync(envPath, "utf8");
      const envVars = {};
      envFile.split("\n").forEach(line => {
        const parts = line.split("=");
        if (parts.length >= 2) {
          envVars[parts[0].trim()] = parts.slice(1).join("=").trim().replace(/^"(.*)"$/, "$1");
        }
      });
      dbUrl = envVars.DATABASE_URL;
    }
  }

  if (!dbUrl) {
    throw new Error("DATABASE_URL is not set in environment or .env file");
  }

  const parsedUrl = new URL(dbUrl);
  const adapter = new PrismaMariaDb({
    host: parsedUrl.hostname,
    port: parseInt(parsedUrl.port || "3306", 10),
    user: parsedUrl.username,
    password: decodeURIComponent(parsedUrl.password),
    database: parsedUrl.pathname.replace(/^\//, ""),
  });

  prisma = new PrismaClient({ adapter });
  console.log("Prisma initialized successfully with MariaDB adapter in socket-server");
} catch (err) {
  console.error("Prisma initialization failed in socket-server:", err);
  // Fail-safe default (though it may error in Prisma 7 if adapter is required)
  prisma = new PrismaClient();
}

const server = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "OK", message: "Socket server is running" }));
  } else {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  }
});
const io = new Server(server, {
  cors: {
    origin: "*", // Allow all connections, or process.env.NEXT_PUBLIC_APP_URL
    methods: ["GET", "POST"],
  },
});

// Map of userId -> Set of socketIds
const onlineUsers = new Map();
// Map of socketId -> userId
const socketToUser = new Map();

io.on("connection", (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  // User logs in / goes online
  socket.on("user-online", (userId) => {
    if (!userId) return;

    socketToUser.set(socket.id, userId);

    if (!onlineUsers.has(userId)) {
      onlineUsers.set(userId, new Set());
    }
    onlineUsers.get(userId).add(socket.id);

    console.log(`User ${userId} is online. Sockets:`, onlineUsers.get(userId).size);

    // Broadcast status to friends
    broadcastStatusUpdate(userId, "online");
  });

  // Query online status of a list of users
  socket.on("get-online-status", (userIds, callback) => {
    if (!Array.isArray(userIds)) return callback({});
    const statuses = {};
    userIds.forEach((id) => {
      statuses[id] = onlineUsers.has(id) && onlineUsers.get(id).size > 0 ? "online" : "offline";
    });
    callback(statuses);
  });

  // Joining a game room
  socket.on("join-game", async ({ gameId, userId }) => {
    if (!gameId || !userId) return;

    const roomName = `game:${gameId}`;
    socket.join(roomName);
    console.log(`Socket ${socket.id} (User: ${userId}) joined room ${roomName}`);

    // Send a message indicating user joined
    io.to(roomName).emit("user-joined-room", { userId });
  });

  // Submitting 5-block selection (0-63 grid)
  socket.on("select-blocks", async ({ gameId, userId, selections }) => {
    if (!gameId || !userId || !Array.isArray(selections) || selections.length !== 5) return;

    const roomName = `game:${gameId}`;

    try {
      const game = await prisma.game.findUnique({ where: { id: gameId } });
      if (!game || game.status !== "SELECTING") return;

      let updateData = {};
      if (game.player1Id === userId) {
        updateData.player1Selections = selections;
      } else if (game.player2Id === userId) {
        updateData.player2Selections = selections;
      } else {
        return; // Unauthorized player
      }

      // Check if both selections will be present after this update
      const p1Sel = game.player1Id === userId ? selections : game.player1Selections;
      const p2Sel = game.player2Id === userId ? selections : game.player2Selections;

      let newStatus = "SELECTING";
      let turn = game.turn;

      if (p1Sel && p2Sel) {
        newStatus = "PLAYING";
        // Randomly select who goes first or default to player1
        turn = Math.random() < 0.5 ? game.player1Id : game.player2Id;
      }

      const updatedGame = await prisma.game.update({
        where: { id: gameId },
        data: {
          ...updateData,
          status: newStatus,
          turn,
        },
      });

      io.to(roomName).emit("game-updated", {
        game: updatedGame,
        event: "selection",
        userId,
      });

      console.log(`User ${userId} selected blocks for game ${gameId}. Status now: ${newStatus}`);
    } catch (err) {
      console.error("Error in select-blocks:", err);
    }
  });

  // Making a turn guess (battleship coordinate click)
  socket.on("make-guess", async ({ gameId, userId, cellIndex }) => {
    if (!gameId || !userId || cellIndex === undefined) return;
    const roomName = `game:${gameId}`;

    try {
      const game = await prisma.game.findUnique({ where: { id: gameId } });
      if (!game || game.status !== "PLAYING") return;
      if (game.turn !== userId) {
        console.log(`Guess rejected: It is not user ${userId}'s turn.`);
        return; // Not user's turn
      }

      const isPlayer1 = game.player1Id === userId;
      const opponentId = isPlayer1 ? game.player2Id : game.player1Id;

      // Selections to hit
      const opponentSelections = isPlayer1
        ? (game.player2Selections || [])
        : (game.player1Selections || []);

      // Current guesses list
      const myGuesses = isPlayer1
        ? (game.player1Guesses || [])
        : (game.player2Guesses || []);

      // Don't allow guessing the same cell twice
      if (myGuesses.includes(cellIndex)) return;

      const updatedGuesses = [...myGuesses, cellIndex];
      const isHit = opponentSelections.includes(cellIndex);

      // Check if all opponent selections are guessed (win condition)
      const hasWon = opponentSelections.every(sel => updatedGuesses.includes(sel));

      let newStatus = game.status;
      let winnerId = game.winnerId;
      let nextTurn = game.turn;

      if (hasWon) {
        newStatus = "FINISHED";
        winnerId = userId;
      } else {
        // Switch turn if miss. (If hit, player keeps turn!)
        if (!isHit) {
          nextTurn = opponentId;
        }
      }

      let updateData = {
        status: newStatus,
        winnerId,
        turn: nextTurn,
      };

      if (isPlayer1) {
        updateData.player1Guesses = updatedGuesses;
      } else {
        updateData.player2Guesses = updatedGuesses;
      }

      const updatedGame = await prisma.game.update({
        where: { id: gameId },
        data: updateData,
      });

      // Broadcast result
      io.to(roomName).emit("guess-result", {
        game: updatedGame,
        guess: {
          userId,
          cellIndex,
          isHit,
          isWinner: hasWon,
        },
      });

      console.log(`Guess by ${userId} on cell ${cellIndex} - Hit: ${isHit}. Win: ${hasWon}`);
    } catch (err) {
      console.error("Error making guess:", err);
    }
  });

  // Sending flying emojis
  socket.on("send-emoji", ({ gameId, userId, emoji }) => {
    if (!gameId || !userId || !emoji) return;
    const roomName = `game:${gameId}`;
    io.to(roomName).emit("emoji-received", { userId, emoji });
  });

  // Sending game chat message
  socket.on("send-chat", async ({ gameId, userId, content }) => {
    if (!gameId || !userId || !content) return;
    const roomName = `game:${gameId}`;

    try {
      const message = await prisma.chatMessage.create({
        data: {
          gameId,
          senderId: userId,
          content,
        },
        include: {
          sender: {
            select: { name: true, email: true },
          },
        },
      });

      io.to(roomName).emit("chat-received", message);
    } catch (err) {
      console.error("Error saving chat:", err);
    }
  });

  // Live 1v1 invite notification (if opponent is online)
  socket.on("send-invite", ({ senderId, senderName, receiverId, gameId }) => {
    if (!senderId || !receiverId || !gameId) return;

    if (onlineUsers.has(receiverId)) {
      onlineUsers.get(receiverId).forEach((socketId) => {
        io.to(socketId).emit("invite-received", {
          senderId,
          senderName,
          gameId,
        });
      });
      console.log(`Live invite sent to User ${receiverId} from ${senderId}`);
    }
  });

  // Handle disconnect
  socket.on("disconnect", () => {
    const userId = socketToUser.get(socket.id);
    console.log(`Socket disconnected: ${socket.id}`);

    if (userId) {
      const userSockets = onlineUsers.get(userId);
      if (userSockets) {
        userSockets.delete(socket.id);
        if (userSockets.size === 0) {
          onlineUsers.delete(userId);
          console.log(`User ${userId} has gone completely offline.`);
          broadcastStatusUpdate(userId, "offline");
        }
      }
      socketToUser.delete(socket.id);
    }
  });
});

// Helper function to broadcast friend status updates
function broadcastStatusUpdate(userId, status) {
  // Let the client check online status on load, 
  // but also broadcast active status switches to anyone listening
  io.emit("friend-status-changed", { userId, status });
}

if (process.env.VERCEL) {
  console.log("Running in Vercel Serverless environment. Exporting server handler.");
  module.exports = server;
} else {
  const PORT = process.env.SOCKET_PORT || process.env.PORT || 3001;
  server.listen(PORT, () => {
    console.log(`Socket.io Server running on port ${PORT}`);
  });
}


