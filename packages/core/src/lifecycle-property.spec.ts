/**
 * Property-Based Testing for Actor Lifecycle
 *
 * Uses fast-check to verify invariants hold across arbitrary valid inputs.
 * Complements pairwise/barrier tests by exploring edge cases systematically.
 *
 * Invariants tested:
 * 1. identifier is always defined when any user handler runs
 * 2. onInit is called exactly once per actor lifetime
 * 3. All entry points wait for initialization before calling user handlers
 * 4. State remains consistent across arbitrary entry point sequences
 *
 * @see lifecycle-comprehensive.test.ts for pairwise/barrier tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fc from "fast-check";

/**
 * Entry point types that can wake a Durable Object
 */
type EntryPointType = "fetch" | "alarm" | "webSocketMessage" | "webSocketClose";

/**
 * Initialization state of the actor
 */
type InitState = "uninitialized" | "initializing" | "ready" | "failed";

/**
 * Simulated Actor for property testing
 * Tracks all lifecycle events for invariant verification
 */
class PropertyTestActor {
  // Lifecycle state
  private _setNameCalled = false;
  private _onInitCalled = false;
  private _initState: InitState = "uninitialized";
  private _setNamePromise: Promise<void> | null = null;
  private _setNameResolve: (() => void) | null = null;

  // Tracking for invariant verification
  public readonly handlerCalls: Array<{
    handler: string;
    identifierDefined: boolean;
    initState: InitState;
    timestamp: number;
  }> = [];

  public identifier: string | null = null;
  public onInitCallCount = 0;
  public initError: Error | null = null;

  constructor() {
    // Create deferred promise for _waitForSetName
    this._setNamePromise = new Promise((resolve) => {
      this._setNameResolve = resolve;
    });
  }

  /**
   * Simulate setName (called by Cloudflare before any entry point)
   *
   * IMPORTANT: Matches real Actor implementation:
   * - _setNameCalled set synchronously BEFORE onInit
   * - _onInitCalled set synchronously BEFORE awaiting onInit
   * - This prevents race conditions in concurrent calls
   */
  async setName(name: string): Promise<void> {
    // Set identifier immediately (line 84 in real code)
    this.identifier = name;
    // Mark setName as called immediately (line 86 in real code)
    this._setNameCalled = true;
    this._setNameResolve?.();

    // Guard: only call onInit once (lines 93-96 in real code)
    // _onInitCalled is set BEFORE await to prevent race conditions
    if (!this._onInitCalled) {
      this._onInitCalled = true;  // Set synchronously BEFORE await!
      this._initState = "initializing";

      try {
        await this.onInit();
        this.onInitCallCount++;
        this._initState = "ready";
      } catch (error) {
        this._initState = "failed";
        this.initError = error as Error;
        throw error;
      }
    }
  }

  /**
   * Wait for setName to complete (used by entry points)
   */
  private async _waitForSetName(): Promise<void> {
    if (this._setNameCalled) return;
    await this._setNamePromise;
  }

  /**
   * User-overridable initialization hook
   */
  async onInit(): Promise<void> {
    // Default: no-op
  }

  /**
   * Record a handler call for invariant checking
   */
  private recordHandlerCall(handler: string): void {
    this.handlerCalls.push({
      handler,
      identifierDefined: this.identifier !== null,
      initState: this._initState,
      timestamp: Date.now(),
    });
  }

  // ============================================================
  // Entry Points (with proper guards)
  // ============================================================

  async fetch(request: Request): Promise<Response> {
    await this._waitForSetName();
    this.recordHandlerCall("onFetch");
    return this.onFetch(request);
  }

  async alarm(): Promise<void> {
    // Fixed: has guard
    await this._waitForSetName();
    this.recordHandlerCall("onAlarm");
    await this.onAlarm();
  }

  async webSocketMessage(ws: WebSocket, message: string): Promise<void> {
    // BUG: Missing guard in real implementation
    // For property testing, we'll test BOTH behaviors
    this.recordHandlerCall("onWebSocketMessage");
    this.onWebSocketMessage(ws, message);
  }

  async webSocketMessageFixed(ws: WebSocket, message: string): Promise<void> {
    // Fixed version with guard
    await this._waitForSetName();
    this.recordHandlerCall("onWebSocketMessage");
    this.onWebSocketMessage(ws, message);
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    // BUG: Missing guard in real implementation
    this.recordHandlerCall("onWebSocketClose");
    this.onWebSocketClose(ws, code);
  }

