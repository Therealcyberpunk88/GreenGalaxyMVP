import http from "http";
import express from "express";
import cors from "cors";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";

import { MyRoom } from "./rooms/MyRoom";

const app = express();
app.use(cors());
app.use(express.json());

// Health check route (Render likes this)
app.get("/", (_req, res) => res.send("OK"));

const server = http.createServer(app);

const gameServer = new Server({
    transport: new WebSocketTransport({ server }),
});

// register your room
gameServer.define("my_room", MyRoom);

const port = Number(process.env.PORT) || 2567;

server.listen(port, () => {
    console.log("✅ Colyseus listening on", port);
});
