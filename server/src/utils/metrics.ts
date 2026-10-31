import { type IntervalHistogram, monitorEventLoopDelay } from "node:perf_hooks";

export interface DurationSnapshot {
    count: number;
    mean: number;
    p50: number;
    p95: number;
    p99: number;
    max: number;
}

export class DurationStats {
    private readonly samples: Float64Array;
    private next = 0;
    private filled = 0;
    count = 0;
    sum = 0;
    max = 0;

    constructor(readonly capacity = 1024) {
        this.samples = new Float64Array(capacity);
    }

    add(ms: number) {
        this.samples[this.next] = ms;
        this.next = (this.next + 1) % this.capacity;
        if (this.filled < this.capacity) this.filled++;
        this.count++;
        this.sum += ms;
        if (ms > this.max) this.max = ms;
    }

    snapshot(): DurationSnapshot {
        if (this.filled === 0) {
            return { count: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0 };
        }
        const sorted = this.samples.slice(0, this.filled).sort();
        const pct = (p: number) =>
            sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
        return {
            count: this.count,
            mean: this.sum / this.count,
            p50: pct(0.5),
            p95: pct(0.95),
            p99: pct(0.99),
            max: this.max,
        };
    }

    reset() {
        this.next = 0;
        this.filled = 0;
        this.count = 0;
        this.sum = 0;
        this.max = 0;
    }
}

export function roundSnapshot(s: DurationSnapshot): DurationSnapshot {
    const r = (n: number) => Math.round(n * 100) / 100;
    return {
        count: s.count,
        mean: r(s.mean),
        p50: r(s.p50),
        p95: r(s.p95),
        p99: r(s.p99),
        max: r(s.max),
    };
}

export class EventLoopDelay {
    private readonly histogram: IntervalHistogram;

    constructor(readonly resolutionMs = 20) {
        this.histogram = monitorEventLoopDelay({ resolution: resolutionMs });
        this.histogram.enable();
    }

    snapshotAndReset(reset = true): { mean: number; p99: number; max: number } {
        const h = this.histogram;
        const toMs = (ns: number) =>
            Math.max(0, Math.round((ns / 1e6 - this.resolutionMs) * 100) / 100);
        const res = {
            mean: Number.isFinite(h.mean) ? toMs(h.mean) : 0,
            p99: toMs(h.percentile(99)),
            max: toMs(h.max),
        };
        if (reset) h.reset();
        return res;
    }
}

export class RateLimitedLog {
    private readonly last = new Map<string, { time: number; suppressed: number }>();

    constructor(readonly intervalMs: number) {}

    shouldLog(key: string, now = Date.now()): number {
        const entry = this.last.get(key);
        if (!entry) {
            this.last.set(key, { time: now, suppressed: 0 });
            return 0;
        }
        if (now - entry.time < this.intervalMs) {
            entry.suppressed++;
            return -1;
        }
        const suppressed = entry.suppressed;
        entry.time = now;
        entry.suppressed = 0;
        return suppressed;
    }
}

export class ReasonCounter {
    readonly counts = new Map<string, number>();

    constructor(readonly maxKeys = 64) {}

    inc(reason: string, by = 1) {
        if (!this.counts.has(reason) && this.counts.size >= this.maxKeys) {
            reason = "other";
        }
        this.counts.set(reason, (this.counts.get(reason) ?? 0) + by);
    }

    toJSON(): Record<string, number> {
        return Object.fromEntries(this.counts);
    }
}
