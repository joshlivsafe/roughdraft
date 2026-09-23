import fs from "node:fs";
import path from "node:path";

export interface ReviewCompletedEventInput {
  documentPath: string;
  projectPath: string;
  relativePath: string;
  version: string;
  summary: {
    comments: number;
    replies: number;
    suggestions: number;
    unresolved: number;
  };
  overallComment?: string;
}

export interface ReviewCompletedEvent extends ReviewCompletedEventInput {
  type: "review.completed";
  sequence: number;
  createdAt: string;
}

export interface WaitForReviewEventsOptions {
  documentPath?: string;
  afterSequence?: number;
  timeoutMs?: number;
  batchWindowMs?: number;
}

export interface WaitForReviewEventsResult {
  events: ReviewCompletedEvent[];
  timedOut: boolean;
  nextSequence: number;
}

interface Waiter {
  options: NormalizedWaitOptions;
  resolve: (result: WaitForReviewEventsResult) => void;
  timeout: NodeJS.Timeout | null;
  batchTimeout: NodeJS.Timeout | null;
}

const DEFAULT_BATCH_WINDOW_MS = 250;
const MAX_RETAINED_EVENTS = 100;
const DEFAULT_DELIVERY_GRACE_MS = 3_000;

type NormalizedWaitOptions = Required<
  Omit<WaitForReviewEventsOptions, "documentPath" | "timeoutMs">
> & {
  documentPath?: string;
  timeoutMs?: number;
};

export class ReviewEventQueue {
  private events: ReviewCompletedEvent[] = [];
  private waiters = new Set<Waiter>();
  private nextSequence = 1;
  // Listeners waiting to hear that a specific (not-yet-delivered) event was
  // picked up by a watcher, keyed by resolved documentPath. Lets emit()
  // tolerate the brief reconnect gap in a chunked long-poll instead of
  // reporting "no watcher" for an event the watcher's next chunk will still
  // receive.
  private pickupListeners = new Map<string, Set<(sequence: number) => void>>();

  emit(input: ReviewCompletedEventInput): {
    delivered: boolean;
    event: ReviewCompletedEvent;
  } {
    const event: ReviewCompletedEvent = {
      ...input,
      type: "review.completed",
      sequence: this.nextSequence,
      createdAt: new Date().toISOString(),
    };
    this.nextSequence += 1;
    this.events.push(event);
    this.events = this.events.slice(-MAX_RETAINED_EVENTS);

    appendSlog("review-events.emit", {
      documentPath: event.documentPath,
      sequence: event.sequence,
      waiters: this.waiters.size,
      hasOverallComment: typeof event.overallComment === "string",
      overallCommentLength: event.overallComment?.length ?? 0,
    });

    let delivered = false;
    for (const waiter of [...this.waiters]) {
      if (matchesWaiter(event, waiter.options)) {
        delivered = true;
        this.scheduleResolve(waiter);
      }
    }

    return { delivered, event };
  }

  // Same as emit(), but when no watcher is currently registered it waits up
  // to graceMs for a watcher to reconnect and pick up the event before
  // reporting non-delivery. A chunked long-poll watcher briefly has no
  // in-flight request while it re-issues its next chunk; without this grace
  // period, an emit() landing in that gap would falsely report the watcher
  // as disconnected even though its very next chunk resumes from this event
  // and receives it.
  async emitAwaitingDelivery(
    input: ReviewCompletedEventInput,
    graceMs: number = DEFAULT_DELIVERY_GRACE_MS,
  ): Promise<{ delivered: boolean; event: ReviewCompletedEvent }> {
    const { delivered, event } = this.emit(input);
    if (delivered) return { delivered, event };

    const key = path.resolve(event.documentPath);
    appendSlog("review-events.emitAwaitingDelivery.grace-start", {
      documentPath: key,
      sequence: event.sequence,
      graceMs,
      existingListenerCount: this.pickupListeners.get(key)?.size ?? 0,
    });
    const pickedUp = await new Promise<boolean>((resolve) => {
      let listeners = this.pickupListeners.get(key);
      if (!listeners) {
        listeners = new Set();
        this.pickupListeners.set(key, listeners);
      }

      const cleanup = () => {
        clearTimeout(timer);
        listeners?.delete(listener);
      };
      const listener = (sequence: number) => {
        if (sequence < event.sequence) return;
        appendSlog("review-events.emitAwaitingDelivery.picked-up", {
          documentPath: key,
          sequence: event.sequence,
          pickupSequence: sequence,
        });
        cleanup();
        resolve(true);
      };
      const timer = setTimeout(() => {
        appendSlog("review-events.emitAwaitingDelivery.grace-timeout", {
          documentPath: key,
          sequence: event.sequence,
          graceMs,
        });
        cleanup();
        resolve(false);
      }, graceMs);

      listeners.add(listener);
    });

    return { delivered: pickedUp, event };
  }

