import { describe, expect, test } from "vitest";
import { Config } from "../../server/src/config";
import { Game } from "../../server/src/game/game";
import {
    getAbandonReason,
    type LifecycleConfig,
    type RoomSnapshot,
    SlotReservations,
    selectIdleWorkersToKill,
} from "../../server/src/game/gameLifecycle";
import type { MapDefs } from "../../shared/defs/mapDefs";
import { TeamMode } from "../../shared/gameConfig";
import * as net from "../../shared/net/net";

const cfg: LifecycleConfig = {
    abandonedRoomTimeoutMs: 60_000,
    emptyRoomTimeoutMs: 60_000,
    idlePublicRoomTimeoutMs: 120_000,
    joinTokenGraceMs: 20_000,
    stoppedWorkerTtlMs: 60_000,
    maxIdleWorkers: 2,
    reconnectGraceMs: 30_000,
};

const T0 = 1_000_000;

function room(overrides: Partial<RoomSnapshot> = {}): RoomSnapshot {
    return {
        state: "waiting",
        isPublic: false,
        openSockets: 0,
        everHadSocket: false,
        emptySince: T0,
        lastJoinTokenTime: 0,
        occupancy: {
            connectedPlayers: 0,
            connectedSpectators: 0,
            disconnectedBodies: 0,
            pendingJoinTokens: 0,
            reservedSlots: 0,
            tokenSeq: 0,
            started: false,
            over: false,
        },
        ...overrides,
    };
}

function withOcc(
    r: RoomSnapshot,
    occ: Partial<NonNullable<RoomSnapshot["occupancy"]>>,
): RoomSnapshot {
    return { ...r, occupancy: { ...r.occupancy!, ...occ } };
}

describe("getAbandonReason", () => {
    test("private room created but never joined stops after the timeout", () => {
        const r = room();
        expect(getAbandonReason(r, T0 + 59_000, cfg)).toBeUndefined();
        expect(getAbandonReason(r, T0 + 60_000, cfg)).toBe("abandoned_never_joined");
    });

    test("room that had players and is now empty", () => {
        const r = room({ everHadSocket: true });
        expect(getAbandonReason(r, T0 + 30_000, cfg)).toBeUndefined();
        expect(getAbandonReason(r, T0 + 60_000, cfg)).toBe("abandoned_empty_room");
    });

    test("public matchmaking room that hasn't started is kept warm longer", () => {
        const r = room({ isPublic: true, everHadSocket: true });
        expect(getAbandonReason(r, T0 + 90_000, cfg)).toBeUndefined();
        expect(getAbandonReason(r, T0 + 120_000, cfg)).toBe("idle_public_room");
    });

    test("private lobby waiting for players with someone connected is kept", () => {
        const r = withOcc(room({ openSockets: 1, everHadSocket: true }), {
            connectedPlayers: 1,
        });
        expect(getAbandonReason(r, T0 + 3_600_000, cfg)).toBeUndefined();
    });

    test("match with only connected spectators is kept", () => {
        const r = withOcc(
            room({ state: "running", openSockets: 2, everHadSocket: true }),
            { connectedSpectators: 2, started: true },
        );
        expect(getAbandonReason(r, T0 + 3_600_000, cfg)).toBeUndefined();
    });

    test("worker still reporting a connected spectator keeps it even with no socket (close in flight)", () => {
        const r = withOcc(room({ state: "running", everHadSocket: true }), {
            connectedSpectators: 1,
            started: true,
        });
        expect(getAbandonReason(r, T0 + 3_600_000, cfg)).toBeUndefined();
    });

    test("disconnected bodies alone don't keep a match alive", () => {
        const r = withOcc(room({ state: "running", everHadSocket: true }), {
            disconnectedBodies: 12,
            started: true,
        });
        expect(getAbandonReason(r, T0 + 59_000, cfg)).toBeUndefined();
        expect(getAbandonReason(r, T0 + 60_000, cfg)).toBe("abandoned_empty_match");
    });

    test("pending join tokens or a recent reservation keep the room", () => {
        expect(
            getAbandonReason(
                withOcc(room(), { pendingJoinTokens: 1 }),
                T0 + 600_000,
                cfg,
            ),
        ).toBeUndefined();
        const reserved = room({ lastJoinTokenTime: T0 + 590_000 });
        expect(getAbandonReason(reserved, T0 + 600_000, cfg)).toBeUndefined();
        expect(getAbandonReason(reserved, T0 + 610_000, cfg)).toBe(
            "abandoned_never_joined",
        );
    });

    test("never touches rooms being created, stopping, stopped, ending, or without a report", () => {
        const now = T0 + 3_600_000;
        for (const state of ["creating", "stopping", "stopped", "terminating"] as const) {
            expect(getAbandonReason(room({ state }), now, cfg)).toBeUndefined();
        }
        expect(
            getAbandonReason(withOcc(room(), { over: true }), now, cfg),
        ).toBeUndefined();
        expect(
            getAbandonReason(room({ occupancy: undefined }), now, cfg),
        ).toBeUndefined();
    });
});