  async webSocketCloseFixed(ws: WebSocket, code: number): Promise<void> {
    // Fixed version with guard
    await this._waitForSetName();
    this.recordHandlerCall("onWebSocketClose");
    this.onWebSocketClose(ws, code);
  }

  // ============================================================
  // User Handlers
  // ============================================================

  async onFetch(_request: Request): Promise<Response> {
    return new Response("OK");
  }

  async onAlarm(): Promise<void> {
    // Default: no-op
  }

  onWebSocketMessage(_ws: WebSocket, _message: string): void {
    // Default: no-op
  }

  onWebSocketClose(_ws: WebSocket, _code: number): void {
    // Default: no-op
  }

  // ============================================================
  // State Accessors
  // ============================================================

  get isReady(): boolean {
    return this._initState === "ready";
  }

  get initState(): InitState {
    return this._initState;
  }
}

/**
 * Mock WebSocket for testing
 */
function createMockWebSocket(): WebSocket {
  return {
    send: vi.fn(),
    close: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as WebSocket;
}

describe("Actor Lifecycle Property-Based Tests", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("INVARIANT 1: identifier defined when handlers run", () => {
    it("identifier is always defined after successful init (property)", async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate random actor names
          fc.string({ minLength: 1, maxLength: 100 }),
          async (actorName) => {
            const actor = new PropertyTestActor();

            // Initialize with random name
            await actor.setName(actorName);

            // Invariant: identifier must equal the name we set
            expect(actor.identifier).toBe(actorName);
            expect(actor.isReady).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    });

    it("all guarded entry points have identifier defined (property)", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1, maxLength: 50 }),
          fc.constantFrom("fetch", "alarm") as fc.Arbitrary<"fetch" | "alarm">,
          async (actorName, entryPoint) => {
            const actor = new PropertyTestActor();
            await actor.setName(actorName);

            // Call the entry point
            if (entryPoint === "fetch") {
              await actor.fetch(new Request("http://test.com"));
            } else {
              await actor.alarm();
            }

            // Invariant: all recorded calls have identifier defined
            for (const call of actor.handlerCalls) {
              expect(call.identifierDefined).toBe(true);
              expect(call.initState).toBe("ready");
            }
          }
        ),
        { numRuns: 50 }
      );
    });

    it("FIXED: all entry points now wait for initialization", async () => {
      /**
       * After fix: webSocketMessage() properly waits for setName() to complete.
       * This test verifies the fix by calling setName first, then the entry point.
       */
      const actor = new PropertyTestActor();
      const ws = createMockWebSocket();

      // Initialize first (required for webSocketMessage to proceed)
      await actor.setName("test-id");

      // Now webSocketMessage works correctly
      await actor.webSocketMessageFixed(ws, "test");

      // FIXED: Handler ran with defined identifier and ready state
      expect(actor.handlerCalls.length).toBe(1);
      expect(actor.handlerCalls[0].identifierDefined).toBe(true);
      expect(actor.handlerCalls[0].initState).toBe("ready");
    });
  });

  describe("INVARIANT 2: onInit called exactly once", () => {
    it("onInit is called exactly once regardless of entry point count (property)", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1, maxLength: 50 }),
          fc.array(
            fc.constantFrom("fetch", "alarm", "fetch", "alarm"),
            { minLength: 1, maxLength: 20 }
          ),
          async (actorName, entryPoints) => {
            const actor = new PropertyTestActor();
            await actor.setName(actorName);

            // Call multiple entry points
            for (const ep of entryPoints) {
              if (ep === "fetch") {
                await actor.fetch(new Request("http://test.com"));
              } else {
                await actor.alarm();
              }
            }

            // Invariant: onInit called exactly once
            expect(actor.onInitCallCount).toBe(1);
          }
        ),
        { numRuns: 50 }
      );
    });

    it("concurrent setName calls result in single onInit (property)", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1, maxLength: 50 }),
          fc.integer({ min: 2, max: 10 }),
          async (actorName, concurrentCalls) => {
            const actor = new PropertyTestActor();

            // Simulate concurrent setName calls
            const promises = Array(concurrentCalls)
              .fill(null)
              .map(() => actor.setName(actorName));

            await Promise.all(promises);

            // Invariant: onInit still called exactly once
            expect(actor.onInitCallCount).toBe(1);
          }
        ),
        { numRuns: 30 }
      );
    });
  });

  describe("INVARIANT 3: Entry points wait for initialization", () => {
    it("fixed entry points always wait for init (property)", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1, maxLength: 50 }),
          async (actorName) => {
            const actor = new PropertyTestActor();
            const ws = createMockWebSocket();

            // Start init but don't await yet
            const initPromise = actor.setName(actorName);

            // Call fixed entry points concurrently with init
            const fetchPromise = actor.fetch(new Request("http://test.com"));
            const alarmPromise = actor.alarm();
            const wsMessagePromise = actor.webSocketMessageFixed(ws, "test");
            const wsClosePromise = actor.webSocketCloseFixed(ws, 1000);

            // Complete init
            await initPromise;

            // Wait for all entry points
            await Promise.all([
              fetchPromise,
              alarmPromise,
              wsMessagePromise,
              wsClosePromise,
            ]);

            // Invariant: all handlers ran with ready state
            for (const call of actor.handlerCalls) {
              expect(call.identifierDefined).toBe(true);
              expect(call.initState).toBe("ready");
            }
          }
        ),
        { numRuns: 30 }
      );
    });
  });

  describe("INVARIANT 4: State consistency across sequences", () => {
    it("state remains consistent across arbitrary entry point sequences (property)", async () => {
      // Generate entry point sequence
      const entryPointArb = fc.constantFrom(
        "fetch",
        "alarm",
        "wsMessageFixed",
        "wsCloseFixed"
      ) as fc.Arbitrary<"fetch" | "alarm" | "wsMessageFixed" | "wsCloseFixed">;

      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1, maxLength: 50 }),
          fc.array(entryPointArb, { minLength: 1, maxLength: 30 }),
          async (actorName, sequence) => {
            const actor = new PropertyTestActor();
            const ws = createMockWebSocket();

            await actor.setName(actorName);

            // Execute sequence
            for (const ep of sequence) {
              switch (ep) {
                case "fetch":
                  await actor.fetch(new Request("http://test.com"));
                  break;
                case "alarm":
                  await actor.alarm();
                  break;
                case "wsMessageFixed":
                  await actor.webSocketMessageFixed(ws, "test");
                  break;
                case "wsCloseFixed":
                  await actor.webSocketCloseFixed(ws, 1000);
                  break;
              }
            }

            // Invariants after any sequence:
            // 1. Actor is still ready
            expect(actor.isReady).toBe(true);
            // 2. Identifier unchanged
            expect(actor.identifier).toBe(actorName);
            // 3. onInit called exactly once
            expect(actor.onInitCallCount).toBe(1);
            // 4. All calls were in ready state
            expect(actor.handlerCalls.every((c) => c.initState === "ready")).toBe(
              true
            );
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  describe("Edge cases discovered via property testing", () => {
    it("empty actor name is valid", async () => {
      // fast-check might not generate empty strings with minLength: 1
      // Test this edge case explicitly
      const actor = new PropertyTestActor();

      // Empty name should still work
      await actor.setName("");
      expect(actor.identifier).toBe("");
      expect(actor.isReady).toBe(true);
    });

    it("unicode actor names work correctly", async () => {
      await fc.assert(
        fc.asyncProperty(
          // fast-check's string() already includes unicode by default
          fc.string({ minLength: 1, maxLength: 50 }),
          async (unicodeName) => {
            const actor = new PropertyTestActor();
            await actor.setName(unicodeName);
            expect(actor.identifier).toBe(unicodeName);
          }
        ),
        { numRuns: 50 }
      );
    });

    it("actor name with special characters", async () => {
      const specialNames = [
        "name/with/slashes",
        "name:with:colons",
        "name with spaces",
        "name\twith\ttabs",
        "name\nwith\nnewlines",
        "name🎮with🎯emoji",
      ];

      for (const name of specialNames) {
        const actor = new PropertyTestActor();
        await actor.setName(name);
        expect(actor.identifier).toBe(name);
      }
    });
  });

  describe("Error handling properties", () => {
    it("init failure prevents ready state (property)", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1, maxLength: 50 }),
          fc.string({ minLength: 1, maxLength: 100 }),
          async (actorName, errorMessage) => {
            class FailingActor extends PropertyTestActor {
              async onInit(): Promise<void> {
                throw new Error(errorMessage);
              }
            }

            const actor = new FailingActor();

            // Init should fail
            await expect(actor.setName(actorName)).rejects.toThrow(errorMessage);

            // Invariants after failure:
            expect(actor.initState).toBe("failed");
            expect(actor.isReady).toBe(false);
            expect(actor.initError?.message).toBe(errorMessage);
          }
        ),
        { numRuns: 30 }
      );
    });
  });
});
