const http = require("http");
const { Server } = require("socket.io");
const { PrismaClient } = require("@prisma/client");
const { PrismaMariaDb } = require("@prisma/adapter-mariadb");
const fs = require("fs");
const path = require("path");

let prisma;
try {
  // Load environment variables from .env files into process.env if not already set
  const pathsToCheck = [
    path.join(__dirname, ".env"),
    path.join(__dirname, "..", ".env")
  ];
  for (const envPath of pathsToCheck) {
    if (fs.existsSync(envPath)) {
      const envFile = fs.readFileSync(envPath, "utf8");
      envFile.split("\n").forEach(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) return;
        const parts = trimmed.split("=");
        if (parts.length >= 2) {
          const key = parts[0].trim();
          const val = parts.slice(1).join("=").trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
          if (key && !process.env[key]) {
            process.env[key] = val;
          }
        }
      });
    }
  }

  let dbUrl = process.env.DATABASE_URL;
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

// Reset all users' isOnline status to false on server startup to clear stale records
prisma.user.updateMany({
  data: { isOnline: false }
})
.then(result => console.log(`Cleared stale user online statuses. Reset count: ${result.count}`))
.catch(err => console.error("Failed to reset stale online statuses on startup:", err));

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = parsedUrl.pathname;

  if (pathname === "/health" || pathname === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "OK", message: "Socket server is running" }));
  } else if (pathname === "/is-online") {
    const userId = parsedUrl.searchParams.get("userId");
    try {
      const user = await prisma.user.findUnique({
        where: { id: userId || "" },
        select: { isOnline: true }
      });
      const isOnline = user ? user.isOnline : false;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ online: isOnline }));
    } catch (err) {
      console.error("Error in /is-online DB check:", err);
      // Fallback to in-memory check if DB fails
      const isOnline = onlineUsers.has(userId) && onlineUsers.get(userId).size > 0;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ online: isOnline }));
    }
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