describe("selectIdleWorkersToKill", () => {
    test("kills workers past the TTL and the oldest above the idle limit", () => {
        const now = T0;
        const workers = [
            { id: "a", stoppedTime: now - 1_000 },
            { id: "b", stoppedTime: now - 5_000 },
            { id: "c", stoppedTime: now - 10_000 },
            { id: "d", stoppedTime: now - 61_000 },
        ];
        const res = selectIdleWorkersToKill(workers, now, cfg);
        expect(res.map((r) => [r.worker.id, r.reason])).toEqual([
            ["c", "too_many_idle"],
            ["d", "stopped_ttl"],
        ]);
    });
});

describe("SlotReservations", () => {
    test("only counts tokens the worker hasn't acknowledged", () => {
        const slots = new SlotReservations();
        const a = slots.reserve(2);
        slots.reserve(3);
        expect(slots.pendingSlots).toBe(5);
        slots.ack(a);
        expect(slots.pendingSlots).toBe(3);
        slots.ack(a + 1);
        expect(slots.pendingSlots).toBe(0);
    });
});

async function createGame(
    mapName: keyof typeof MapDefs,
    teamMode = TeamMode.Solo,
    config: { arenaPrivate?: boolean } = {},
) {
    Config.logging.infoLogs = false;
    Config.logging.debugLogs = false;
    if (Config.webhooks) Config.webhooks.mapGeneration = "";
    const closed: Array<{ socketId: string; reason?: string; logReason?: string }> = [];
    const sent: Array<{ socketId: string; data: Uint8Array }> = [];
    const game = new Game(
        "lifecycle-test",
        { mapName, teamMode, ...config },
        (socketId, data) => sent.push({ socketId, data }),
        (socketId, reason, logReason) => closed.push({ socketId, reason, logReason }),
        () => {},
    );
    await game.init();
    return { game, closed, sent };
}

let tokenCounter = 0;
function join(game: Game, socketId: string, opts: { spectator?: boolean } = {}) {
    const token = `token-${tokenCounter++}`;
    game.addJoinTokens(
        [{ token, userId: null, ip: "127.0.0.1", spectator: opts.spectator }],
        false,
    );
    const msg = new net.JoinMsg();
    msg.matchPriv = token;
    msg.name = socketId;
    game.playerBarn.addPlayer(socketId, msg, "127.0.0.1");
    return { token, player: game.playerBarn.socketIdToPlayer.get(socketId)! };
}

function rejoin(game: Game, socketId: string, token: string) {
    const msg = new net.JoinMsg();
    msg.matchPriv = token;
    game.playerBarn.addPlayer(socketId, msg, "127.0.0.2");
    return game.playerBarn.socketIdToPlayer.get(socketId);
}

