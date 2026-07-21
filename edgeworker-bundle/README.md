# EdgeWorker bundle

`bundle.tgz` is the built unified read-only EdgeWorker, **v2.4.0** (unchanged from the main
repo `edge-engine-optimization/edgeworker/`). It is committed here so this deployment repo is
self-sufficient for standing up the new property's EdgeWorker.

## Apply to the new EW
1. Akamai Control Center → EdgeWorkers → **create the new EW ID** → **Create Version**.
2. Upload `bundle.tgz` (registers as v2.4.0).
3. **Activate on Staging** (then Production later).
4. Configure the property's `PMUSER_*` variables — see `../DEPLOY.md` Phase 5.

## Rebuild (if the EW code changes upstream)
In the main repo: `cd edgeworker && ./build.sh` → produces `bundle.tgz` → copy it here.
Verify the version: `tar -xzOf bundle.tgz bundle.json`.
