import NanoTimer from "nanotimer";
import { platform } from "os";
import { PerformanceObserver } from "perf_hooks";
import { Config } from "../config";
import { DurationStats, EventLoopDelay, roundSnapshot } from "../utils/metrics";
import { logErrorToWebhook } from "../utils/serverHelpers";
import { type ProcessMsg, ProcessMsgType, type WorkerStats } from "../utils/types";
import { Game } from "./game";

let game: Game | undefined;

let ipcSendBacklogged = 0;

function sendMsg(msg: ProcessMsg) {
    if (!process.send!(msg)) {
        ipcSendBacklogged++;
    }
}

process.on("disconnect", () => {
    process.exit();
});

const socketMsgs: Array<{
    socketId: string;
    data: Uint8Array;
    ip: string;
}> = [];

let lastMsgTime = Date.now();

process.on("message", async (msg: ProcessMsg) => {
    if (msg.type) {
        lastMsgTime = Date.now();
    }

    if (msg.type === ProcessMsgType.Create && !game) {
        game = new Game(
            msg.id,
            msg.config,
            (id, data) => {
                socketMsgs.push({
                    socketId: id,
                    data,
                    ip: "",
                });
            },
            (id, reason, logReason) => {
                sendMsg({
                    type: ProcessMsgType.SocketClose,
                    socketId: id,
                    reason,
                    logReason,
                });
            },
            (msg) => {
                sendMsg(msg);
                if (msg.stopped) {
                    game = undefined;
                    lastUpdateAt = 0;
                }
            },
        );

        await game.init();
        sendMsg({
            type: ProcessMsgType.Created,
        });
    }

    if (msg.type === ProcessMsgType.Stop) {
        const stopped = game ? game.requestStop(msg.reason) : true;
        sendMsg({
            type: ProcessMsgType.StopResult,
            seq: msg.seq,
            stopped,
        });
        return;
    }

    if (!game) return;

    switch (msg.type) {
        case ProcessMsgType.AddJoinToken:
            game.addJoinTokens(msg.tokens, msg.autoFill, msg.seq);
            break;
        case ProcessMsgType.KickPlayerByIP:
            game.kickPlayerByIP(msg.encodedIp);
            break;
        case ProcessMsgType.SocketMsg:
            const sMsg = msg.msgs[0];
            game.handleMsg(sMsg.data as ArrayBuffer, sMsg.socketId, sMsg.ip);
            break;
        case ProcessMsgType.SocketClose:
            game.handleSocketClose(msg.socketId);
            break;
    }
});

const STATS_INTERVAL = 5000;
const updateInterval = 1000 / Config.gameTps;
const updateLateness = new DurationStats(1024);
const eventLoopDelay = new EventLoopDelay();
let lastUpdateAt = 0;
let lastStatsAt = Date.now();
let socketMsgsSent = 0;
let socketBytesSent = 0;
const gcStats = { count: 0, totalMs: 0, maxMs: 0 };

try {
    new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
            gcStats.count++;
            gcStats.totalMs += entry.duration;
            if (entry.duration > gcStats.maxMs) gcStats.maxMs = entry.duration;
        }
    }).observe({ entryTypes: ["gc"] });
} catch {}

function collectStats(): WorkerStats {
    const now = Date.now();
    const mem = process.memoryUsage();
    const stats: WorkerStats = {
        windowMs: now - lastStatsAt,
        update: roundSnapshot(
            game?.updateStats.snapshot() ?? new DurationStats(1).snapshot(),
        ),
        netSync: roundSnapshot(
            game?.netSyncStats.snapshot() ?? new DurationStats(1).snapshot(),
        ),
        updateLateness: roundSnapshot(updateLateness.snapshot()),
        eventLoopDelay: eventLoopDelay.snapshotAndReset(),
        gc: {
            count: gcStats.count,
            totalMs: Math.round(gcStats.totalMs * 100) / 100,
            maxMs: Math.round(gcStats.maxMs * 100) / 100,
        },
        slowestSections: game?.profiler.getWindowMax() ?? [],
        ipcSendBacklogged,
        socketMsgsSent,
        socketBytesSent,
        rssMb: Math.round(mem.rss / 1048576),
        heapUsedMb: Math.round(mem.heapUsed / 1048576),
    };

    lastStatsAt = now;
    game?.updateStats.reset();
    game?.netSyncStats.reset();
    game?.profiler.resetWindow();
    updateLateness.reset();
    gcStats.count = gcStats.totalMs = gcStats.maxMs = 0;
    ipcSendBacklogged = 0;
    socketMsgsSent = socketBytesSent = 0;
    return stats;
}

setInterval(() => {
    if (Date.now() - lastMsgTime > 60000) {
        console.log("Game process has not received a message in 60 seconds, exiting");
        process.exit();
    }

    sendMsg({
        type: ProcessMsgType.KeepAlive,
        stats: collectStats(),
    });
    game?.updateData();
}, STATS_INTERVAL);

function update() {
    if (!game) return;
    const now = performance.now();
    if (lastUpdateAt) {
        updateLateness.add(Math.max(0, now - lastUpdateAt - updateInterval));
    }
    lastUpdateAt = now;
    game.update();
}

function netSync() {
    game?.netSync();
    if (!socketMsgs.length) return;
    socketMsgsSent += socketMsgs.length;
    for (let i = 0; i < socketMsgs.length; i++) {
        socketBytesSent += socketMsgs[i].data.byteLength;
    }
    sendMsg({
        type: ProcessMsgType.SocketMsg,
        msgs: socketMsgs,
    });
    socketMsgs.length = 0;
}

// setInterval on windows sucks
// and doesn't give accurate timings
if (platform() === "win32") {
    new NanoTimer().setInterval(update, "", `${updateInterval}m`);
    new NanoTimer().setInterval(netSync, "", `${1000 / Config.netSyncTps}m`);
} else {
    setInterval(update, updateInterval);
    setInterval(netSync, 1000 / Config.netSyncTps);
}

process.on("uncaughtException", async (err) => {
    console.error(err);
    game = undefined;

    await logErrorToWebhook("server", "Game process error", err);

    process.exit(1);
});
