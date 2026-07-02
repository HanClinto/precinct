The Ohio Revised Code is not easy to navigate via its website, because sections are broken up, responses are slow, and there is no complete download. 

This is a public mirror, downloaded / updated regularly via Github Actions, intended to make the Ohio Revised Code (ORC) transparent and accessible for all.

The structure is organized by folder. Each section, chapter, and sub-section is downloaded into helpfully-titled subfolders, and the text of the ORC is formatted as Markdown. The first line of each .md file shows the URL that it was saved from, along with the date and time that it was scraped.

The text of the ORC will have minor formatting cleanup for readability and consistency (such as removal of footer links and whatnot). 

Care is taken to scrape and mirror the ORC in an organized fashion.

For efficiency, only our most relevant portions of the ORC (Title 35 - Elections) is scraped and mirrored here.

Source of ORC: https://codes.ohio.gov/ohio-revised-code

## Downloading the mirror

The current mirror script intentionally limits itself to Title 35 - Elections.
Run it from the repository root:

```sh
python3 reference/ohio-revised-code/code/orc_mirror.py
```

The script saves every fetched HTML page under `data/raw`, using paths that
match the requested ORC URL structure. Successful responses also get a small
`.json` metadata sidecar with the requested URL, effective URL, status, and
scrape time. Error responses are not cached. To keep requests low, the script
fetches the Title 35 page and chapter pages, then derives section Markdown from
the section bodies embedded in each chapter page instead of fetching every
section URL separately. It writes cleaned Markdown into
`data/formatted/Title 35 - Elections`, organized by chapter and section. Each
formatted Markdown file also gets a `.json` sidecar containing structured ORC
references found in the same body or index content, leaving the Markdown
readable while preserving reference data for future auto-linking.

By default, existing raw HTML is reused so interrupted runs can resume without
hammering the source site. Use `--force` to refresh already-downloaded pages and
`--delay SECONDS` to adjust the polite delay before uncached network requests.
Cached pages are read immediately.

Use `--offline` while tuning parsing and formatting. Offline mode reads only the
raw cache and fails if a required Title 35 page is missing, so it will not touch
the ORC website.

