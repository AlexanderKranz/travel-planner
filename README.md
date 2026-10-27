# travel-planner

Plan trips with saved context: optional travel groups (members' ages always up to date), reusable trip purposes and home airports. Get a travel plan with weather, verified direct flights and a day-by-day itinerary that you can iterate on, share by link and export as PDF.

- Architecture & roadmap: [docs/architecture.md](docs/architecture.md)
- Setting up hosting: [docs/hosting-setup.md](docs/hosting-setup.md)
- Working with Claude Code (rules + agent team): [CLAUDE.md](CLAUDE.md), [.claude/agents/](.claude/agents/)

## Development
```bash
cp .env.example .env.local
npm install
npm run dev        # http://localhost:3000
npm test           # unit tests
npm run lint && npm run typecheck
```
