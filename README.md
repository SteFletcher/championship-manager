# Championship Manager - Design Package

**[View the Design Documentation](https://stefletcher.github.io/championship-manager/design/)**

## Testing

The test layers are intentionally separate:

- `npm test` runs the fast unit, invariant, and golden-master tests.
- `npm run test:play` runs deterministic rule-based career simulations and FUN regression gates.
- `npm run playtest:report` runs five seasons for each manager policy and writes `.playtest-results/latest.json`.
- `npm run test:ui` starts a local server and runs the seeded browser journey. Pass a Chromium-family executable as the first argument if Brave is not installed.
- `npm run test:full` runs all three layers.

The playtest suite lives in `test/playtest/`. It does not call agents, models, or network services. A fixed career seed plus deterministic manager policies makes every decision, match, season, and score reproducible. The FUN score measures drama, variety, decision agency, progression, and pacing. It is a regression signal for the design, not a replacement for human playtesting.

This repository contains the comprehensive design package for Championship Manager, a retro football management career game.

The design documentation provides a waterfall-style overview of the application, including:
- Requirements & Personas
- System Architecture & Data Model
- Engine Specifications & Test Plan
- UI Design & Table Layouts
- Project Plan, Risk Register, and Roadmaps

Click the link above to view the published HTML design documents.