// Helper to send a OneSignal push notification
async function sendPushNotification({ playerId, externalId, title, message, url }) {
  const appId = process.env.NEXT_PUBLIC_ONESIGNAL_APP_ID || "89ccfa0f-7840-4f33-9284-e9d0e44865a9";
  const apiKey = process.env.ONESIGNAL_REST_API_KEY;

  console.log("----------------------------------------");
  console.log("[SOCKET ONESIGNAL PUSH NOTIFICATION TRIGGERED]");
  console.log(`To External ID: ${externalId || "—"}`);
  console.log(`To Subscription ID: ${playerId || "—"}`);
  console.log(`Title: ${title}`);
  console.log(`Message: ${message}`);
  console.log(`URL Path: ${url}`);
  console.log("----------------------------------------");

  if (!apiKey || apiKey === "your-onesignal-rest-api-key-here") {
    console.warn("OneSignal push skipped: ONESIGNAL_REST_API_KEY not configured");
    return;
  }

  try {
    const payload = {
      app_id: appId,
      contents: { en: message },
      headings: { en: title },
    };

    if (url) {
      const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
      payload.url = `${baseUrl}${url}`;
    }

    if (externalId) {
      payload.include_aliases = { external_id: [externalId] };
      payload.target_channel = "push";
    } else if (playerId) {
      payload.include_subscription_ids = [playerId];
    } else {
      payload.included_segments = ["All"];
    }

    let response = await fetch("https://onesignal.com/api/v1/notifications", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Basic ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    let data = await response.json();

    // If external_id alias targeting fails (e.g. user hasn't completed client handshake),
    // immediately retry targeting via database-stored subscription ID (playerId).
    if (externalId && playerId && data.errors && (data.errors.invalid_aliases || (Array.isArray(data.errors) && data.errors.some(e => e.includes("alias"))))) {
      console.warn(`OneSignal external_id alias targeting failed for ${externalId}. Retrying with subscription ID (playerId): ${playerId}`);

      const fallbackPayload = {
        app_id: appId,
        contents: { en: message },
        headings: { en: title },
        include_subscription_ids: [playerId]
      };
      if (url) {
        const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
        fallbackPayload.url = `${baseUrl}${url}`;
      }

      response = await fetch("https://onesignal.com/api/v1/notifications", {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Authorization: `Basic ${apiKey}`,
        },
        body: JSON.stringify(fallbackPayload),
      });
      data = await response.json();
    }

    if (!response.ok) {
      throw new Error(data.errors ? (typeof data.errors === 'object' ? JSON.stringify(data.errors) : data.errors.join(", ")) : "OneSignal error");
    }
    console.log("OneSignal push notification sent successfully from socket server:", data);
  } catch (error) {
    console.error("OneSignal push notification from socket server failed:", error.message);
  }
}

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

    // Update database status to online
    prisma.user.update({
      where: { id: userId },
      data: { isOnline: true },
    }).catch(err => console.error(`Failed to update DB isOnline to true for user ${userId}:`, err));

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

    // Store current game and user data directly on the socket
    socket.gameId = gameId;
    socket.userId = userId;

    // Track online user registry for offline notification triggers
    socketToUser.set(socket.id, userId);
    if (!onlineUsers.has(userId)) {
      onlineUsers.set(userId, new Set());
    }
    onlineUsers.get(userId).add(socket.id);

    // Update database status to online
    prisma.user.update({
      where: { id: userId },
      data: { isOnline: true },
    }).catch(err => console.error(`Failed to update DB isOnline to true for user ${userId} in join-game:`, err));

    broadcastStatusUpdate(userId, "online");

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

  // Memory Game card flipping
  socket.on("flip-memory-card", async ({ gameId, userId, cellIndex }) => {
    console.log(`[SOCKET] flip-memory-card event: gameId=${gameId}, userId=${userId}, cellIndex=${cellIndex}`);
    if (!gameId || !userId || cellIndex === undefined) {
      console.log("[SOCKET] flip-memory-card: Missing parameters");
      return;
    }
    const roomName = `game:${gameId}`;

    try {
      const game = await prisma.game.findUnique({ where: { id: gameId } });
      if (!game) {
        console.log(`[SOCKET] flip-memory-card: Game ${gameId} not found`);
        return;
      }
      if (game.status !== "PLAYING") {
        console.log(`[SOCKET] flip-memory-card: Game status is not PLAYING (current: ${game.status})`);
        return;
      }
      if (game.mode !== "MEMORY") {
        console.log(`[SOCKET] flip-memory-card: Game mode is not MEMORY (current: ${game.mode})`);
        return;
      }
      if (game.turn !== userId) {
        console.log(`[SOCKET] flip-memory-card rejected: Not user ${userId}'s turn (current turn: ${game.turn})`);
        return;
      }

      // Parse fields
      const memoryGrid = Array.isArray(game.memoryGrid) ? game.memoryGrid : JSON.parse(game.memoryGrid || "[]");
      const memoryMatched = Array.isArray(game.memoryMatched) ? game.memoryMatched : JSON.parse(game.memoryMatched || "[]");
      let memoryFlipped = Array.isArray(game.memoryFlipped) ? game.memoryFlipped : JSON.parse(game.memoryFlipped || "[]");

      // Verify cell is valid and not already flipped or matched
      if (cellIndex < 0 || cellIndex >= 30) return;
      if (memoryMatched.includes(cellIndex)) return;
      if (memoryFlipped.includes(cellIndex)) return;

      // Handle card flipping
      if (memoryFlipped.length === 0) {
        // First card flipped
        memoryFlipped = [cellIndex];

        // Construct updated game representation in-memory
        const updatedGame = {
          ...game,
          memoryFlipped,
        };

        // Broadcast to players instantly
        io.to(roomName).emit("memory-card-flipped", {
          game: updatedGame,
          userId,
          cellIndex,
          emoji: memoryGrid[cellIndex],
          firstCard: true,
          flippedIndices: memoryFlipped,
        });

        // Update database asynchronously in the background
        prisma.game.update({
          where: { id: gameId },
          data: { memoryFlipped },
        }).catch(err => console.error("Error updating first flip in DB:", err));

      } else if (memoryFlipped.length === 1) {
        // Second card flipped
        const firstCardIndex = memoryFlipped[0];
        memoryFlipped = [firstCardIndex, cellIndex];

        // Construct updated game representation in-memory
        const updatedGame = {
          ...game,
          memoryFlipped,
        };

        // Broadcast immediately so both players see the second card reveal instantly
        io.to(roomName).emit("memory-card-flipped", {
          game: updatedGame,
          userId,
          cellIndex,
          emoji: memoryGrid[cellIndex],
          firstCard: false,
          flippedIndices: memoryFlipped,
        });

        // Update database asynchronously in the background
        prisma.game.update({
          where: { id: gameId },
          data: { memoryFlipped },
        }).catch(err => console.error("Error updating second flip in DB:", err));

        // Check if matching emojis
        const emoji1 = memoryGrid[firstCardIndex];
        const emoji2 = memoryGrid[cellIndex];
        const isMatch = emoji1 === emoji2;

        // Delay checking the result slightly so clients can see the card before it gets processed
        setTimeout(async () => {
          try {
            // Re-fetch current game state to avoid stale data during the delay
            const gameRefreshed = await prisma.game.findUnique({ where: { id: gameId } });
            if (!gameRefreshed) return;

            let nextTurn = gameRefreshed.turn;
            let updatedMatched = Array.isArray(gameRefreshed.memoryMatched)
              ? gameRefreshed.memoryMatched
              : JSON.parse(gameRefreshed.memoryMatched || "[]");
            let p1Score = gameRefreshed.player1Score;
            let p2Score = gameRefreshed.player2Score;
            let newStatus = gameRefreshed.status;
            let winnerId = gameRefreshed.winnerId;

            if (isMatch) {
              if (!updatedMatched.includes(firstCardIndex)) {
                updatedMatched.push(firstCardIndex, cellIndex);
              }
              if (gameRefreshed.player1Id === userId) {
                p1Score += 1;
              } else {
                p2Score += 1;
              }

              // Check win condition
              if (updatedMatched.length === 30) {
                newStatus = "FINISHED";
                if (p1Score > p2Score) {
                  winnerId = gameRefreshed.player1Id;
                } else if (p2Score > p1Score) {
                  winnerId = gameRefreshed.player2Id;
                } else {
                  winnerId = null; // Tie
                }
              }
            } else {
              // Switch turn
              nextTurn = (gameRefreshed.player1Id === userId) ? gameRefreshed.player2Id : gameRefreshed.player1Id;
            }

            // Update database to apply match results and reset flipped list
            const finalUpdatedGame = await prisma.game.update({
              where: { id: gameId },
              data: {
                memoryMatched: updatedMatched,
                memoryFlipped: [], // Reset flipped list now
                player1Score: p1Score,
                player2Score: p2Score,
                turn: nextTurn,
                status: newStatus,
                winnerId,
              },
            });

            // Emit match result
            io.to(roomName).emit("memory-match-result", {
              game: finalUpdatedGame,
              match: isMatch,
              flippedIndices: [firstCardIndex, cellIndex],
              scores: { p1: p1Score, p2: p2Score },
              nextTurn,
              isFinished: newStatus === "FINISHED",
            });
          } catch (err) {
            console.error("Error processing memory match delay:", err);
          }
        }, 1200);
      }
    } catch (err) {
      console.error("Error in flip-memory-card:", err);
    }
  });

  // Sending flying emojis
  socket.on("send-emoji", async ({ gameId, userId, emoji }) => {
    if (!gameId || !userId || !emoji) return;
    const roomName = `game:${gameId}`;
    io.to(roomName).emit("emoji-received", { userId, emoji });

    try {
      const game = await prisma.game.findUnique({
        where: { id: gameId },
        select: {
          player1Id: true,
          player2Id: true,
          player1: { select: { id: true, name: true, email: true, isOnline: true, oneSignalPlayerId: true } },
          player2: { select: { id: true, name: true, email: true, isOnline: true, oneSignalPlayerId: true } },
        }
      });

      if (game) {
        const sender = game.player1Id === userId ? game.player1 : game.player2;
        const opponent = game.player1Id === userId ? game.player2 : game.player1;
        
        // 100% online confirm: must be online in DB and have active socket connection
        const isOnline = opponent.isOnline && onlineUsers.has(opponent.id) && onlineUsers.get(opponent.id).size > 0;

        if (!isOnline) {
          const senderName = sender.name || sender.email.split("@")[0];
          await sendPushNotification({
            externalId: opponent.id,
            playerId: opponent.oneSignalPlayerId,
            title: `${senderName} reacted! ${emoji}`,
            message: `${senderName} sent you a ${emoji} in your match!`,
            url: `/game/${gameId}`,
          });
        }
      }
    } catch (err) {
      console.error("Error sending emoji push notification:", err);
    }
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

      const game = await prisma.game.findUnique({
        where: { id: gameId },
        select: {
          player1Id: true,
          player2Id: true,
          player1: { select: { id: true, name: true, email: true, isOnline: true, oneSignalPlayerId: true } },
          player2: { select: { id: true, name: true, email: true, isOnline: true, oneSignalPlayerId: true } },
        }
      });

      if (game) {
        const sender = game.player1Id === userId ? game.player1 : game.player2;
        const opponent = game.player1Id === userId ? game.player2 : game.player1;
        
        // 100% online confirm: must be online in DB and have active socket connection
        const isOnline = opponent.isOnline && onlineUsers.has(opponent.id) && onlineUsers.get(opponent.id).size > 0;

        if (!isOnline) {
          const senderName = sender.name || sender.email.split("@")[0];
          await sendPushNotification({
            externalId: opponent.id,
            playerId: opponent.oneSignalPlayerId,
            title: `New message from ${senderName} 💬`,
            message: content,
            url: `/game/${gameId}`,
          });
        }
      }
    } catch (err) {
      console.error("Error saving chat or sending chat push notification:", err);
    }
  });

  // Live 1v1 invite notification (if opponent is online)
  socket.on("send-invite", ({ senderId, senderName, receiverId, gameId, mode }) => {
    if (!senderId || !receiverId || !gameId) return;

    if (onlineUsers.has(receiverId)) {
      onlineUsers.get(receiverId).forEach((socketId) => {
        io.to(socketId).emit("invite-received", {
          senderId,
          senderName,
          gameId,
          mode: mode || "BATTLE",
        });
      });
      console.log(`Live invite sent to User ${receiverId} from ${senderId} for mode ${mode}`);
    }
  });

  // Relaying direct message to recipient if online
  socket.on("send-direct-message", ({ recipientId, message }) => {
    if (!recipientId || !message) return;
    if (onlineUsers.has(recipientId)) {
      onlineUsers.get(recipientId).forEach((socketId) => {
        io.to(socketId).emit("direct-message-received", message);
      });
      console.log(`Relayed direct message from ${message.senderId} to ${recipientId}`);
    } else {
      console.log(`Direct message recipient ${recipientId} is offline. Skipping real-time relay.`);
    }
  });

  // Handle disconnect
  socket.on("disconnect", () => {
    const userId = socketToUser.get(socket.id) || socket.userId;
    const gameId = socket.gameId;
    console.log(`Socket disconnected: ${socket.id}, User: ${userId}`);

    if (userId) {
      const userSockets = onlineUsers.get(userId);
      if (userSockets) {
        userSockets.delete(socket.id);
        if (userSockets.size === 0) {
          onlineUsers.delete(userId);
          console.log(`User ${userId} has gone completely offline.`);

          // Update database status to offline
          prisma.user.update({
            where: { id: userId },
            data: { isOnline: false },
          }).catch(err => console.error(`Failed to update DB isOnline to false for user ${userId}:`, err));

          broadcastStatusUpdate(userId, "offline");
        }
      }
      socketToUser.delete(socket.id);
    }

    // Emit immediate disconnect event to room
    if (gameId && userId) {
      const roomName = `game:${gameId}`;
      io.to(roomName).emit("opponent-disconnected-event", { userId });
      console.log(`User ${userId} disconnected from game ${gameId}. Keep-alive active.`);
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


