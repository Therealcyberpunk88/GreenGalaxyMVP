import { Room, Client } from "colyseus";
import { MyRoomState, PlayerState } from "./schema/MyRoomState";

type JoinOptions = { name?: string; avatarKey?: string; envKey?: string };

export class MyRoom extends Room<MyRoomState> {
    maxClients = 32;

    onCreate() {
        this.autoDispose = false;
        this.setState(new MyRoomState());

        console.log("✅ MyRoom created", this.roomId);

        this.onMessage("move", (client, msg: Partial<{ x: number; y: number; z: number; ry: number }>) => {
            const p = this.state.players.get(client.sessionId);
            if (!p) return;

            if (typeof msg.x === "number") p.x = Math.max(-50, Math.min(50, msg.x));
            if (typeof msg.y === "number") p.y = Math.max(-50, Math.min(50, msg.y));
            if (typeof msg.z === "number") p.z = Math.max(-50, Math.min(50, msg.z));
            if (typeof msg.ry === "number") p.ry = msg.ry;
        });

        this.onMessage("chat", (client, msg: { text?: string }) => {
            const text = (msg?.text ?? "").toString().trim();
            if (!text) return;

            const p = this.state.players.get(client.sessionId);
            const name = p?.name ?? "Guest";

            this.broadcast("chat", {
                id: client.sessionId,
                name,
                text: text.slice(0, 500),
                ts: Date.now(),
            });
        });

        this.onMessage("emote", (client, data: { emote?: string }) => {
            const emote = (data?.emote ?? "").toString();
            if (!emote) return;
            this.broadcast("emote", { id: client.sessionId, emote });
        });
    }

    onJoin(client: Client, options: JoinOptions) {
        // ✅ first player sets the room environment (everyone else follows)
        if (this.state.players.size === 0) {
            const requested = (options?.envKey ?? "").toString();
            this.state.envKey = requested === "whitespace" ? "whitespace" : "office";
            console.log("🌍 envKey set to", this.state.envKey);
        }

        const p = new PlayerState();
        p.id = client.sessionId;
        p.name = (options?.name ?? "Guest").toString().slice(0, 32);
        p.avatarKey = (options?.avatarKey ?? "a1").toString();

        p.x = 0;
        p.y = 1;     // ✅ 1 meter up
        p.z = -2;     // ✅ 2 meters “back” (we’ll treat +z as back)
        p.ry = Math.PI; // face toward origin (optional)

        this.state.players.set(client.sessionId, p);
        console.log("✅ MyRoom join", client.sessionId, options);
    }

    async onLeave(client: Client, consented: boolean) {
        try {
            // ✅ give the client 5 seconds to reconnect (refresh counts)
            await this.allowReconnection(client, 5);
            console.log("🔁 reconnected", client.sessionId);
        } catch {
            // ✅ no reconnection => remove from state
            this.state.players.delete(client.sessionId);
            console.log("👋 left (removed)", client.sessionId);
        }
    }
}