describe("game occupancy and abandoned stop", () => {
    test("counts connected players, spectators, bodies and pending tokens", async () => {
        const { game } = await createGame("br_main");
        join(game, "p1");
        join(game, "p2");
        join(game, "s1", { spectator: true });
        game.addJoinTokens([{ token: "pending", userId: null, ip: "x" }], false, 7);

        let occ = game.getOccupancy();
        expect(occ.connectedPlayers).toBe(2);
        expect(occ.connectedSpectators).toBe(1);
        expect(occ.pendingJoinTokens).toBe(1);
        expect(occ.reservedSlots).toBe(3);
        expect(occ.tokenSeq).toBe(7);

        game.step(6);
        game.handleSocketClose("p2");
        occ = game.getOccupancy();
        expect(occ.connectedPlayers).toBe(1);
        expect(occ.disconnectedBodies).toBe(1);
    });

    test("requestStop refuses while a player, spectator or join token is present", async () => {
        const { game } = await createGame("br_main");
        join(game, "s1", { spectator: true });
        expect(game.requestStop("test")).toBe(false);
        game.handleSocketClose("s1");

        game.addJoinTokens([{ token: "pending", userId: null, ip: "x" }], false);
        expect(game.requestStop("test")).toBe(false);
        expect(game.stopped).toBe(false);
    });

    test("requestStop stops a game that only has disconnected bodies, and is idempotent", async () => {
        const { game } = await createGame("br_main");
        join(game, "p1");
        join(game, "p2");
        game.step(6);
        game.handleSocketClose("p1");
        game.handleSocketClose("p2");
        expect(game.getOccupancy().disconnectedBodies).toBe(2);

        expect(game.requestStop("abandoned_empty_match")).toBe(true);
        expect(game.stopped).toBe(true);
        expect(game.requestStop("again")).toBe(true);
    });

    test("game end with no winner left doesn't throw", async () => {
        const { game } = await createGame("main", TeamMode.Duo);
        game.started = true;
        expect(() => game.modeManager.handleGameEnd()).not.toThrow();
    });
});

describe("reconnect", () => {
    test("disconnected battle royale body can be reclaimed with the same token", async () => {
        const { game, sent } = await createGame("br_main");
        const { token, player } = join(game, "old");
        join(game, "other");
        game.step(6);
        player.health = 42;

        game.handleSocketClose("old");
        expect(player.disconnected).toBe(true);
        const playerCount = game.playerBarn.players.length;

        const res = rejoin(game, "new", token);
        expect(res).toBe(player);
        expect(player.disconnected).toBe(false);
        expect(player.socketId).toBe("new");
        expect(player.health).toBe(42);
        expect(game.playerBarn.players.length).toBe(playerCount);
        expect(game.playerBarn.socketIdToPlayer.has("old")).toBe(false);

        sent.length = 0;
        game.netSync();
        const msg = sent.find((m) => m.socketId === "new");
        expect(msg).toBeDefined();
        const stream = new net.MsgStream(msg!.data.buffer as ArrayBuffer);
        expect(stream.deserializeMsgType()).toBe(net.MsgType.Joined);
    });

    test("a newer socket takes over a half open connection", async () => {
        const { game, closed } = await createGame("br_main");
        const { token, player } = join(game, "old");
        expect(rejoin(game, "new", token)).toBe(player);
        expect(
            closed.some(
                (c) => c.socketId === "old" && c.logReason === "replaced_by_reconnect",
            ),
        ).toBe(true);
        game.handleSocketClose("old");
        expect(player.disconnected).toBe(false);
    });

    test("kicked players can't reconnect", async () => {
        const { game, closed } = await createGame("br_main");
        const { token, player } = join(game, "old");
        join(game, "other");
        game.step(6);
        player.disconnect(undefined, "spectate_spam");
        game.handleSocketClose("old");

        expect(rejoin(game, "new", token)).toBeUndefined();
        const rejected = closed.find((c) => c.socketId === "new");
        expect(rejected?.logReason).toBe("join_token_invalid");
        expect(rejected?.reason).toBe("index-host-closed");
    });

    test("reconnect is refused after the grace period", async () => {
        const { game } = await createGame("br_main");
        const { token, player } = join(game, "old");
        join(game, "other");
        game.step(6);
        game.handleSocketClose("old");
        player.disconnectedAt = Date.now() - Config.gameLifecycle.reconnectGraceMs - 1;
        expect(rejoin(game, "new", token)).toBeUndefined();
    });

    test("deathmatch keeps removing disconnected players (no reconnect into removed bodies)", async () => {
        const { game } = await createGame("halloween", TeamMode.Solo);
        const { token, player } = join(game, "old");
        game.handleSocketClose("old");
        expect(game.playerBarn.players.includes(player)).toBe(false);
        expect(rejoin(game, "new", token)).toBeUndefined();
    });
});
