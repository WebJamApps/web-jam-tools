# Real-time WebSocket Notifications — Design

## What it is

A notification delivery service that pushes real-time event updates to connected web clients.

## Architecture

The service attaches to the existing WebSocket server and listens for event streams.

| Mechanism         | Description                       |
| ----------------- | --------------------------------- |
| Stream Listener   | Subscribes to backend event topic |
| Client Dispatcher | Pushes messages to active sockets |

## Both surfaces

How this mechanism functions across agent surfaces:

| Mechanism    | Claude Code                | agy/Antigravity |
| ------------ | -------------------------- | --------------- |
| CLI runner   | `deno task monitor:uptime` | identical       |
| Verification | Unit tests in CI           | identical       |

## Appendix A — Decision Record

| # | Decision                  | Outcome    | Rejected alternatives |
| - | ------------------------- | ---------- | --------------------- |
| 1 | Transport layer selection | WebSocket  | Long-polling HTTP     |
| 2 | Heartbeat interval        | 30 seconds | 60 seconds            |
