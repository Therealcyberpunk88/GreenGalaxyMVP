import http from "http";
import express from "express";
import cors from "cors";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";

import { MyRoom } from "./rooms/MyRoom";

const app = express();
app.use(cors());
app.use(express.json());

// health check for Render
app.get("/", (_req, res) => res.send("OK"));

const httpServer = http.createServer(app);

const gameServer = new Server({
    transport: new WebSocketTransport({ server: httpServer }),
});

gameServer.define("my_room", MyRoom);

const port = Number(process.env.PORT) || 2567;

httpServer.listen(port, () => {
    console.log("✅ Colyseus listening on", port);
});
