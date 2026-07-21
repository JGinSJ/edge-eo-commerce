# harper-markdown-cache (component)

A one-table Harper component that declares the `markdown_cache` key/value store used by the
**md-cache** write-through scenario. It is NOT part of the prerender templates — the md-cache
path (EW `GET /markdown_cache/{key}` ↔ converter `PUT /markdown_cache/{key}`) needs this table,
so we declare it as a schema rather than hand-creating it.

## Deploy
Same mechanism as the prerender component — Operations API `deploy_component` or Studio → deploy
from Git. Harper creates the `cache.markdown_cache` table and its `/markdown_cache` REST endpoint
on deploy. Verify: `GET <node>/markdown_cache/x` returns **401** (present), not 404.

Only needed if the demo includes the md-cache scenario. Convert-cache + prerender (the HTML+MD CSR
path) use the prerender component's own tables and don't require this.
