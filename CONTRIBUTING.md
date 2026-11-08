# Contributing

Thanks for improving `dsh-discord-bridge`.

## Development

Requirements: Node.js 22.12+.

```bash
git clone https://github.com/so2bin/dsh-discord-bridge.git
cd dsh-discord-bridge
npm install
npm test
```

To load the working copy into DSH:

```bash
dsh plugin --profile <profile> add /absolute/path/to/dsh-discord-bridge
```

Restart or reload the profile after changing `index.js` / `discord.js`.

## Layout

```text
index.js             Cordis plugin entry: lifecycle, bindings, commands, inbound/outbound
discord.js           Minimal Discord REST + Gateway client (no discord.js dependency)
cordis.patch.yml     Default bundle mount with empty config
locale/              en / zh strings
test/                node:test unit tests
```

## Guidelines

- Keep the dependency surface small; `ws` and `https-proxy-agent` are intentional.
- Never commit a bot token, `.env` file, or profile config containing credentials.
- Add a unit test for pure helpers when changing `chunkText`, attachment handling, or message assembly.
- Keep the README user-facing; put maintainer notes here.
- Describe the user-visible behavior in the PR, including any Discord permission changes.

## Security

Report vulnerabilities privately via [SECURITY.md](./SECURITY.md), not a public issue.
