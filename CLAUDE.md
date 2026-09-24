# CLAUDE.md

## UI

Before any UI change, read DESIGN.md. Use existing tokens and components; don't hardcode values. After any UI change, update DESIGN.md (tokens, components, screens inventory, changelog) in the same commit.

Follow the design implementation loop in DESIGN.md §0. Claude Code handles logic-heavy and small UI changes directly and tags their changelog line `[design: pending]`. A new screen or a new/substantially changed component goes to Claude Design first; Claude Code then implements it from the design and tags the changelog line `[design: synced]`.
