import type { WebSocket } from "uWebSockets.js";
import { execSync } from "node:child_process";
import fs from "node:fs";
import { parseArgs } from "node:util";
import { GameConfig, TeamMode } from "../../../shared/gameConfig";
import * as net from "../../../shared/net/net";
import { v2 } from "../../../shared/utils/v2";
import { Config } from "../config";
import { GameProcessManager } from "../game/gameProcessManager";
import type { FindGamePrivateBody, GameSocketData } from "../utils/types";

const { values: args } = parseArgs({
    options: {
        seconds: { type: "string", default: "90" },
        json: { type: "string" },
        bots: { type: "string", default: "4" },
        publicGames: { type: "string", default: "3" },
    },
});

const DURATION = Number(args.seconds) * 1000;
Object.assign(Config.gameLifecycle, {
    abandonedRoomTimeoutMs: 10_000,
    emptyRoomTimeoutMs: 10_000,
    idlePublicRoomTimeoutMs: 15_000,
    joinTokenGraceMs: 5_000,
    stoppedWorkerTtlMs: 10_000,
    maxIdleWorkers: 1,
});
Config.gameNetwork.maxBackpressureBytes = 32 * 1024;
Config.logging.infoLogs = !!process.env.VERBOSE;
Config.logging.debugLogs = false;

const manager = new GameProcessManager();
const lostGameDataExisted = fs.existsSync("lost_game_data");

let socketCounter = 0;
const SEND_SUCCESS = 1;
const SEND_DROPPED = 2;

class FakeSocket {
    data: GameSocketData;
    bytesReceived = 0;
    msgsReceived = 0;
    gotJoined = false;
    gotDisconnectReason = "";
    closedByServer = false;
    onClosed?: () => void;
    stalled = false;
    buffered = 0;

    constructor(gameId: string) {
        this.data = {
            gameId,
            id: `sock-${socketCounter++}`,
            closed: false,
            rateLimit: {},
            ip: "127.0.0.1",
            disconnectReason: "",
        };
    }

    getUserData() {
        return this.data;
    }

    send(msg: ArrayBuffer | Uint8Array) {
        if (this.data.closed) return SEND_DROPPED;
        const limit = Config.gameNetwork.maxBackpressureBytes;
        if (this.stalled) {
            if (this.buffered > limit) return SEND_DROPPED;
            this.buffered += msg.byteLength;
            return SEND_SUCCESS;
        }
        this.bytesReceived += msg.byteLength;
        this.msgsReceived++;
        const buf = msg instanceof Uint8Array ? msg : new Uint8Array(msg);
        const stream = new net.MsgStream(
            buf.buffer.slice(
                buf.byteOffset,
                buf.byteOffset + buf.byteLength,
            ) as ArrayBuffer,
        );
        while (true) {
            const type = stream.deserializeMsgType();
            if (type === net.MsgType.None) break;
            if (type === net.MsgType.Joined) this.gotJoined = true;
            if (type === net.MsgType.Disconnect) {
                const m = new net.DisconnectMsg();
                m.deserialize(stream.getStream());
                this.gotDisconnectReason = m.reason;
            }
            break;
        }
        return SEND_SUCCESS;
    }

    getBufferedAmount() {
        return this.buffered;
    }

    close() {
        if (this.data.closed) return;
        this.closedByServer = true;
        this.finishClose();
    }

    drop() {
        if (this.data.closed) return;
        this.finishClose();
    }

    private finishClose() {
        this.data.closed = true;
        this.data.closeReason ??= "client_closed_1006";
        manager.onClose(this.data.id);
        this.onClosed?.();
    }

    end() {
        this.close();
    }
}

function asWs(s: FakeSocket) {
    return s as unknown as WebSocket<GameSocketData>;
}

let tokenCounter = 0;
const allBots: Bot[] = [];

class Bot {
    socket?: FakeSocket;
    token = "";
    gameId = "";
    inputTimer?: ReturnType<typeof setInterval>;
    shouldStay = false;
    reconnects = 0;
    unexpectedClose = "";

