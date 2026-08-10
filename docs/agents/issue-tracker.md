# Issue tracker: GitHub

Specs and implementation tickets for this repository live in GitHub Issues at `Yaron9/MetaMe-private`. Use the `gh` CLI from this repository so the private `origin` remote is selected.

## Conventions

- Create issues with `gh issue create` and multi-line bodies from files.
- Read the complete issue and comments before implementation.
- Apply `ready-for-agent` to complete Specs and independently executable tickets.
- Publish ticket blockers as GitHub native issue dependencies when available; otherwise include explicit `Blocked by: #N` references in the issue body.
- Do not close or modify the parent Spec when publishing or completing child tickets.
- PRs are not an issue-triage request surface.

## Native blocking links

Resolve a blocker issue's numeric database ID, then create the dependency through GitHub's issue dependency endpoint. If the endpoint is unavailable, the issue-body blocker list is authoritative.
