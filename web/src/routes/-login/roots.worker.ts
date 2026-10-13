// Grows the sign-in page's root system (./graph.ts, about 200 ms of work) off
// the page's thread, so the page and its button never wait for it.
import { grow } from "./graph";

postMessage(grow());
