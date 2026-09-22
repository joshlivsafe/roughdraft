import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callTool } from "./mcp";

describe("mcp", () => {
  let tempDir: string;
  let stateFile: string;
  let projectDir: string;
  let documentPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-mcp-"));
    projectDir = path.join(tempDir, "project");
    stateFile = path.join(tempDir, "state", "server.json");
    documentPath = path.join(projectDir, "draft.md");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(documentPath, "# Draft\n");
    fs.writeFileSync(
      stateFile,
      JSON.stringify({ url: "http://localhost:7373", port: 7373 }),
    );
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("keeps every review watch request bounded even when the tool caller provides no timeoutSeconds", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(JSON.stringify({ events: [], timedOut: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    await callTool(
      "roughdraft_watch_review_events",
      { documentPath, projectPath: projectDir },
      { ROUGHDRAFT_STATE_FILE: stateFile },
      fetchImpl,
    );
    await callTool(
      "roughdraft_watch_review_events",
      { documentPath, projectPath: projectDir, timeoutSeconds: 5 },
      { ROUGHDRAFT_STATE_FILE: stateFile },
      fetchImpl,
    );

    expect(requestBodies[0]).toMatchObject({
      projectPath: projectDir,
      path: "draft.md",
      batchWindowSeconds: 0.25,
      fromNow: true,
    });
    // No single request may go out unbounded (see
    // REVIEW_EVENTS_WATCH_CHUNK_SECONDS) — omitting timeoutSeconds means
    // "wait indefinitely" at the tool-call level, achieved by chunking, not
    // by an unbounded fetch to the server.
    expect(typeof requestBodies[0]?.timeoutSeconds).toBe("number");
    expect(requestBodies[0]?.timeoutSeconds).toBeLessThanOrEqual(300);
    expect(requestBodies[1]).toMatchObject({
      timeoutSeconds: 5,
    });
  });

  it("resumes review watch chunks from nextSequence instead of rescanning from now", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<
        string,
        unknown
      >;
      requestBodies.push(body);

      if (requestBodies.length < 3) {
        return new Response(
          JSON.stringify({ events: [], timedOut: true, nextSequence: 5 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response(
        JSON.stringify({
          events: [{ documentPath, type: "review.completed" }],
          timedOut: false,
          nextSequence: 6,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const result = await callTool(
      "roughdraft_watch_review_events",
      { documentPath, projectPath: projectDir },
      { ROUGHDRAFT_STATE_FILE: stateFile },
      fetchImpl,
    );

    expect(requestBodies.length).toBeGreaterThanOrEqual(3);
    expect(requestBodies[0]?.fromNow).toBe(true);
    expect(requestBodies[1]).toMatchObject({
      afterSequence: 5,
      fromNow: false,
    });
    expect(requestBodies[2]).toMatchObject({
      afterSequence: 5,
      fromNow: false,
    });
    expect(result).toMatchObject({
      timedOut: false,
      events: [{ documentPath, type: "review.completed" }],
    });
  });

  it("returns overall comments from review watch events unchanged", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          events: [
            {
              documentPath,
              type: "review.completed",
              overallComment: "Please prioritize the CLI contract.",
            },
          ],
          timedOut: false,
          nextSequence: 2,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );

    const result = await callTool(
      "roughdraft_watch_review_events",
      { documentPath, projectPath: projectDir },
      { ROUGHDRAFT_STATE_FILE: stateFile },
      fetchImpl,
    );

    expect(result).toMatchObject({
      events: [
        {
          overallComment: "Please prioritize the CLI contract.",
        },
      ],
    });
  });

  it("does not write a reply when the message contains a CriticMarkup close delimiter", async () => {
    const original =
      '# Draft\n\n{>>Needs proof<<}{id="c1" by="user" at="2026-04-28T12:00:00.000Z"}\n';
    fs.writeFileSync(documentPath, original);

    await expect(
      callTool(
        "roughdraft_reply_to_comment",
        {
          documentPath,
          parentId: "c1",
          message: "This closes early <<} and breaks parsing.",
        },
        { ROUGHDRAFT_STATE_FILE: stateFile },
      ),
    ).rejects.toThrow(/CriticMarkup close delimiter/);

    expect(fs.readFileSync(documentPath, "utf8")).toBe(original);
  });
});