  private notifyPickup(
    documentPath: string | undefined,
    events: ReviewCompletedEvent[],
  ): void {
    if (!documentPath || events.length === 0) return;
    const listeners = this.pickupListeners.get(documentPath);
    appendSlog("review-events.notifyPickup", {
      documentPath,
      eventSequences: events.map((event) => event.sequence),
      listenerCount: listeners?.size ?? 0,
    });
    if (!listeners || listeners.size === 0) return;

    const maxSequence = Math.max(...events.map((event) => event.sequence));
    for (const listener of [...listeners]) {
      listener(maxSequence);
    }
  }

  wait(
    options: WaitForReviewEventsOptions = {},
  ): Promise<WaitForReviewEventsResult> {
    const normalized = normalizeWaitOptions(options);
    const existing = this.matchingEvents(normalized);

    if (existing.length > 0) {
      this.notifyPickup(normalized.documentPath, existing);
      return Promise.resolve(
        resultForEvents(existing, false, this.latestSequence()),
      );
    }

    return new Promise((resolve) => {
      const waiter: Waiter = {
        options: normalized,
        resolve,
        batchTimeout: null,
        timeout:
          normalized.timeoutMs !== undefined
            ? setTimeout(() => {
                this.resolveWaiter(waiter, true);
              }, normalized.timeoutMs)
            : null,
      };

      this.waiters.add(waiter);
      appendSlog("review-events.wait", {
        documentPath: normalized.documentPath ?? null,
        afterSequence: normalized.afterSequence,
        timeoutMs: normalized.timeoutMs,
      });
    });
  }

  waiterCount(): number {
    return this.waiters.size;
  }

  latestSequence(): number {
    return this.nextSequence - 1;
  }

  waiterCountForDocument(documentPath: string): number {
    const normalizedPath = path.resolve(documentPath);
    return [...this.waiters].filter(
      (waiter) => waiter.options.documentPath === normalizedPath,
    ).length;
  }

  private matchingEvents(
    options: NormalizedWaitOptions,
  ): ReviewCompletedEvent[] {
    return this.events.filter((event) => matchesWaiter(event, options));
  }

  private scheduleResolve(waiter: Waiter): void {
    if (waiter.batchTimeout) return;

    if (waiter.timeout) {
      clearTimeout(waiter.timeout);
      waiter.timeout = null;
    }

    waiter.batchTimeout = setTimeout(() => {
      this.resolveWaiter(waiter, false);
    }, waiter.options.batchWindowMs);
  }

  private resolveWaiter(waiter: Waiter, timedOut: boolean): void {
    if (!this.waiters.has(waiter)) return;

    this.waiters.delete(waiter);
    if (waiter.timeout) {
      clearTimeout(waiter.timeout);
    }
    if (waiter.batchTimeout) {
      clearTimeout(waiter.batchTimeout);
    }

    const events = timedOut ? [] : this.matchingEvents(waiter.options);
    appendSlog("review-events.resolveWaiter", {
      documentPath: waiter.options.documentPath ?? null,
      timedOut,
      resolvedEventSequences: events.map((event) => event.sequence),
      nextSequence: this.latestSequence(),
    });
    waiter.resolve(resultForEvents(events, timedOut, this.latestSequence()));
  }
}

function normalizeWaitOptions(
  options: WaitForReviewEventsOptions,
): NormalizedWaitOptions {
  return {
    documentPath: options.documentPath
      ? path.resolve(options.documentPath)
      : undefined,
    afterSequence: Math.max(0, options.afterSequence ?? 0),
    timeoutMs:
      options.timeoutMs !== undefined
        ? clamp(options.timeoutMs, 0, 300_000)
        : undefined,
    batchWindowMs: clamp(
      options.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS,
      0,
      10_000,
    ),
  };
}

function matchesWaiter(
  event: ReviewCompletedEvent,
  options: NormalizedWaitOptions,
): boolean {
  if (event.sequence <= options.afterSequence) return false;
  if (!options.documentPath) return true;
  return path.resolve(event.documentPath) === options.documentPath;
}

function resultForEvents(
  events: ReviewCompletedEvent[],
  timedOut: boolean,
  nextSequence: number,
): WaitForReviewEventsResult {
  return {
    events,
    timedOut,
    nextSequence,
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function appendSlog(event: string, data: Record<string, unknown>): void {
  const file = process.env.THOUGHTFUL_SLOG_FILE;
  if (!file) return;

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(
    file,
    `${JSON.stringify({
      ts: new Date().toISOString(),
      runId: process.env.THOUGHTFUL_SLOG_RUN_ID ?? "manual",
      source: "packages/server/src/review-events.ts",
      event,
      data,
    })}\n`,
  );
}
