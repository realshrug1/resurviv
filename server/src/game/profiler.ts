interface Sample {
    name: string;
    started: number;
    ended: number;
    took: number;
    windowMax: number;
}

export class Profiler {
    samples: Record<string, Sample> = {};
    stack: Sample[] = [];

    addSample(name: string) {
        let sample = this.samples[name];
        if (!sample) {
            sample = this.samples[name] = {
                name,
                started: 0,
                ended: 0,
                took: 0,
                windowMax: 0,
            };
        }
        sample.started = performance.now();
        this.stack.push(sample);
    }

    endSample() {
        const now = performance.now();
        const last = this.stack.pop()!;
        last.ended = now;
        last.took = now - last.started;
        if (last.took > last.windowMax) last.windowMax = last.took;
    }

    getStats() {
        return Object.values(this.samples)
            .filter((s) => s.ended >= s.started)
            .sort((b, a) => {
                return a.took - b.took;
            })
            .map((s) => {
                return `${`${s.took.toFixed(2)}ms`.padEnd(8)} ${s.name}`;
            })
            .join("\n");
    }

    getWindowMax(limit = 5) {
        return Object.values(this.samples)
            .sort((a, b) => b.windowMax - a.windowMax)
            .slice(0, limit)
            .map((s) => ({ name: s.name, maxMs: Math.round(s.windowMax * 100) / 100 }));
    }

    resetWindow() {
        for (const name in this.samples) {
            this.samples[name].windowMax = 0;
        }
    }

    flush() {
        for (const name in this.samples) {
            const s = this.samples[name];
            s.took = 0;
            s.started = s.ended = 0;
        }
        this.stack.length = 0;
    }
}
