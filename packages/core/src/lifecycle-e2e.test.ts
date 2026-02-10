/**
 * End-to-End Actor Lifecycle Tests
 *
 * Tests complete actor lifecycles across multiple entry points and hooks.
 * These tests verify behavior across realistic usage patterns rather than
 * isolated unit scenarios.
 *
 * Scenarios:
 * - Full WebSocket session lifecycle (upgrade → connect → messages → close)
 * - State persistence across all handlers
 * - Mixed entry point sequences
 * - Handler error isolation
 * - Re-entrance from within handlers
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("cloudflare:workers", () => {
  class DurableObject {
    constructor(_state?: unknown, _env?: unknown) {}
  }

  class WorkerEntrypoint {}

  return {
    DurableObject,
    WorkerEntrypoint,
    env: {},
  };
});

import { Actor } from "./index";
import { createMockWebSocket, createCallOrderTracker } from "./lifecycle-fixtures";

describe("E2E: Full Actor Session Lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("complete session from init to cleanup", () => {
    it("tracks full lifecycle: init → fetch → WS session → alarm → cleanup", async () => {
      const tracker = createCallOrderTracker();
      const state = { requestCount: 0, messageCount: 0, initialized: false };

      class SessionActor extends Actor<unknown> {
        override async onInit(): Promise<void> {
          tracker.push("onInit");
          state.initialized = true;
        }

        override async onRequest(request: Request): Promise<Response> {
          tracker.push(`onRequest:${request.url}`);
          state.requestCount++;
          return new Response(`Request #${state.requestCount}`);
        }

        override onWebSocketConnect(_ws: WebSocket, _request: Request): void {
          tracker.push("onWebSocketConnect");
        }

        override onWebSocketMessage(_ws: WebSocket, message: unknown): void {
          tracker.push(`onWebSocketMessage:${message}`);
          state.messageCount++;
        }

        override onWebSocketDisconnect(_ws: WebSocket): void {
          tracker.push("onWebSocketDisconnect");
        }

        override async onAlarm(): Promise<void> {
          tracker.push("onAlarm");
        }
      }

      const actor = new SessionActor(undefined, undefined);

      // Phase 1: Initialization
      await actor.setName("session-123");
      expect(state.initialized).toBe(true);

      // Phase 2: HTTP requests
      await actor.fetch(new Request("https://api.example.com/status"));
      await actor.fetch(new Request("https://api.example.com/data"));
      expect(state.requestCount).toBe(2);

      // Phase 3: WebSocket session
      const ws = createMockWebSocket();
      await actor.webSocketMessage(ws, "hello");
      await actor.webSocketMessage(ws, "world");
      await actor.webSocketClose(ws, 1000);
      expect(state.messageCount).toBe(2);

      // Phase 4: Alarm (cleanup/maintenance)
      try {
        await actor.alarm();
      } catch {
        // Expected - alarms subsystem not initialized
      }

      // Verify complete lifecycle order
      expect(tracker.callOrder).toEqual([
        "onInit",
        "onRequest:https://api.example.com/status",
        "onRequest:https://api.example.com/data",
        "onWebSocketMessage:hello",
        "onWebSocketMessage:world",
        "onWebSocketDisconnect",
        "onAlarm",
      ]);
    });
  });

  describe("state persistence across handlers", () => {
    it("state set in onInit is available in all handlers", async () => {
      interface ActorState {
        userId: string;
        permissions: string[];
        sessionStart: number;
      }

      let capturedStates: Partial<ActorState>[] = [];

      class StatefulActor extends Actor<unknown> {
        private actorState: ActorState = {
          userId: "",
          permissions: [],
          sessionStart: 0,
        };

        override async onInit(): Promise<void> {
          this.actorState = {
            userId: "user-456",
            permissions: ["read", "write"],
            sessionStart: Date.now(),
          };
          capturedStates.push({ ...this.actorState });
        }

        override async onRequest(_request: Request): Promise<Response> {
          capturedStates.push({ userId: this.actorState.userId });
          return new Response(this.actorState.userId);
        }

        override onWebSocketMessage(_ws: WebSocket, _message: unknown): void {
          capturedStates.push({ permissions: [...this.actorState.permissions] });
        }

        override async onAlarm(): Promise<void> {
          capturedStates.push({ sessionStart: this.actorState.sessionStart });
        }
      }

      const actor = new StatefulActor(undefined, undefined);
      await actor.setName("stateful-actor");

      await actor.fetch(new Request("https://example.com"));
      const ws = createMockWebSocket();
      await actor.webSocketMessage(ws, "check");
      try {
        await actor.alarm();
      } catch {
        // Expected
      }

      // All handlers see the state set in onInit
      expect(capturedStates[0]).toMatchObject({
        userId: "user-456",
        permissions: ["read", "write"],
      });
      expect(capturedStates[1]).toEqual({ userId: "user-456" });
      expect(capturedStates[2]).toEqual({ permissions: ["read", "write"] });
      expect(capturedStates[3]).toHaveProperty("sessionStart");
      expect(capturedStates[3].sessionStart).toBeGreaterThan(0);
    });

    it("state mutations in handlers persist across calls", async () => {
      let counter = 0;

      class CounterActor extends Actor<unknown> {
        private count = 0;

        override async onInit(): Promise<void> {
          this.count = 100;
        }

        override async onRequest(_request: Request): Promise<Response> {
          this.count += 10;
          counter = this.count;
          return new Response(String(this.count));
        }

        override onWebSocketMessage(_ws: WebSocket, _message: unknown): void {
          this.count += 1;
          counter = this.count;
        }
      }

      const actor = new CounterActor(undefined, undefined);
      await actor.setName("counter");

      await actor.fetch(new Request("https://example.com")); // 100 + 10 = 110
      const ws = createMockWebSocket();
      await actor.webSocketMessage(ws, "inc"); // 110 + 1 = 111
      await actor.webSocketMessage(ws, "inc"); // 111 + 1 = 112
      await actor.fetch(new Request("https://example.com")); // 112 + 10 = 122

      expect(counter).toBe(122);
    });
  });

  describe("mixed entry point sequences", () => {
    it("interleaved fetch and WebSocket operations", async () => {
      const operations: string[] = [];

      class MixedActor extends Actor<unknown> {
        override async onInit(): Promise<void> {}

        override async onRequest(request: Request): Promise<Response> {
          const path = new URL(request.url).pathname;
          operations.push(`fetch:${path}`);
          return new Response("ok");
        }

        override onWebSocketMessage(_ws: WebSocket, message: unknown): void {
          operations.push(`ws:${message}`);
        }
      }

      const actor = new MixedActor(undefined, undefined);
      await actor.setName("mixed");

      const ws = createMockWebSocket();

      // Interleave operations
      await actor.fetch(new Request("https://example.com/1"));
      await actor.webSocketMessage(ws, "a");
      await actor.fetch(new Request("https://example.com/2"));
      await actor.webSocketMessage(ws, "b");
      await actor.fetch(new Request("https://example.com/3"));

      expect(operations).toEqual([
        "fetch:/1",
        "ws:a",
        "fetch:/2",
        "ws:b",
        "fetch:/3",
      ]);
    });

    it("multiple WebSocket connections concurrently", async () => {
      const messages: string[] = [];

      class MultiWSActor extends Actor<unknown> {
        override async onInit(): Promise<void> {}

        override onWebSocketMessage(ws: WebSocket, message: unknown): void {
          // @ts-expect-error - mock ws has id
          const wsId = ws.id || "unknown";
          messages.push(`${wsId}:${message}`);
        }
      }

      const actor = new MultiWSActor(undefined, undefined);
      await actor.setName("multi-ws");

      const ws1 = { ...createMockWebSocket(), id: "ws1" } as unknown as WebSocket;
      const ws2 = { ...createMockWebSocket(), id: "ws2" } as unknown as WebSocket;
      const ws3 = { ...createMockWebSocket(), id: "ws3" } as unknown as WebSocket;

      // Concurrent messages from different connections
      await Promise.all([
        actor.webSocketMessage(ws1, "msg1"),
        actor.webSocketMessage(ws2, "msg2"),
        actor.webSocketMessage(ws3, "msg3"),
      ]);

      expect(messages).toHaveLength(3);
      expect(messages).toContain("ws1:msg1");
      expect(messages).toContain("ws2:msg2");
      expect(messages).toContain("ws3:msg3");
    });
  });

  describe("handler error isolation", () => {
    it("error in fetch handler does not affect WebSocket handlers", async () => {
      let wsMessageCount = 0;

      class ErrorIsolationActor extends Actor<unknown> {
        override async onInit(): Promise<void> {}

        override async onRequest(_request: Request): Promise<Response> {
          throw new Error("Fetch handler error");
        }

        override onWebSocketMessage(_ws: WebSocket, _message: unknown): void {
          wsMessageCount++;
        }
      }

      const actor = new ErrorIsolationActor(undefined, undefined);
      await actor.setName("error-isolation");

      // Fetch fails
      await expect(
        actor.fetch(new Request("https://example.com"))
      ).rejects.toThrow("Fetch handler error");

      // WS still works
      const ws = createMockWebSocket();
      await actor.webSocketMessage(ws, "test");
      await actor.webSocketMessage(ws, "test2");

      expect(wsMessageCount).toBe(2);
    });

    it("error in one WS message does not affect subsequent messages", async () => {
      const processed: string[] = [];

      class WSErrorActor extends Actor<unknown> {
        override async onInit(): Promise<void> {}

        override onWebSocketMessage(_ws: WebSocket, message: unknown): void {
          if (message === "error") {
            throw new Error("Message processing error");
          }
          processed.push(String(message));
        }
      }

      const actor = new WSErrorActor(undefined, undefined);
      await actor.setName("ws-error");

      const ws = createMockWebSocket();

      await actor.webSocketMessage(ws, "first");
      await expect(actor.webSocketMessage(ws, "error")).rejects.toThrow();
      await actor.webSocketMessage(ws, "second");
      await actor.webSocketMessage(ws, "third");

      expect(processed).toEqual(["first", "second", "third"]);
    });

    it("error in alarm does not affect fetch handlers", async () => {
      let fetchCount = 0;

      class AlarmErrorActor extends Actor<unknown> {
        override async onInit(): Promise<void> {}

        override async onRequest(_request: Request): Promise<Response> {
          fetchCount++;
          return new Response("ok");
        }

        override async onAlarm(): Promise<void> {
          throw new Error("Alarm error");
        }
      }

      const actor = new AlarmErrorActor(undefined, undefined);
      await actor.setName("alarm-error");

      await actor.fetch(new Request("https://example.com"));

      // Alarm fails
      await expect(actor.alarm()).rejects.toThrow();

      // Fetch still works
      await actor.fetch(new Request("https://example.com"));

      expect(fetchCount).toBe(2);
    });
  });

  describe("re-entrance scenarios", () => {
    it("fetch from within WebSocket handler (deferred)", async () => {
      const operations: string[] = [];
      let actorRef: ReentranceActor;

      class ReentranceActor extends Actor<unknown> {
        override async onInit(): Promise<void> {}

        override async onRequest(_request: Request): Promise<Response> {
          operations.push("fetch");
          return new Response("ok");
        }

        override onWebSocketMessage(_ws: WebSocket, message: unknown): void {
          operations.push(`ws:${message}`);
          // Schedule a fetch (would be deferred in real usage)
          if (message === "trigger-fetch") {
            // In real usage, this would be via ctx.waitUntil or similar
            // For testing, we just record the intent
            operations.push("ws:scheduled-fetch");
          }
        }
      }

      actorRef = new ReentranceActor(undefined, undefined);
      await actorRef.setName("reentrance");

      const ws = createMockWebSocket();
      await actorRef.webSocketMessage(ws, "trigger-fetch");

      expect(operations).toEqual(["ws:trigger-fetch", "ws:scheduled-fetch"]);
    });
  });

  describe("identifier availability in all handlers", () => {
    it("identifier is set correctly and available everywhere", async () => {
      const identifiers: (string | undefined)[] = [];

      class IdentifierActor extends Actor<unknown> {
        override async onInit(): Promise<void> {
          identifiers.push(this.identifier);
        }

        override async onRequest(_request: Request): Promise<Response> {
          identifiers.push(this.identifier);
          return new Response("ok");
        }

        override onWebSocketMessage(_ws: WebSocket, _message: unknown): void {
          identifiers.push(this.identifier);
        }

        override async onAlarm(): Promise<void> {
          identifiers.push(this.identifier);
        }
      }

      const actor = new IdentifierActor(undefined, undefined);
      await actor.setName("my-unique-id-123");

      await actor.fetch(new Request("https://example.com"));
      const ws = createMockWebSocket();
      await actor.webSocketMessage(ws, "test");
      try {
        await actor.alarm();
      } catch {
        // Expected
      }

      // All handlers see the same identifier
      expect(identifiers).toEqual([
        "my-unique-id-123",
        "my-unique-id-123",
        "my-unique-id-123",
        "my-unique-id-123",
      ]);
    });
  });

  describe("rapid successive operations", () => {
    it("handles burst of operations without race conditions", async () => {
      let counter = 0;

      class BurstActor extends Actor<unknown> {
        override async onInit(): Promise<void> {}

        override async onRequest(_request: Request): Promise<Response> {
          counter++;
          return new Response(String(counter));
        }

        override onWebSocketMessage(_ws: WebSocket, _message: unknown): void {
          counter++;
        }
      }

      const actor = new BurstActor(undefined, undefined);
      await actor.setName("burst");

      const ws = createMockWebSocket();

      // Burst of 50 operations
      const operations = [];
      for (let i = 0; i < 25; i++) {
        operations.push(actor.fetch(new Request("https://example.com")));
        operations.push(actor.webSocketMessage(ws, `msg${i}`));
      }

      await Promise.all(operations);

      expect(counter).toBe(50);
    });
  });
});

describe("onInit failure recovery", () => {
  /**
   * BUG FOUND: If onInit() throws, the actor is permanently broken!
   *
   * Timeline:
   * 1. setName() called
   * 2. _onInitCalled = true (set BEFORE await)
   * 3. onInit() throws
   * 4. _onInitCalled stays true
   * 5. Subsequent setName() calls skip onInit (guard: if (!this._onInitCalled))
   * 6. Actor cannot recover - permanently broken!
   *
   * This is a real bug in the Actor class.
   */

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("BUG: onInit failure leaves actor in unrecoverable state", async () => {
    let initAttempts = 0;
    let shouldFail = true;

    class FailingInitActor extends Actor<unknown> {
      override async onInit(): Promise<void> {
        initAttempts++;
        if (shouldFail) {
          throw new Error("Init failed");
        }
      }
    }

    const actor = new FailingInitActor(undefined, undefined);

    // First attempt fails
    await expect(actor.setName("test-id")).rejects.toThrow("Init failed");
    expect(initAttempts).toBe(1);

    // Now "fix" the error condition
    shouldFail = false;

    // BUG: Second setName does NOT retry onInit!
    // _onInitCalled is already true from first attempt
    await actor.setName("test-id-2");
    expect(initAttempts).toBe(1); // Still 1! onInit was not retried!

    // Actor is permanently broken - no way to call onInit again
  });

  it("FIXED: entry points do NOT proceed after failed onInit", async () => {
    /**
     * AFTER FIX: If onInit() throws, _setNameCalled is never set to true.
     * This means entry points will wait (and eventually timeout) instead of
     * proceeding against broken state.
     *
     * BEFORE: _setNameCalled was set BEFORE onInit, so handlers ran on
     * partially-initialized actors even after init failure.
     *
     * AFTER: _setNameCalled is set AFTER onInit, so init failure means
     * handlers never see the ready signal.
     */
    let initFailed = false;

    class FailingInitActor2 extends Actor<unknown> {
      override async onInit(): Promise<void> {
        initFailed = true;
        throw new Error("Init failed");
      }

      override async onRequest(_request: Request): Promise<Response> {
        return new Response("ok");
      }
    }

    const actor = new FailingInitActor2(undefined, undefined);

    // Init fails
    await expect(actor.setName("test-id")).rejects.toThrow("Init failed");
    expect(initFailed).toBe(true);

    // FIXED: _setNameCalled is false because onInit failed before it could be set.
    // fetch() will wait for _setNameCalled which never comes.
    // In test env, _waitForSetName uses scheduler.wait(0) which doesn't exist,
    // so fetch() catches the error and returns a 503 Response.
    const response = await actor.fetch(new Request("https://example.com"));
    expect(response.status).toBe(503);
  });

  it("BUG: no _initFailed flag to track initialization failure", async () => {
    /**
     * The Actor class should have:
     * - _initFailed: boolean flag
     * - _initError: Error | null to store the failure
     * - Entry points should check _initFailed before proceeding
     * - setName should retry onInit if _initFailed is true
     *
     * Currently none of this exists - no failure tracking at all.
     */
    class TestActor extends Actor<unknown> {
      checkInitState() {
        // These properties don't exist but should:
        // @ts-expect-error - property doesn't exist
        const hasFailed = this._initFailed;
        // @ts-expect-error - property doesn't exist
        const error = this._initError;
        return { hasFailed, error };
      }
    }

    const actor = new TestActor(undefined, undefined);
    const state = actor.checkInitState();

    // BUG: No failure tracking exists
    expect(state.hasFailed).toBeUndefined();
    expect(state.error).toBeUndefined();
  });
});
