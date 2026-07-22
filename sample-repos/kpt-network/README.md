# kpt-network (sample repo)

A kpt package fleet: each folder under `packages/` is a KRM package (carries a
Kptfile) for one region. kpt setter comments (`# kpt-set: ${name}`) mark the
values meant to vary per package; Configer names those parameters after their
setters.

Configer view:
- layout: kpt (each Kptfile package is one instance)
- skipped: Kptfile (package metadata)
- setter-annotated keys surface with the setter's name as display name.
