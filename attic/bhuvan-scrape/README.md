# Quarantine — legacy Bhuvan scrape

**Status:** archived, not shipped, not served, not referenced by any code in this repository.

## What these files are

An unmaintained scrape of the ISRO **Bhuvan** geospatial portal
(`bhuvan.nrsc.gov.in`), captured circa 2002–2003 and used as a
reference for map/thematic-layer interaction patterns.

| File | Notes |
|---|---|
| `bhuvan_slider.js` | **ShinSoft "cross browser" DOM library, 1998–2002** (author: Shinichi Hagiwara) |
| `bhuvan_script1.js` | Bhuvan thematic-map page script |
| `bhuvan_script2.js` | Bhuvan/OpenLayers map controller script |
| `bhuvan_index.html` | Captured page shell |
| `bhuvan_tooldown1.html` | Captured download page |

## Why they were moved

`bhuvan_slider.js` calls `eval()` in **five** places:

- line 94 — `eval(s + 'document.layers.' + nm)`
- line 497 — `eval('div.style.' + nm + '=value')`
- line 2281 — `eval(e[i])`
- line 3461 — `eval(evalStr)`
- line 3593 — `eval(functionName + '();')`

These are legacy `document.layers` (Netscape Navigator 4) idioms that
no modern engine needs, and each one is a DOM-XSS-reachable sink if any
untrusted value ever reaches it. None of it is required by the
extension.

## Verification

Nothing in the repository references these files. The only `bhuvan`
string in application code is a *domain* entry in the agent's site
list (`extension/src/entrypoints/background/index.ts:439`), which is
unrelated to these files.

```bash
grep -rln "bhuvan_script\|bhuvan_slider\|bhuvan_tooldown" \
  --include=*.html --include=*.js --include=*.ts .
# → no matches
```

## If you need them

They remain in git history and can be restored:

```bash
git mv attic/bhuvan-scrape/<file> .
```

Do **not** load these into the extension, a web page, or any context
with a Content Security Policy. If you need map-layer interaction,
implement it against the current OpenLayers API instead.
