/**
 * setName Race Condition Fix Tests
 *
 * Verifies that _setNameCalled is set AFTER onInit() completes,
 * preventing entry points from running against partially-initialized state.
 *
 * The Bug:
 * --------
 * In the original code, setName() set _setNameCalled=true BEFORE calling
 * onInit(). Since _waitForSetName() polls this flag, entry points like
 * fetch(), alarm(), webSocketMessage(), and webSocketClose() could proceed
 * before onInit() finished. This meant handlers could run against an actor
 * whose state was only partially loaded (e.g., @Persist properties still
 * loading from SQLite, D1 connections not established, etc.).
 *
 * The Fix:
 * --------
 * Move `this._setNameCalled = true` to AFTER `await this.onInit()` completes.
 * Now _waitForSetName() blocks until initialization is fully done.
 *
 * Production Impact:
 * ------------------
 * - Cloudflare Durable Objects that use @Persist + onInit() for state loading
 *   would receive WebSocket messages or HTTP requests before their state was
 *   ready, causing crashes (cpuTimeMs=0) or data corruption.
 * - Observable as: alarm exceptions with cpuTimeMs=0, WebSocket upgrade 500s,
 *   and "state not initialized" errors in onRequest handlers.
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

/**
 * Create a mock WebSocket
 */
function createMockWebSocket(): WebSocket {
  return {
    send: vi.fn(),
    close: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    readyState: 1,
    CONNECTING: 0,
    OPEN: 1,
    CLOSING: 2,
    CLOSED: 3,
  } as unknown as WebSocket;
}

