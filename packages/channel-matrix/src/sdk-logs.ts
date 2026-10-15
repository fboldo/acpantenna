import { logger } from "matrix-js-sdk/lib/logger.js";

/**
 * matrix-js-sdk logs everything down to debug to the console, some of it to
 * stdout. Imported before the SDK itself (its modules make their child
 * loggers as they load, copying the root's method factory), this routes it
 * all through `sink` instead: errors by default, everything with
 * ACPANTENNA_MATRIX_DEBUG=1.
 */
type Sink = (level: string, args: unknown[]) => void;

let sink: Sink = () => undefined;
const verbose = process.env.ACPANTENNA_MATRIX_DEBUG === "1";

export function setSdkLogSink(next: Sink): void {
	sink = next;
}

const root = logger as unknown as {
	methodFactory: (method: string) => (...args: unknown[]) => void;
	rebuild?: () => void;
	setLevel: (level: number, persist?: boolean) => void;
};

root.methodFactory = (method) =>
	function (this: { prefix?: string }, ...args: unknown[]) {
		if (verbose || method === "error") {
			sink(method, this?.prefix ? [this.prefix, ...args] : args);
		}
	};
root.rebuild?.();
