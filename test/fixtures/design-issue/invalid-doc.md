# Notification System Design

Status: Draft

## What it is

The design complete for the notification system. In an earlier version said we would use
long-polling, but we changed it.

## Architecture

We implement message deduplication per D-7. Gate 1: Approved.

## Appendix

| # | Decision | Outcome   |
| - | -------- | --------- |
| 1 | Protocol | WebSocket |