    constructor(readonly name: string) {
        allBots.push(this);
    }

    async find(body: Partial<FindGamePrivateBody>, opts: { spectator?: boolean } = {}) {
        this.token = `load-${tokenCounter++}`;
        const res = await manager.findGame({
            region: Config.gameServer.thisRegion,
            version: GameConfig.protocolVersion,
            autoFill: false,
            mapName: "halloween",
            teamMode: TeamMode.Solo,
            ...body,
            playerData: [
                {
                    token: this.token,
                    userId: null,
                    ip: "127.0.0.1",
                    spectator: opts.spectator,
                },
            ],
        });
        this.gameId = res.gameId;
        return res;
    }

    connect() {
        const socket = new FakeSocket(this.gameId);
        this.socket = socket;
        manager.onOpen(socket.data.id, asWs(socket));
        if (socket.data.closed) return;

        const join = new net.JoinMsg();
        join.protocol = GameConfig.protocolVersion;
        join.matchPriv = this.token;
        join.name = this.name;
        this.sendMsg(net.MsgType.Join, join, 8192);

        socket.onClosed = () => {
            clearInterval(this.inputTimer);
            if (this.shouldStay && socket.closedByServer) {
                this.unexpectedClose = socket.data.closeReason ?? "unknown";
            }
        };

        let seq = 0;
        this.inputTimer = setInterval(() => {
            const input = new net.InputMsg();
            input.seq = seq++ % 256;
            input.moveLeft = Math.random() < 0.5;
            input.moveUp = Math.random() < 0.5;
            input.toMouseDir = v2.normalize(
                v2.create(Math.random() - 0.5, Math.random() - 0.5),
            );
            input.toMouseLen = 5;
            this.sendMsg(net.MsgType.Input, input, 128);
        }, 100);
    }

    sendMsg(type: net.MsgType, msg: net.Msg, size: number) {
        if (!this.socket || this.socket.data.closed) return;
        const stream = new net.MsgStream(new ArrayBuffer(size));
        stream.serializeMsg(type, msg);
        const u8 = stream.getBuffer();
        manager.onMsg(
            this.socket.data.id,
            u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer,
        );
    }

