# Repository guidance

Companion is a Pi extension for independently accessible conversations and local
destination knowledge. Before changing behavior, read:

- [README.md](README.md): installation, public usage and operational limits.
- [docs/GLOSSARY.md](docs/GLOSSARY.md): domain language.
- [docs/DESIGN.md](docs/DESIGN.md): model, responsibilities and contracts.
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md): style and validation.
- [test/SCENARIOS.md](test/SCENARIOS.md): behavioral obligations.

The package also includes [skills/companions/SKILL.md](skills/companions/SKILL.md)
for bounded work in independent conversations. Read it when that trigger matches.

Maintained docs describe current contracts; planning, review history and test-run
evidence belong in tickets or review artifacts. Surface conflicts between the
assignment, guidance and implementation instead of guessing. Bounded work does
not authorize wholesale refactoring or new functionality.

Use isolated state and owned resources for tests. Package preparation is not
permission to modify operator installations, settings or running sessions.
When delegating, name the actual checkout and require its guidance to be read;
a conversation does not automatically acquire another checkout's context.
