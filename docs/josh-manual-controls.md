# Josh's Manual Controls & Browser Profile Discipline

This document records manual controls, browser profile discipline, and credential boundary rules maintained by Josh Sherman.

## Browser Profile Discipline (`webjam.claude@gmail.com`)

1. **Human-Consumed Account Boundary**:
   - `webjam.claude@gmail.com` is a dedicated human-consumed Gmail account reserved for browser sessions and human-driven interactions (KeePass only).
   - Live credentials and account passwords belong strictly in KeePass. They must NEVER be exported into shell profiles (`.bashrc`, `.zshrc`), environment files (`.env`, `.env.*`), or application configuration files (`.json`, `.yaml`, `.toml`).

2. **Browser Profile Usage**:
   - Browser sessions requiring login for `webjam.claude@gmail.com` are managed directly by Josh in isolated browser profiles.
   - Autonomous AI agents and automated scripts must not log into or consume `webjam.claude@gmail.com` directly unless explicitly authorized by Josh.