    leave() {
        clearInterval(this.inputTimer);
        this.socket?.drop();
    }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function sampleChildRss(pids: number[]): number {
    if (!pids.length) return 0;
    try {
        if (process.platform === "win32") {
            const out = execSync(
                `powershell -NoProfile -Command "(Get-Process -Id ${pids.join(",")} -ErrorAction SilentlyContinue | Measure-Object WorkingSet64 -Sum).Sum"`,
            )
                .toString()
                .trim();
            return Math.round(Number(out || 0) / 1048576);
        }
        const out = execSync(`ps -o rss= -p ${pids.join(",")}`).toString();
        return Math.round(
            out
                .split("\n")
                .filter(Boolean)
                .reduce((a, b) => a + Number(b), 0) / 1024,
        );
    } catch {
        return 0;
    }
}

const timeline: Array<{
    t: number;
    workers: number;
    byState: Record<string, number>;
    terminating: number;
    sockets: number;
    childRssMb: number;
}> = [];
const perf = {
    updateP99: [] as number[],
    updateMax: [] as number[],
    netSyncP99: [] as number[],
    netSyncMax: [] as number[],
    latenessMax: [] as number[],
    workerRssMb: [] as number[],
};
const start = Date.now();

const sampler = setInterval(() => {
    const m = manager.getMetrics(false);
    for (const g of m.games) {
        const s = g.stats;
        if (!s || !s.update.count) continue;
        perf.updateP99.push(s.update.p99);
        perf.updateMax.push(s.update.max);
        perf.netSyncP99.push(s.netSync.p99);
        perf.netSyncMax.push(s.netSync.max);
        perf.latenessMax.push(s.updateLateness.max);
        perf.workerRssMb.push(s.rssMb);
    }
    timeline.push({
        t: Math.round((Date.now() - start) / 1000),
        workers: m.workers.total,
        byState: m.workers.byState,
        terminating: m.workers.terminating,
        sockets: m.sockets.open,
        childRssMb: sampleChildRss(
            manager.processes.map((p) => p.process.pid!).filter(Boolean),
        ),
    });
}, 5000);

async function main() {
    const log = (...a: unknown[]) =>
        console.log(`[${((Date.now() - start) / 1000).toFixed(1)}s]`, ...a);
    const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
    const check = (name: string, ok: boolean, detail?: string) => {
        checks.push({ name, ok, detail });
        log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
    };

    const waiting = new Bot("waiting");
    waiting.shouldStay = true;
    await waiting.find({
        arenaPrivate: true,
        groupHash: "LOBBY-WAIT",
        mapName: "br_main",
    });
    waiting.connect();

    const active: Bot[] = [];
    for (let i = 0; i < Number(args.bots); i++) {
        const b = new Bot(`active-${i}`);
        b.shouldStay = true;
        await b.find({
            arenaPrivate: true,
            groupHash: "LOBBY-ACTIVE",
            mapName: "br_main",
        });
        b.connect();
        active.push(b);
    }
    const spectator = new Bot("spectator");
    spectator.shouldStay = true;
    await spectator.find(
        { arenaPrivate: true, groupHash: "LOBBY-ACTIVE", mapName: "br_main" },
        { spectator: true },
    );
    spectator.connect();
    const publicBots: Bot[] = [];
    for (let g = 0; g < Number(args.publicGames); g++) {
        const teamMode = [TeamMode.Solo, TeamMode.Duo, TeamMode.Squad][g % 3];
        for (let i = 0; i < 2; i++) {
            const b = new Bot(`public-${g}-${i}`);
            await b.find({ teamMode });
            b.connect();
            publicBots.push(b);
        }
    }
    const slow = new Bot("slow");
    await slow.find({ arenaPrivate: true, groupHash: "LOBBY-SLOW", mapName: "br_main" });
    slow.connect();
    slow.socket!.stalled = true;

    const abandonedIds = new Set<string>();
    const abandonLoop = (async () => {
        for (let i = 0; i < 6; i++) {
            const b = new Bot(`abandon-${i}`);
            await b.find({ arenaPrivate: true, groupHash: `LOBBY-ABANDON-${i}` });
            abandonedIds.add(b.gameId);
            await sleep(2000);
        }
    })();

    const joinLeave = (async () => {
        for (let i = 0; i < 4; i++) {
            const b = new Bot(`joinleave-${i}`);
            await b.find({
                arenaPrivate: true,
                groupHash: `LOBBY-JL-${i}`,
                mapName: "main",
            });
            b.connect();
            await sleep(1500);
            b.leave();
            await sleep(1000);
        }
    })();

    await Promise.all([abandonLoop, joinLeave]);
    await sleep(7000);
    const reconnecting = active[0];
    const oldSocket = reconnecting.socket!;
    reconnecting.shouldStay = false;
    reconnecting.leave();
    await sleep(1000);
    reconnecting.connect();
    reconnecting.shouldStay = true;
    await sleep(1500);
    check(
        "reconnect with same token restores the session",
        !!reconnecting.socket?.gotJoined && !reconnecting.socket.data.closed,
        `old socket closed=${oldSocket.data.closed}, new joined=${reconnecting.socket?.gotJoined}`,
    );
    const activeProc = manager.processById.get(reconnecting.gameId);
    check(
        "reconnect didn't duplicate the player",
        activeProc?.occupancy?.connectedPlayers === active.length,
        `connectedPlayers=${activeProc?.occupancy?.connectedPlayers}`,
    );
    const bogus = new Bot("bogus");
    bogus.gameId = reconnecting.gameId;
    bogus.token = "not-a-real-token";
    bogus.connect();
    await sleep(1000);
    check(
        "invalid token is rejected with a reason (no retry)",
        bogus.socket!.data.closed &&
            bogus.socket!.gotDisconnectReason === "index-host-closed",
        `reason=${bogus.socket!.gotDisconnectReason}`,
    );

    for (const b of publicBots) b.leave();

    log("waiting for abandoned rooms to be cleaned up...");
    const waitUntil = Date.now() + Math.max(0, DURATION - (Date.now() - start) - 20_000);
    while (Date.now() < waitUntil) await sleep(1000);

    const createdBefore = { ...manager.creations.toJSON() };
    const transition = new Bot("transition");
    await transition.find({ arenaPrivate: true, groupHash: "LOBBY-NEXT" });
    transition.connect();
    await sleep(1500);
    const createdAfter = manager.creations.toJSON();
    check(
        "new game after cleanup works",
        !!transition.socket?.gotJoined,
        `created ${JSON.stringify(createdBefore)} -> ${JSON.stringify(createdAfter)}`,
    );
    transition.leave();
    await sleep(15_000);
    const m = manager.getMetrics(false);
    const liveIds = new Set(m.games.map((g) => g.id));
    const leakedAbandoned = [...abandonedIds].filter((id) =>
        liveIds.has(id.substring(0, 8)),
    );
    check(
        "abandoned rooms were stopped",
        leakedAbandoned.length === 0,
        `${leakedAbandoned.length} still alive`,
    );

    const expectedLive = 2;
    const busy = m.games.filter((g) => g.state !== "stopped").length;
    check(
        "worker count settled",
        busy === expectedLive &&
            m.workers.total <= expectedLive + Config.gameLifecycle.maxIdleWorkers,
        `busy=${busy} total=${m.workers.total} ${JSON.stringify(m.workers.byState)}`,
    );
    check(
        "no terminating process left behind",
        manager.terminatingProcesses.size === 0,
        `terminating=${manager.terminatingProcesses.size}`,
    );

    const wronglyRemoved = allBots.filter((b) => b.shouldStay && b.unexpectedClose);
    check(
        "connected players weren't removed",
        wronglyRemoved.length === 0,
        wronglyRemoved.map((b) => `${b.name}:${b.unexpectedClose}`).join(", "),
    );
    check(
        "slow client was disconnected instead of silently desynced",
        !!slow.socket?.closedByServer &&
            slow.socket.data.closeReason === "backpressure_limit",
        `closeReason=${slow.socket?.data.closeReason}`,
    );

    const pct = (arr: number[], p: number) => {
        if (!arr.length) return 0;
        const s = [...arr].sort((a, b) => a - b);
        return s[Math.min(s.length - 1, Math.floor(p * s.length))];
    };
    const summary = {
        durationS: Math.round((Date.now() - start) / 1000),
        checks,
        final: {
            workers: m.workers,
            sockets: m.sockets.open,
            counters: m.counters,
        },
        perf: {
            updateP99_p50: pct(perf.updateP99, 0.5),
            updateP99_max: pct(perf.updateP99, 1),
            updateMax_max: pct(perf.updateMax, 1),
            netSyncP99_p50: pct(perf.netSyncP99, 0.5),
            netSyncMax_max: pct(perf.netSyncMax, 1),
            updateLatenessMax_p50: pct(perf.latenessMax, 0.5),
            updateLatenessMax_max: pct(perf.latenessMax, 1),
            workerRssMb_p50: pct(perf.workerRssMb, 0.5),
            workerRssMb_max: pct(perf.workerRssMb, 1),
        },
        timeline,
    };
    console.log(JSON.stringify(summary, null, 2));
    if (args.json) fs.writeFileSync(args.json, JSON.stringify(summary, null, 2));

    clearInterval(sampler);
    for (const b of allBots) b.leave();
    manager.commitProcessGenocide();
    await sleep(1500);
    if (!lostGameDataExisted && fs.existsSync("lost_game_data")) {
        fs.rmSync("lost_game_data", { recursive: true });
    }
    process.exit(checks.every((c) => c.ok) ? 0 : 1);
}

main().catch((err) => {
    console.error(err);
    manager.commitProcessGenocide();
    process.exit(1);
});
