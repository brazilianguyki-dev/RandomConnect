import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { createServer as createViteServer } from "vite";
import path from "path";

async function startServer() {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
    },
  });

  const PORT = 3000;

  // Matching Queue
  let waitingUsers: { socketId: string; userId: string }[] = [];
  // Active Rooms: roomId -> [socketId1, socketId2]
  const activeRooms = new Map<string, string[]>();
  // User to Room mapping: socketId -> roomId
  const userRooms = new Map<string, string>();

  io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    socket.on("start_matching", ({ userId }) => {
      console.log("User started matching:", userId);
      
      // Remove if already in queue
      waitingUsers = waitingUsers.filter(u => u.userId !== userId);

      if (waitingUsers.length > 0) {
        // Match found!
        const partner = waitingUsers.shift()!;
        const roomId = `room_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        activeRooms.set(roomId, [socket.id, partner.socketId]);
        userRooms.set(socket.id, roomId);
        userRooms.set(partner.socketId, roomId);

        socket.join(roomId);
        io.sockets.sockets.get(partner.socketId)?.join(roomId);

        io.to(socket.id).emit("match_found", { roomId, partnerId: partner.userId });
        io.to(partner.socketId).emit("match_found", { roomId, partnerId: userId });
        
        console.log(`Matched ${userId} with ${partner.userId} in room ${roomId}`);
      } else {
        // Add to queue
        waitingUsers.push({ socketId: socket.id, userId });
        console.log("User added to queue. Queue size:", waitingUsers.length);
      }
    });

    socket.on("cancel_matching", ({ userId }) => {
      waitingUsers = waitingUsers.filter(u => u.userId !== userId);
      console.log("User cancelled matching:", userId);
    });

    socket.on("next_match", ({ userId }) => {
      const roomId = userRooms.get(socket.id);
      if (roomId) {
        socket.to(roomId).emit("partner_left");
        activeRooms.delete(roomId);
        // Remove both users from userRooms for this room
        for (const [sId, rId] of userRooms.entries()) {
          if (rId === roomId) userRooms.delete(sId);
        }
        socket.leave(roomId);
      }
      
      waitingUsers = waitingUsers.filter(u => u.userId !== userId);
      // Re-trigger matching logic
      socket.emit("re_match", { userId });
    });

    socket.on("typing", ({ roomId, isTyping }) => {
      socket.to(roomId).emit("partner_typing", { isTyping });
    });

    socket.on("disconnect", () => {
      const roomId = userRooms.get(socket.id);
      if (roomId) {
        socket.to(roomId).emit("partner_left");
        activeRooms.delete(roomId);
        for (const [sId, rId] of userRooms.entries()) {
          if (rId === roomId) userRooms.delete(sId);
        }
      }
      waitingUsers = waitingUsers.filter(u => u.socketId !== socket.id);
      console.log("User disconnected:", socket.id);
    });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.resolve(__dirname, "dist", "index.html"));
    });
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
