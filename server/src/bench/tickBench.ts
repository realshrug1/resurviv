import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import type { MapDefs } from "../../../shared/defs/mapDefs";
import type { TeamMode } from "../../../shared/gameConfig";
import * as net from "../../../shared/net/net";
import { v2 } from "../../../shared/utils/v2";
import { Config } from "../config";
import { Game } from "../game/game";
import type { Player } from "../game/objects/player";
import { DurationStats } from "../utils/metrics";

const { values: args } = parseArgs({
    options: {
        map: { type: "string", default: "halloween" },
        team: { type: "string", default: "2" },
        players: { type: "string", default: "40" },
        seconds: { type: "string", default: "60" },
        tps: { type: "string", default: String(Config.gameTps) },
        netTps: { type: "string", default: String(Config.netSyncTps) },
        seed: { type: "string", default: "1" },
    },
});

Config.logging.infoLogs = false;
Config.logging.debugLogs = false;
if (Config.webhooks) Config.webhooks.mapGeneration = "";
Config.database.enabled = false;
let seed = Number(args.seed) >>> 0 || 1;
Math.random = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
};

const tps = Number(args.tps);
const netTps = Number(args.netTps);
const dt = 1 / tps;
const totalTicks = Math.round(Number(args.seconds) * tps);
const playerCount = Number(args.players);

async function main() {
    const initStart = performance.now();
    const game = new Game(
        "bench",
        {
            mapName: args.map as keyof typeof MapDefs,
            teamMode: Number(args.team) as TeamMode,
        },
        () => {},
        () => {},
        () => {},
    );
    await game.init();
    const initMs = performance.now() - initStart;

    const players: Player[] = [];
    for (let i = 0; i < playerCount; i++) {
        const group = game.isTeamMode ? game.playerBarn.addGroup(false) : undefined;
        const pos = game.playerBarn.getSpawnPos(group);
        players.push(game.playerBarn.addTestPlayer({ group, pos }));
    }

    const update = new DurationStats(8192);
    const netSync = new DurationStats(8192);
    const sections = new Map<string, DurationStats>();

    let netAccum = 0;
    const input = new net.InputMsg();
    const wallStart = performance.now();
    for (let tick = 0; tick < totalTicks; tick++) {
        if (tick % Math.max(1, Math.round(tps / 10)) === 0) {
            for (const p of players) {
                if (p.dead || p.destroyed) continue;
                input.moveLeft = Math.random() < 0.3;
                input.moveRight = !input.moveLeft && Math.random() < 0.4;
                input.moveUp = Math.random() < 0.3;
                input.moveDown = !input.moveUp && Math.random() < 0.4;
                input.toMouseDir = v2.normalize(
                    v2.create(Math.random() - 0.5, Math.random() - 0.5),
                );
                input.toMouseLen = 10;
                input.shootStart = Math.random() < 0.3;
                input.shootHold = input.shootStart;
                input.seq = tick % 256;
                p.handleInput(input);
            }
        }

        const t0 = performance.now();
        game.update(dt);
        update.add(performance.now() - t0);
        for (const sample of Object.values(game.profiler.samples)) {
            let s = sections.get(sample.name);
            if (!s) {
                s = new DurationStats(8192);
                sections.set(sample.name, s);
            }
            s.add(sample.took);
        }

        netAccum += dt;
        if (netAccum >= 1 / netTps) {
            netAccum -= 1 / netTps;
            const t1 = performance.now();
            game.netSync();
            netSync.add(performance.now() - t1);
        }
        if (game.stopped) break;
    }
    const wallMs = performance.now() - wallStart;

    const fmt = (s: DurationStats) => {
        const x = s.snapshot();
        return `n=${x.count} p50=${x.p50.toFixed(3)} p95=${x.p95.toFixed(3)} p99=${x.p99.toFixed(3)} max=${x.max.toFixed(2)} mean=${x.mean.toFixed(3)}`;
    };

    const mem = process.memoryUsage();
    console.log(
        JSON.stringify({
            map: args.map,
            teamMode: args.team,
            players: playerCount,
            tps,
            netTps,
            simulatedSeconds: Number(args.seconds),
            initMs: Math.round(initMs),
            wallMs: Math.round(wallMs),
            alive: game.playerBarn.livingPlayers.length,
            loot: game.lootBarn.loots.length,
            objects: game.objectRegister.idToObj.filter(Boolean).length,
            rssMb: Math.round(mem.rss / 1048576),
            heapUsedMb: Math.round(mem.heapUsed / 1048576),
            stopped: game.stopped,
        }),
    );
    console.log(`update   ${fmt(update)}`);
    console.log(`netSync  ${fmt(netSync)}`);
    const cpuPerSec = update.snapshot().mean * tps + netSync.snapshot().mean * netTps;
    console.log(`cpu ms per wall second (one core): ${cpuPerSec.toFixed(1)}`);
    const sorted = [...sections.entries()].sort(
        (a, b) => b[1].snapshot().mean - a[1].snapshot().mean,
    );
    for (const [name, s] of sorted.slice(0, 10)) {
        console.log(`  ${name.padEnd(14)} ${fmt(s)}`);
    }
}

main().then(() => process.exit(0));
