// Node's global fetch (undici) kills a request with no response bytes after
// its default headersTimeout of 300s. /api/review-events/watch is a
// long-poll that can legitimately hold a response open for minutes, so each
// chunk must stay comfortably under that default rather than trying to
// disable it. Chunks are re-issued (resuming via nextSequence/afterSequence)
// until a real event arrives or the caller's own overall timeout elapses.
export const REVIEW_EVENTS_WATCH_CHUNK_SECONDS = 240;

export interface WatchReviewEventsChunkedParams {
  projectPath: string;
  path: string;
  batchWindowSeconds: number;
  initialFromNow: boolean;
  overallTimeoutSeconds?: number;
}

export interface WatchReviewEventsResult {
  events?: unknown[];
  timedOut?: boolean;
  nextSequence?: number;
}

export async function watchReviewEventsChunked(
  fetchImpl: typeof fetch,
  watchUrl: string | URL,
  params: WatchReviewEventsChunkedParams,
): Promise<WatchReviewEventsResult> {
  const overallDeadline =
    params.overallTimeoutSeconds !== undefined
      ? Date.now() + params.overallTimeoutSeconds * 1000
      : undefined;

  let fromNow = params.initialFromNow;
  let afterSequence: number | undefined;
  let payload: WatchReviewEventsResult = { events: [], timedOut: true };

  for (;;) {
    let chunkSeconds = REVIEW_EVENTS_WATCH_CHUNK_SECONDS;
    if (overallDeadline !== undefined) {
      const remainingSeconds = (overallDeadline - Date.now()) / 1000;
      if (remainingSeconds <= 0) {
        payload = { events: [], timedOut: true, nextSequence: afterSequence };
        break;
      }
      chunkSeconds = Math.min(chunkSeconds, remainingSeconds);
    }

    const body: {
      projectPath: string;
      path: string;
      timeoutSeconds: number;
      batchWindowSeconds: number;
      fromNow: boolean;
      afterSequence?: number;
    } = {
      projectPath: params.projectPath,
      path: params.path,
      timeoutSeconds: chunkSeconds,
      batchWindowSeconds: params.batchWindowSeconds,
      fromNow,
    };
    if (!fromNow && afterSequence !== undefined) {
      body.afterSequence = afterSequence;
    }

    const response = await fetchImpl(watchUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout((chunkSeconds + 5) * 1000),
    });

    if (!response.ok) {
      throw new Error(`Failed to watch review events: ${response.status}`);
    }

    payload = (await response.json()) as WatchReviewEventsResult;

    if (!payload.timedOut || (payload.events?.length ?? 0) > 0) {
      break;
    }

    // This chunk's budget elapsed with nothing new. Resume from where the
    // server left off instead of rescanning from "now", so an event that
    // lands in the gap between chunks is never missed.
    fromNow = false;
    afterSequence = payload.nextSequence ?? afterSequence;
  }

  return payload;
}
