# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Use GitHub's private vulnerability reporting:

1. Open <https://github.com/so2bin/dsh-discord-bridge/security/advisories/new>
2. Describe the impact, reproduction steps, and affected version.

You should receive an acknowledgement within a few days.

## Credentials

- The Discord bot token is a password. Never commit it, paste it into issues,
  or include it in logs or screenshots.
- Prefer the `DISCORD_BOT_TOKEN` environment variable over a profile file.
- If a token is exposed, reset it immediately in the
  [Discord Developer Portal](https://discord.com/developers/applications).
- This repository ignores `.env`, `node_modules/`, and local `*.bak-*` copies.

## Deployment scope

The plugin runs inside the DSH Host process and inherits its tool and session
permissions. It is designed for a **single owner / private server**. Do not
deploy it as a public multi-tenant bot without adding your own authentication,
rate limiting, and audit layer.
