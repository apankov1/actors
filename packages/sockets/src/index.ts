import { DurableObject } from "cloudflare:workers";

type RecipientType = string | WebSocket;

type WebSocketWithMetadata = WebSocket & {
    serializeAttachment?(attachment: any): void;
    deserializeAttachment?(): any;
}

export class Sockets<P extends DurableObject<any>> {
    private parent: P;
    private context: DurableObjectState | undefined;
    public connections: Map<string, WebSocketWithMetadata> = new Map();

    constructor(ctx: DurableObjectState | undefined, parent: P) {
        this.context = ctx;
        this.parent = parent;

        if (ctx) {
            // When the actor is initialized, we should load any existing websockets
            // that are currently connected to this actor.
            const webSockets = ctx.getWebSockets() as WebSocketWithMetadata[];
            this.connections = new Map();

            webSockets.forEach((socket: WebSocketWithMetadata) => {
                // Retrieve the attachment data which contains connectionId and queryParams
                const attachment = socket.deserializeAttachment?.() || {};

                // Use the connection ID from attachment, or generate a new one if not available
                const connectionId = attachment.connectionId || crypto.randomUUID();

                // Store the connection with its ID
                this.connections.set(connectionId, socket);

                // If a user wants to get access to additional metadata that was part of the query
                // params from when they established the connection, they can do so by using the
                // `deserializeAttachment` method on the socket.
                // const queryParams = socket.deserializeAttachment?.()?.queryParams || {};
            });
        }
    }

    message(message: string, to?: RecipientType[] | '*', exclude?: RecipientType[]) {
        for (const [id, socket] of this.connections.entries()) {
            // Skip if the `id` or `socket` is in the `exclude` list
            if (exclude?.includes(id) || exclude?.includes(socket)) {
              continue;
            }

            // Send to all if 'to' is '*' or empty, otherwise only to specified recipients
            if (to === "*" || !to?.length || to.includes(id) || to.includes(socket)) {
              socket.send(message);
            }
        }
    }

    /**
     * Retrieve WebSockets attached to this Durable Object, optionally filtered by tag.
     *
     * Wraps DurableObjectState.getWebSockets(tag?) from the Hibernation API.
     * @see https://developers.cloudflare.com/durable-objects/api/state/#getwebsockets
     *
     * @param tag - Optional tag to filter by (must match a tag passed to acceptWebSocket)
     * @returns Array of WebSockets matching the tag, or all if no tag provided
     */
    getWebSockets(tag?: string): WebSocketWithMetadata[] {
        if (!this.context) return [];
        return this.context.getWebSockets(tag) as WebSocketWithMetadata[];
    }

    /**
     * Retrieve the tags associated with a given WebSocket.
     *
     * Wraps DurableObjectState.getTags(ws) from the Hibernation API.
     * @see https://developers.cloudflare.com/durable-objects/api/state/#gettags
     *
     * @param ws - The WebSocket to get tags for
     * @returns Array of tag strings
     */
    getTags(ws: WebSocket): string[] {
        if (!this.context) return [];
        return this.context.getTags(ws);
    }

    async webSocketMessage(ws: WebSocketWithMetadata, message: any) {

    }

    /**
     * Handle WebSocket close event. Removes the connection from the internal map
     * and reciprocates the close handshake with the original code and reason.
     *
     * Per Cloudflare docs, the close MUST be reciprocated to complete the handshake.
     * Failing to call ws.close() results in 1006 (abnormal closure) errors.
     * @see https://developers.cloudflare.com/durable-objects/api/base/#websocketclose
     *
     * @param ws - The WebSocket that was closed
     * @param code - Close code from the peer (e.g. 1000 for normal, 1001 for going away)
     * @param reason - Reason string from the peer (may be empty)
     * @param wasClean - Whether the close handshake completed cleanly
     */
    async webSocketClose(
        ws: WebSocketWithMetadata,
        code: number,
        reason: string,
        wasClean: boolean,
    ) {
        // When a particular user has ended its websocket connection, we should
        // find their entry in our connections map and prune it from our list we are
        // managing.
        for (const [id, socket] of this.connections.entries()) {
            if (socket === ws) {
                // Remove from connections map
                this.connections.delete(id);
                break;
            }
        }

        // Reciprocate the close with the original code and reason from the peer.
        // @see https://developers.cloudflare.com/durable-objects/api/base/#websocketclose
        ws.close(code, reason);
    }

    /**
     * Accept a WebSocket connection with optional tags for the Hibernation API.
     *
     * Tags enable targeted broadcast via getWebSockets(tag) and survive hibernation.
     * Each WebSocket supports up to 10 tags, each max 256 characters.
     * @see https://developers.cloudflare.com/durable-objects/api/state/#acceptwebsocket
     *
     * @param request - The incoming HTTP request to upgrade
     * @param tags - Optional array of tags to associate with this WebSocket
     * @returns The client/server WebSocket pair
     */
    acceptWebSocket(request: Request, tags?: string[]): {
        client: WebSocketWithMetadata;
        server: WebSocketWithMetadata;
    } {
        const webSocketPair = new WebSocketPair();
        const [client, server] = Object.values(webSocketPair) as [WebSocketWithMetadata, WebSocketWithMetadata];

        // Parse the URL and get all query parameters
        const url = new URL(request.url);
        const params = url.searchParams;

        // Create an object to store all query parameters
        const queryParams: Record<string, string> = {};
        params.forEach((value, key) => {
            queryParams[key] = value;
        });

        // If no ID was provided, generate one
        const connectionId = queryParams.id || crypto.randomUUID();

        // Store all query parameters in the WebSocket's attachment to persist across hibernation
        if (server.serializeAttachment) {
            server.serializeAttachment({
                connectionId,
                queryParams
            });
        }

        this.connections.set(connectionId, server);

        // Forward tags to Cloudflare's native acceptWebSocket for hibernation-safe filtering.
        // @see https://developers.cloudflare.com/durable-objects/api/state/#acceptwebsocket
        this.context?.acceptWebSocket(server, tags);

        return { client, server };
    }
}