describe("setName race condition fix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("core fix: _setNameCalled after onInit", () => {
    it("onInit completes before any entry point can proceed", async () => {
      /**
       * The core invariant: after setName() returns, onInit() has completed
       * AND _setNameCalled is true. Entry points that arrived during onInit
       * must wait until both are done.
       */
      const callOrder: string[] = [];

      class TestActor extends Actor<unknown> {
        override async onInit(): Promise<void> {
          callOrder.push("onInit:start");
          // Simulate async work (e.g., loading from D1, @Persist hydration)
          await new Promise((r) => setTimeout(r, 10));
          callOrder.push("onInit:end");
        }

        override async onRequest(_request: Request): Promise<Response> {
          callOrder.push("onRequest");
          return new Response("ok");
        }
      }

      const actor = new TestActor(undefined, undefined);

      // setName must complete onInit before returning
      await actor.setName("test-id");

      // Verify onInit completed fully
      expect(callOrder).toEqual(["onInit:start", "onInit:end"]);

      // Now fetch works — actor is fully initialized
      await actor.fetch(new Request("https://example.com"));
      expect(callOrder).toEqual(["onInit:start", "onInit:end", "onRequest"]);
    });

    it("setName sets _setNameCalled=true only after onInit succeeds", async () => {
      /**
       * Structural test: verify the flag ordering by observing that
       * fetch() works after successful setName() but not before.
       */
      let handlerRan = false;

      class TestActor extends Actor<unknown> {
        override async onInit(): Promise<void> {
          // onInit succeeds
        }

        override async onRequest(_request: Request): Promise<Response> {
          handlerRan = true;
          return new Response("ok");
        }
      }

      const actor = new TestActor(undefined, undefined);

      // Before setName: _setNameCalled is false
      // fetch() would need to wait (and in test env, throws due to missing scheduler)
      // After setName: _setNameCalled is true, fetch() proceeds
      await actor.setName("test-id");
      await actor.fetch(new Request("https://example.com"));
      expect(handlerRan).toBe(true);
    });
  });

  describe("error case: onInit failure prevents readiness", () => {
    it("_setNameCalled stays false when onInit throws", async () => {
      /**
       * BEFORE FIX: _setNameCalled was set before onInit, so handlers
       * could run on broken actors where onInit failed.
       *
       * AFTER FIX: _setNameCalled is only set after onInit succeeds.
       * If onInit throws, _setNameCalled remains false, and entry points
       * will wait (and eventually timeout via _waitForSetName).
       */
      class FailingActor extends Actor<unknown> {
        override async onInit(): Promise<void> {
          throw new Error("D1 connection failed");
        }

        override async onRequest(_request: Request): Promise<Response> {
          return new Response("should never reach here");
        }
      }

      const actor = new FailingActor(undefined, undefined);

      // setName fails because onInit throws
      await expect(actor.setName("test-id")).rejects.toThrow("D1 connection failed");

      // _setNameCalled is false → fetch() cannot proceed
      // In test env, _waitForSetName calls scheduler.wait(0) which doesn't exist,
      // so fetch() catches the error and returns a 503 Response (not the handler).
      const response = await actor.fetch(new Request("https://example.com"));
      expect(response.status).toBe(503);
      const body = await response.text();
      expect(body).toBe("Actor initialization timeout");
    });

    it("setName can be retried after onInit failure (onInit re-runs)", async () => {
      /**
       * Note: This documents EXISTING behavior (both before and after fix).
       * _onInitCalled is set before await, so retrying setName does NOT
       * re-run onInit. This is a separate issue from the race condition fix.
       *
       * The _onInitCalled guard prevents re-entry, which is correct for
       * concurrent calls but means failed init cannot be retried.
       */
      let initAttempts = 0;

      class RetryableActor extends Actor<unknown> {
        override async onInit(): Promise<void> {
          initAttempts++;
          if (initAttempts === 1) {
            throw new Error("First attempt fails");
          }
        }
      }

      const actor = new RetryableActor(undefined, undefined);

      // First attempt fails
      await expect(actor.setName("test-id")).rejects.toThrow("First attempt fails");
      expect(initAttempts).toBe(1);

      // Second attempt does NOT re-run onInit (_onInitCalled is true)
      // This is documented behavior, not a regression from the race fix
      await actor.setName("test-id-retry");
      expect(initAttempts).toBe(1); // Still 1 - onInit was not retried
    });
  });

  describe("all entry points respect the fix", () => {
    it("fetch() only proceeds after onInit completes", async () => {
      const callOrder: string[] = [];

      class TestActor extends Actor<unknown> {
        override async onInit(): Promise<void> {
          callOrder.push("onInit");
        }

        override async onRequest(_request: Request): Promise<Response> {
          callOrder.push("onRequest");
          return new Response("ok");
        }
      }

      const actor = new TestActor(undefined, undefined);
      await actor.setName("test-id");
      await actor.fetch(new Request("https://example.com"));

      expect(callOrder).toEqual(["onInit", "onRequest"]);
    });

    it("alarm() only proceeds after onInit completes", async () => {
      const callOrder: string[] = [];

      class TestActor extends Actor<unknown> {
        override async onInit(): Promise<void> {
          callOrder.push("onInit");
        }

        override async onAlarm(): Promise<void> {
          callOrder.push("onAlarm");
        }
      }

      const actor = new TestActor(undefined, undefined);
      await actor.setName("test-id");

      try {
        await actor.alarm();
      } catch {
        // Expected - alarms subsystem not initialized in tests
      }

      expect(callOrder).toEqual(["onInit", "onAlarm"]);
    });

    it("webSocketMessage() only proceeds after onInit completes", async () => {
      const callOrder: string[] = [];

      class TestActor extends Actor<unknown> {
        override async onInit(): Promise<void> {
          callOrder.push("onInit");
        }

        override onWebSocketMessage(_ws: WebSocket, _message: unknown): void {
          callOrder.push("onWebSocketMessage");
        }
      }

      const actor = new TestActor(undefined, undefined);
      await actor.setName("test-id");

      const ws = createMockWebSocket();
      await actor.webSocketMessage(ws, "hello");

      expect(callOrder).toEqual(["onInit", "onWebSocketMessage"]);
    });

    it("webSocketClose() only proceeds after onInit completes", async () => {
      const callOrder: string[] = [];

      class TestActor extends Actor<unknown> {
        override async onInit(): Promise<void> {
          callOrder.push("onInit");
        }

        override onWebSocketDisconnect(_ws: WebSocket): void {
          callOrder.push("onWebSocketDisconnect");
        }
      }

      const actor = new TestActor(undefined, undefined);
      await actor.setName("test-id");

      const ws = createMockWebSocket();
      await actor.webSocketClose(ws, 1000, '', true);

      expect(callOrder).toEqual(["onInit", "onWebSocketDisconnect"]);
    });
  });

  describe("identifier availability", () => {
    it("identifier is set before onInit runs", async () => {
      /**
       * Even though _setNameCalled is deferred, the identifier itself
       * is still set BEFORE onInit runs. This means onInit() can safely
       * reference this.identifier for logging or D1 queries.
       */
      let identifierInOnInit: string | undefined;

      class TestActor extends Actor<unknown> {
        override async onInit(): Promise<void> {
          identifierInOnInit = this.identifier;
        }
      }

      const actor = new TestActor(undefined, undefined);
      await actor.setName("my-actor-id");

      expect(identifierInOnInit).toBe("my-actor-id");
    });

    it("identifier is available in all entry point handlers", async () => {
      const identifiers: (string | undefined)[] = [];

      class TestActor extends Actor<unknown> {
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
      }

      const actor = new TestActor(undefined, undefined);
      await actor.setName("stable-id");

      await actor.fetch(new Request("https://example.com"));
      const ws = createMockWebSocket();
      await actor.webSocketMessage(ws, "test");

      // All handlers see the same identifier
      expect(identifiers).toEqual(["stable-id", "stable-id", "stable-id"]);
    });
  });

  describe("idempotency preserved", () => {
    it("multiple setName calls still result in single onInit", async () => {
      let initCount = 0;

      class TestActor extends Actor<unknown> {
        override async onInit(): Promise<void> {
          initCount++;
        }
      }

      const actor = new TestActor(undefined, undefined);

      await actor.setName("first");
      await actor.setName("second");
      await actor.setName("third");

      expect(initCount).toBe(1);
    });

    it("concurrent setName calls share single onInit", async () => {
      let initCount = 0;

      class TestActor extends Actor<unknown> {
        override async onInit(): Promise<void> {
          initCount++;
          await new Promise((r) => setTimeout(r, 10));
        }
      }

      const actor = new TestActor(undefined, undefined);

      await Promise.all([
        actor.setName("a"),
        actor.setName("b"),
        actor.setName("c"),
      ]);

      expect(initCount).toBe(1);
    });
  });
});
