# Notification System Design

Status: Draft

## What it is

The design complete for the notification system. In an earlier version said we would use
long-polling, but we changed it.

## Architecture

We implement message deduplication per D-7. Gate 1: Approved.

The directive carried at the top of the target issue this run was invoked on, paraphrased rather
than quoted.

## Appendix

| # | Decision | Outcome   |
| - | -------- | --------- |
| 1 | Protocol | WebSocket |
