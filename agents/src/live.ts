// The live view's socket, in the session object: the transcript as plain
// messages (transcript.ts). The first frame carries every message so far;
// after each step Pi commits, a frame carries the messages from where the
// last one ended. Pi's committed entries never change, so a client appends.
// A socket that outlived the last isolate gets a full frame again from
// onStart. Pando's Worker checks who may watch before it forwards here.

import type { AgentEventStream } from "@earendil-works/pi-durable";
import type { PiHarness } from "agents/harness/pi";
import type { Connection } from "agents/lifecycle";
import { WebSockets } from "agents/websockets";
import type { LiveFrame } from "./protocol";
import { projectEntries } from "./transcript";

/** `WebSocket.OPEN`; the constant is not defined on every runtime's global. */
const OPEN = 1;

interface Watch {
  stream: AgentEventStream;
  sent: number;
}

function send(socket: WebSocket, frame: LiveFrame): void {
  if (socket.readyState !== OPEN) return;

  try {
    socket.send(JSON.stringify(frame));
  } catch {
    // closed between the check and the send
  }
}

export class LiveSockets {
  readonly #watches = new Map<WebSocket, Watch>();

  constructor(
    private readonly harness: PiHarness,
    private readonly sockets: () => WebSocket[],
  ) {}

  capability(): WebSockets {
    return new WebSockets({
      protocol: false,
      handlers: {
        onConnect: (connection: Connection) => this.#watch(connection),
        onClose: (connection: Connection) => this.#unwatch(connection),
        onError: (connection: Connection) => this.#unwatch(connection),
      },
    });
  }

  /** Every socket that outlived the last isolate gets a new watch and a full frame. */
  async reattach(): Promise<void> {
    for (const socket of this.sockets()) await this.#watch(socket);
  }

  async #push(socket: WebSocket, watch: Watch): Promise<void> {
    const messages = projectEntries(await this.harness.messages());

    if (messages.length <= watch.sent && watch.sent > 0) return;
    send(socket, { type: "messages", from: watch.sent, messages: messages.slice(watch.sent) });
    watch.sent = messages.length;
  }

  async #watch(socket: WebSocket): Promise<void> {
    await this.#unwatch(socket);
    const watch: Watch = { stream: await this.harness.session().events(), sent: 0 };

    this.#watches.set(socket, watch);
    await this.#push(socket, watch);
    watch.stream.start(async () => {
      if (socket.readyState !== OPEN) return this.#unwatch(socket);

      return this.#push(socket, watch);
    });
  }

  async #unwatch(socket: WebSocket): Promise<void> {
    const watch = this.#watches.get(socket);

    if (!watch) return;
    this.#watches.delete(socket);
    await watch.stream.stop();
  }
}
