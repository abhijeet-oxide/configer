# telco-ran (sample repo)

A 5G RAN edge fleet: one folder per cell site under `sites/`, each with a Helm
values file (`values.yaml`), a NETCONF/YANG-modeled `radio.xml`, and shared
platform settings under `shared/`. A `values.schema.json` next to each site's
values drives validation of the YAML parameters. This exercises mixed YAML+XML
per instance, list parameters, and a large parameter surface.

Configer view:
- layout: plain-folders (one folder per site under `sites/`)
- base layer: `shared/platform.yaml`
- instance layer: `sites/<site>/values.yaml` and `sites/<site>/radio.xml`
- validation: `sites/<site>/values.schema.json`
