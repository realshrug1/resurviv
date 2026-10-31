import type { ConfigType } from "../../../configType";
import type { GameOccupancy } from "../utils/types";

export type WorkerState =
    | "creating"
    | "waiting"
    | "running"
    | "stopping"
    | "stopped"
    | "terminating";

export type LifecycleConfig = ConfigType["gameLifecycle"];

export interface RoomSnapshot {
    state: WorkerState;
    isPublic: boolean;
    openSockets: number;
    everHadSocket: boolean;
    emptySince: number;
    lastJoinTokenTime: number;
    occupancy?: GameOccupancy;
}

export function getAbandonReason(
    room: RoomSnapshot,
    now: number,
    cfg: LifecycleConfig,
): string | undefined {
    if (room.state !== "waiting" && room.state !== "running") return undefined;
    if (room.openSockets > 0) return undefined;

    const occ = room.occupancy;
    if (!occ) return undefined;
    if (occ.connectedPlayers > 0 || occ.connectedSpectators > 0) return undefined;
    if (occ.pendingJoinTokens > 0) return undefined;
    if (occ.over) return undefined;
    if (now - room.lastJoinTokenTime < cfg.joinTokenGraceMs) return undefined;

    const emptyFor = now - room.emptySince;

    if (room.isPublic && !occ.started) {
        return emptyFor >= cfg.idlePublicRoomTimeoutMs ? "idle_public_room" : undefined;
    }
    if (!room.everHadSocket) {
        return emptyFor >= cfg.abandonedRoomTimeoutMs
            ? "abandoned_never_joined"
            : undefined;
    }
    if (emptyFor >= cfg.emptyRoomTimeoutMs) {
        return occ.started ? "abandoned_empty_match" : "abandoned_empty_room";
    }
    return undefined;
}

export function selectIdleWorkersToKill<T extends { stoppedTime: number }>(
    stopped: T[],
    now: number,
    cfg: LifecycleConfig,
): Array<{ worker: T; reason: string }> {
    const res: Array<{ worker: T; reason: string }> = [];
    const newestFirst = [...stopped].sort((a, b) => b.stoppedTime - a.stoppedTime);
    for (let i = 0; i < newestFirst.length; i++) {
        const worker = newestFirst[i];
        if (now - worker.stoppedTime > cfg.stoppedWorkerTtlMs) {
            res.push({ worker, reason: "stopped_ttl" });
        } else if (i >= cfg.maxIdleWorkers) {
            res.push({ worker, reason: "too_many_idle" });
        }
    }
    return res;
}

export class SlotReservations {
    private pending: Array<{ seq: number; slots: number }> = [];
    private nextSeq = 1;

    reserve(slots: number): number {
        const seq = this.nextSeq++;
        this.pending.push({ seq, slots });
        return seq;
    }

    ack(seq: number) {
        let i = 0;
        while (i < this.pending.length && this.pending[i].seq <= seq) i++;
        if (i) this.pending.splice(0, i);
    }

    get pendingSlots(): number {
        let total = 0;
        for (const p of this.pending) total += p.slots;
        return total;
    }

    clear() {
        this.pending.length = 0;
    }
}
