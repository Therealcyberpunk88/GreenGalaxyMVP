import { Schema, MapSchema, type } from "@colyseus/schema";

export class PlayerState extends Schema {
    @type("string") id: string = "";
    @type("string") name: string = "Guest";
    @type("string") avatarKey: string = "a1";

    @type("number") x: number = 0;
    @type("number") y: number = 0;
    @type("number") z: number = 0;
    @type("number") ry: number = 0; // rotation around Y
}

export class MyRoomState extends Schema {
    @type({ map: PlayerState }) players = new MapSchema<PlayerState>();

    // ✅ room-wide environment
    @type("string") envKey: string = "office";
}
