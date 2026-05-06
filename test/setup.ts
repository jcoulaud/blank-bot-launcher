import { setMaxListeners } from "node:events";

// Parallel Store tests open many better-sqlite3 handles in one Vitest process.
// Each handle registers a process exit cleanup listener, so lift the test-only
// cap without changing production listener behavior.
setMaxListeners(Math.max(process.getMaxListeners(), 50), process);
