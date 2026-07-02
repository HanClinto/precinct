#!/usr/bin/env python3
"""Download and format Ohio Revised Code mirrors."""

from __future__ import annotations

import argparse
import datetime as dt
import html
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path

ORC_INDEX_URL = "https://codes.ohio.gov/ohio-revised-code"
DEFAULT_TITLE_NUMBER = "35"
DEFAULT_DELAY_SECONDS = 1.5
MAX_RETRIES = 4
USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"

ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = ROOT.parents[1]
RAW_DIR = ROOT / "data" / "raw"
FORMATTED_DIR = ROOT / "data" / "formatted"


@dataclass(frozen=True)
class Link:
    text: str
    href: str


@dataclass(frozen=True)
class Page:
    url: str
    html: str
    fetched_at: str
    effective_url: str | None = None
    status: int | None = None


class LinkParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.links: list[Link] = []
        self._href_stack: list[str | None] = []
        self._current_href: str | None = None
        self._current_text: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() != "a":
            return
        href = dict(attrs).get("href")
        self._href_stack.append(self._current_href)
        self._current_href = href
        self._current_text = []

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() != "a" or not self._href_stack:
            return
        if self._current_href:
            text = normalize_text("".join(self._current_text))
            self.links.append(Link(text=text, href=self._current_href))
        self._current_href = self._href_stack.pop()
        self._current_text = []

    def handle_data(self, data: str) -> None:
        if self._current_href is not None:
            self._current_text.append(data)


class MainContentParser(HTMLParser):
    BLOCK_TAGS = {"address", "article", "aside", "blockquote", "br", "dd", "div", "dl", "dt", "figcaption", "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "table", "td", "th", "tr", "ul"}
    SKIP_CLASSES = {"breadcrumbs", "footer-bottom", "footer-top", "no-print", "section-banner"}
    SKIP_TAGS = {"script", "style", "footer", "nav"}
    VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}

    def __init__(self, base_url: str) -> None:
        super().__init__(convert_charrefs=True)
        self.base_url = base_url
        self.parts: list[str] = []
        self.references: list[dict[str, str]] = []
        self._main_stack: list[str] = []
        self._skip_stack: list[bool] = []
        self._link_href: str | None = None
        self._link_text: list[str] = []
        self._seen_references: set[tuple[str, str]] = set()

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        attrs_dict = dict(attrs)
        classes = set((attrs_dict.get("class") or "").split())
        skip_current = tag in {"h1", *self.SKIP_TAGS} or classes.intersection(self.SKIP_CLASSES)
        if tag == "main" or self._main_stack:
            inherited_skip = self._skip_stack[-1] if self._skip_stack else False
            if tag not in self.VOID_TAGS:
                self._main_stack.append(tag)
                self._skip_stack.append(bool(inherited_skip or skip_current))

        if not self._capturing:
            return

        if tag == "a":
            self._link_href = attrs_dict.get("href")
            self._link_text = []
        if tag in self.BLOCK_TAGS:
            self._newline()
            if tag in {"li", "tr"}:
                self.parts.append("- ")

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if self._capturing and tag in self.BLOCK_TAGS:
            self._newline()
        if tag == "a":
            self._record_reference()
            self._link_href = None
            self._link_text = []
        if self._main_stack and self._main_stack[-1] == tag:
            self._main_stack.pop()
            self._skip_stack.pop()

    def handle_data(self, data: str) -> None:
        if not self._capturing:
            return
        text = normalize_text(data)
        if not text or text == "\xa0":
            return
        if self.parts and self.parts[-1] not in {"\n", "\n\n", "- "}:
            self.parts.append(" ")
        self.parts.append(text)
        if self._link_href:
            self._link_text.append(text)

    @property
    def _capturing(self) -> bool:
        return bool(self._main_stack) and not (self._skip_stack[-1] if self._skip_stack else False)

    def _newline(self) -> None:
        if not self.parts:
            return
        if self.parts[-1] == "\n\n":
            return
        if self.parts[-1] == "\n":
            self.parts[-1] = "\n\n"
        else:
            self.parts.append("\n")

    def _record_reference(self) -> None:
        if not self._link_href:
            return
        url = absolute_url(self._link_href, self.base_url)
        parsed = urllib.parse.urlparse(url)
        match = re.search(r"/ohio-revised-code/(section|chapter|title)-(\d+(?:\.\d+)?)", parsed.path)
        if not match:
            return
        kind, number = match.groups()
        key = (kind, number)
        if key in self._seen_references:
            return
        self._seen_references.add(key)
        self.references.append({
            "kind": kind,
            "number": number,
            "label": normalize_text(" ".join(self._link_text)) or number,
            "url": urllib.parse.urlunparse(parsed._replace(query="", fragment="")),
        })

    def markdown(self) -> str:
        text = "".join(self.parts)
        text = re.sub(r"[ \t]+\n", "\n", text)
        text = re.sub(r"\n{3,}", "\n\n", text)
        text = re.sub(r"^-\s*$\n?", "", text, flags=re.MULTILINE)
        return text.strip()


def normalize_text(value: str) -> str:
    value = html.unescape(value).replace("\xa0", " ")
    return re.sub(r"\s+", " ", value).strip()


def absolute_url(href: str, base_url: str) -> str:
    return urllib.parse.urljoin(base_url, href.split("#", 1)[0])


def raw_path_for_url(url: str) -> Path:
    parsed = urllib.parse.urlparse(url)
    parts = [part for part in parsed.path.split("/") if part]
    if not parts:
        parts = ["index"]
    return RAW_DIR.joinpath(*parts[:-1], f"{parts[-1]}.html")


def metadata_path_for_url(url: str) -> Path:
    return raw_path_for_url(url).with_suffix(".json")


def load_raw(url: str) -> Page | None:
    path = raw_path_for_url(url)
    if not path.exists():
        return None
    metadata_path = metadata_path_for_url(url)
    metadata: dict[str, str | int | None] = {}
    if metadata_path.exists():
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    return Page(
        url=url,
        html=path.read_text(encoding="utf-8"),
        fetched_at=str(metadata.get("fetched_at") or "previous run"),
        effective_url=metadata.get("effective_url") if isinstance(metadata.get("effective_url"), str) else None,
        status=metadata.get("status") if isinstance(metadata.get("status"), int) else None,
    )


def save_raw(page: Page) -> Path:
    path = raw_path_for_url(page.url)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(page.html, encoding="utf-8")
    metadata = {
        "requested_url": page.url,
        "effective_url": page.effective_url or page.url,
        "status": page.status,
        "fetched_at": page.fetched_at,
    }
    metadata_path_for_url(page.url).write_text(json.dumps(metadata, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return path


def log(message: str) -> None:
    print(message, flush=True)


def fetch(url: str, *, delay_seconds: float, force: bool, offline: bool) -> Page:
    if not force:
        saved = load_raw(url)
        if saved:
            log(f"cache  {url}")
            return saved
    if offline:
        raise FileNotFoundError(f"No cached raw HTML for {url}")

    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Connection": "close",
    }
    request = urllib.request.Request(url, headers=headers)
    last_error: Exception | None = None
    for attempt in range(1, MAX_RETRIES + 1):
        if delay_seconds > 0:
            time.sleep(delay_seconds)
        try:
            log(f"fetch  {url}")
            with urllib.request.urlopen(request, timeout=60) as response:
                status = response.getcode()
                if status < 200 or status >= 300:
                    raise RuntimeError(f"Unexpected HTTP status {status} while downloading {url}")
                charset = response.headers.get_content_charset() or "utf-8"
                page = Page(
                    url=url,
                    html=response.read().decode(charset, errors="replace"),
                    fetched_at=dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
                    effective_url=response.geturl(),
                    status=status,
                )
                save_raw(page)
                log(f"saved  {raw_path_for_url(url).relative_to(ROOT)}")
                return page
        except urllib.error.HTTPError as error:
            last_error = error
            if error.code == 429 and attempt < MAX_RETRIES:
                retry_after = error.headers.get("Retry-After")
                wait_seconds = int(retry_after) if retry_after and retry_after.isdigit() else max(60, delay_seconds * (attempt + 2))
                log(f"429    {url}; waiting {wait_seconds}s before retry {attempt + 1}/{MAX_RETRIES}")
                time.sleep(wait_seconds)
                continue
            raise
        except urllib.error.URLError as error:
            last_error = error
            if attempt < MAX_RETRIES:
                time.sleep(delay_seconds * (attempt + 1))
                continue
            raise
    raise RuntimeError(f"Could not fetch {url}: {last_error}")


def extract_links(page: Page, pattern: str, *, text_pattern: str | None = None) -> list[str]:
    parser = LinkParser()
    parser.feed(page.html)
    urls: list[str] = []
    seen: set[str] = set()
    regex = re.compile(pattern)
    text_regex = re.compile(text_pattern) if text_pattern else None
    for link in parser.links:
        if text_regex and not text_regex.search(link.text):
            continue
        url = absolute_url(link.href, page.url)
        if regex.search(urllib.parse.urlparse(url).path) and url not in seen:
            seen.add(url)
            urls.append(url)
    return urls


def extract_reference_links(page: Page, pattern: str, *, text_pattern: str | None = None) -> list[dict[str, str]]:
    parser = LinkParser()
    parser.feed(page.html)
    references: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    url_regex = re.compile(pattern)
    text_regex = re.compile(text_pattern) if text_pattern else None
    for link in parser.links:
        if text_regex and not text_regex.search(link.text):
            continue
        url = absolute_url(link.href, page.url)
        parsed = urllib.parse.urlparse(url)
        if not url_regex.search(parsed.path):
            continue
        reference = reference_for_url(url, link.text)
        if not reference:
            continue
        key = (reference["kind"], reference["number"])
        if key in seen:
            continue
        seen.add(key)
        references.append(reference)
    return references


def reference_for_url(url: str, label: str) -> dict[str, str] | None:
    parsed = urllib.parse.urlparse(url)
    match = re.search(r"/ohio-revised-code/(section|chapter|title)-(\d+(?:\.\d+)?)", parsed.path)
    if not match:
        return None
    kind, number = match.groups()
    return {
        "kind": kind,
        "number": number,
        "label": normalize_text(label).replace(" | ", " - ") or number,
        "url": urllib.parse.urlunparse(parsed._replace(query="", fragment="")),
    }


def embedded_section_pages(chapter_page: Page) -> list[Page]:
    pattern = re.compile(
        r'(?s)<span\s+id="content-head-\d+"\s+class="content-head">.*?'
        r'<a\s+href="(?P<href>section-\d+\.\d+)">(?P<title>.*?)</a>.*?'
        r'</span>(?P<body>.*?)(?=<span\s+id="content-head-\d+"\s+class="content-head">|</main>)'
    )
    pages: list[Page] = []
    for match in pattern.finditer(chapter_page.html):
        title = normalize_text(re.sub(r"<[^>]+>", " ", match.group("title"))).replace(" | ", " - ")
        url = absolute_url(match.group("href"), chapter_page.url)
        html_fragment = f"<main><h1>{html.escape(title)}</h1>{match.group('body')}</main>"
        pages.append(Page(
            url=url,
            html=html_fragment,
            fetched_at=chapter_page.fetched_at,
            effective_url=chapter_page.effective_url,
            status=chapter_page.status,
        ))
    return pages


def page_title(markup: str) -> str:
    match = re.search(r"<h1[^>]*>(.*?)</h1>", markup, flags=re.IGNORECASE | re.DOTALL)
    if not match:
        return "Ohio Revised Code"
    text = re.sub(r"<[^>]+>", " ", match.group(1))
    return normalize_text(text).replace(" | ", " - ")


def page_kind(url: str) -> str:
    parsed = urllib.parse.urlparse(url)
    if "/title-" in parsed.path:
        return "title"
    if "/chapter-" in parsed.path:
        return "chapter"
    if "/section-" in parsed.path:
        return "section"
    return "page"


def formatted_path_for_page(page: Page) -> Path:
    title = page_title(page.html)
    parsed = urllib.parse.urlparse(page.url)
    title_root = formatted_title_root(page)
    if "/title-" in parsed.path:
        return title_root / "README.md"

    chapter_match = re.search(r"/chapter-(\d+)", parsed.path)
    if chapter_match:
        return title_root / slug_filename(f"{title}.md")

    section_match = re.search(r"/section-(\d+\.\d+)", parsed.path)
    if section_match:
        section = section_match.group(1)
        chapter = section.split(".", 1)[0]
        return title_root / f"Chapter {chapter}" / slug_filename(f"{title}.md")

    return FORMATTED_DIR / slug_filename(f"{title}.md")


def formatted_title_root(page: Page) -> Path:
    title_number = title_number_for_url(page.url)
    title_page = load_raw(title_url(title_number)) if title_number else None
    if title_page:
        return FORMATTED_DIR / page_title(title_page.html)
    title_match = re.search(r"^Title\s+\d+\s+-\s+", page_title(page.html))
    if title_match:
        return FORMATTED_DIR / page_title(page.html)
    return FORMATTED_DIR / f"Title {title_number}" if title_number else FORMATTED_DIR


def title_number_for_url(url: str) -> str:
    parsed = urllib.parse.urlparse(url)
    title_match = re.search(r"/title-(\d+)", parsed.path)
    if title_match:
        return title_match.group(1)
    chapter_match = re.search(r"/chapter-(\d+)", parsed.path)
    if chapter_match:
        chapter_number = chapter_match.group(1)
        return chapter_number[:-2] if len(chapter_number) > 2 else chapter_number
    section_match = re.search(r"/section-(\d+)", parsed.path)
    if section_match:
        chapter_number = section_match.group(1)
        return chapter_number[:-2] if len(chapter_number) > 2 else chapter_number
    return ""


def title_url(title_number: str) -> str:
    return f"{ORC_INDEX_URL}/title-{title_number}"


def slug_filename(name: str) -> str:
    suffix = ".md" if name.endswith(".md") else ""
    if suffix:
        name = name[: -len(suffix)]
    name = re.sub(r"[\\/:*?\"<>|]+", "-", name)
    name = re.sub(r"\s+", " ", name).strip(" .")
    return f"{name}.md"


def format_page(page: Page) -> Path:
    title = page_title(page.html)
    kind = page_kind(page.url)
    glossary: list[dict[str, str]] = []
    if kind == "title":
        references = extract_reference_links(page, r"/ohio-revised-code/chapter-\d+", text_pattern=r"^Chapter\s+\d+")
        body = index_markdown("Chapters", references)
    elif kind == "chapter":
        references = extract_reference_links(page, r"/ohio-revised-code/section-\d+\.\d+", text_pattern=r"^Section\s+\d+\.\d+")
        body = index_markdown("Sections", references)
    else:
        parser = MainContentParser(page.url)
        parser.feed(page.html)
        body = clean_section_markdown(parser.markdown())
        references = parser.references
        glossary = extract_glossary(body, page.url, title)
    path = formatted_path_for_page(page)
    path.parent.mkdir(parents=True, exist_ok=True)
    content = f"Source: {page.url}\nScraped: {page.fetched_at}\n\n# {title}\n\n{body}\n"
    path.write_text(content, encoding="utf-8")
    metadata = {
        "kind": kind,
        "title": title,
        "source_url": page.url,
        "scraped": page.fetched_at,
        "references": references,
        "glossary": glossary,
    }
    path.with_suffix(".json").write_text(json.dumps(metadata, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    log(f"wrote  {path.relative_to(ROOT)}")
    return path


def index_markdown(heading: str, references: list[dict[str, str]]) -> str:
    lines = [f"## {heading}", ""]
    lines.extend(f"- {reference['label']}" for reference in references)
    return "\n".join(lines).strip()


def clean_section_markdown(markdown: str) -> str:
    markdown = re.sub(r"(?m)^(Effective|Latest Legislation):\n\n([^\n]+)$", r"**\1:** \2", markdown)
    return markdown.strip()


def extract_glossary(markdown: str, source_url: str, source_title: str) -> list[dict[str, str]]:
    lines = [line.strip() for line in markdown.splitlines()]
    definitions: list[tuple[int, list[str], str]] = []
    current_scope = ""
    for index, line in enumerate(lines):
        if not line:
            continue
        if "as used" in line.lower() and line.endswith(":"):
            current_scope = line
            continue
        terms = quoted_definition_terms(line)
        if terms:
            definitions.append((index, terms, current_scope))

    entries: list[dict[str, str]] = []
    section_number = section_number_for_url(source_url)
    for position, (start_index, terms, scope) in enumerate(definitions):
        end_index = definitions[position + 1][0] if position + 1 < len(definitions) else len(lines)
        definition = "\n\n".join(line for line in lines[start_index:end_index] if line)
        for term in terms:
            entries.append({
                "id": glossary_id(section_number, term),
                "term": term,
                "normalized": normalize_glossary_term(term),
                "definition": definition,
                "scope": scope,
                "source_title": source_title,
                "source_url": source_url,
                "section": section_number,
            })
    return entries


def quoted_definition_terms(line: str) -> list[str]:
    if "\"" not in line:
        return []
    definition_match = re.search(r'((?:"[^"]+"\s*(?:,?\s*(?:or|and)\s*)?)+)\s+(means?|includes?|does not include|has the same meaning|have the same meaning)\b', line, flags=re.IGNORECASE)
    if not definition_match:
        return []
    return [normalize_text(term) for term in re.findall(r'"([^"]+)"', definition_match.group(1))]


def section_number_for_url(url: str) -> str:
    match = re.search(r"/section-(\d+(?:\.\d+)?)", urllib.parse.urlparse(url).path)
    return match.group(1) if match else ""


def normalize_glossary_term(term: str) -> str:
    return normalize_text(term).lower()


def glossary_id(section_number: str, term: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", normalize_glossary_term(term)).strip("-")
    return f"{section_number}-{slug}" if section_number else slug


def add_glossary_uses(glossary_entries: list[dict[str, object]], chapters: list[dict[str, object]]) -> None:
    sections = [section for chapter in chapters for section in chapter["sections"]]
    section_text: dict[str, str] = {}
    for section in sections:
        markdown_path = REPO_ROOT / str(section["markdownPath"])
        section_text[str(section["sourceUrl"])] = searchable_markdown(markdown_path.read_text(encoding="utf-8"))

    for entry in glossary_entries:
        term = str(entry["term"])
        pattern = re.compile(rf"\b{re.escape(term)}\b", flags=re.IGNORECASE)
        uses = []
        for section in applicable_sections(entry, sections):
            text = section_text[str(section["sourceUrl"])]
            matches = list(pattern.finditer(text))
            if not matches:
                continue
            uses.append({
                "section": section["number"],
                "title": section["title"],
                "source_url": section["sourceUrl"],
                "count": len(matches),
                "context": context_snippet(text, matches[0].start()),
            })
        entry["uses"] = uses


def searchable_markdown(markdown: str) -> str:
    lines = [
        line for line in markdown.splitlines()
        if not line.startswith(("Source:", "Scraped:", "# "))
    ]
    return normalize_text(" ".join(lines))


def applicable_sections(entry: dict[str, object], sections: list[dict[str, object]]) -> list[dict[str, object]]:
    chapter_range = chapter_range_for_scope(str(entry.get("scope") or ""))
    if chapter_range:
        return [section for section in sections if chapter_range[0] <= chapter_number(section) <= chapter_range[1]]
    return [section for section in sections if section["number"] == entry.get("section")]


def chapter_range_for_scope(scope: str) -> tuple[int, int] | None:
    range_pattern = re.compile(r"Chapters?\s+(\d+)\.?\s+(?:to|through|-)\s+(\d+)\.?")
    range_match = range_pattern.search(scope)
    if range_match:
        return int(range_match.group(1)), int(range_match.group(2))
    single_pattern = re.compile(r"Chapter\s+(\d+)\.?")
    single_match = single_pattern.search(scope)
    if single_match:
        chapter = int(single_match.group(1))
        return chapter, chapter
    return None


def chapter_number(section: dict[str, object]) -> int:
    return int(str(section["number"]).split(".", 1)[0])


def context_snippet(text: str, index: int) -> str:
    start = max(0, index - 70)
    end = min(len(text), index + 100)
    prefix = "..." if start else ""
    suffix = "..." if end < len(text) else ""
    return f"{prefix}{text[start:end]}{suffix}"


def write_manifest(title_root: Path) -> Path:
    title_metadata = json.loads((title_root / "README.json").read_text(encoding="utf-8"))
    chapters = []
    glossary_entries = []
    section_count = 0
    for chapter_reference in title_metadata["references"]:
        chapter_metadata_path = find_metadata_by_source_url(title_root, chapter_reference["url"])
        chapter_metadata = json.loads(chapter_metadata_path.read_text(encoding="utf-8"))
        chapter_markdown_path = chapter_metadata_path.with_suffix(".md")
        sections = []
        for section_reference in chapter_metadata["references"]:
            section_metadata_path = find_metadata_by_source_url(title_root / f"Chapter {chapter_reference['number']}", section_reference["url"])
            section_metadata = json.loads(section_metadata_path.read_text(encoding="utf-8"))
            section_glossary = section_metadata.get("glossary", [])
            sections.append({
                "number": section_reference["number"],
                "title": section_metadata["title"],
                "sourceUrl": section_metadata["source_url"],
                "markdownPath": repo_relative_path(section_metadata_path.with_suffix(".md")),
                "metadataPath": repo_relative_path(section_metadata_path),
                "references": section_metadata["references"],
                "glossary": section_glossary,
            })
            glossary_entries.extend(dict(entry) for entry in section_glossary)
        section_count += len(sections)
        chapters.append({
            "number": chapter_reference["number"],
            "title": chapter_metadata["title"],
            "sourceUrl": chapter_metadata["source_url"],
            "markdownPath": repo_relative_path(chapter_markdown_path),
            "metadataPath": repo_relative_path(chapter_metadata_path),
            "sections": sections,
        })

    add_glossary_uses(glossary_entries, chapters)
    glossary_entries = sorted(glossary_entries, key=lambda entry: (entry["normalized"], entry["section"]))

    manifest = {
        "collection": "Ohio Revised Code",
        "title": title_metadata["title"],
        "scope": title_root.name,
        "sourceUrl": title_metadata["source_url"],
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "counts": {
            "chapters": len(chapters),
            "sections": section_count,
            "glossaryTerms": len(glossary_entries),
        },
        "downloads": {
            "zip": "https://github.com/HanClinto/precinct/releases/download/orc-latest/ohio-revised-code.zip",
        },
        "glossary": {
            "entries": glossary_entries,
        },
        "markdownPath": repo_relative_path(title_root / "README.md"),
        "metadataPath": repo_relative_path(title_root / "README.json"),
        "chapters": chapters,
    }
    path = title_root / "manifest.json"
    path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    log(f"wrote  {path.relative_to(ROOT)}")
    return path


def write_title_index() -> Path:
    titles = []
    for manifest_path in sorted(FORMATTED_DIR.glob("Title * - */manifest.json"), key=title_sort_key):
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        titles.append({
            "collection": manifest["collection"],
            "scope": manifest["scope"],
            "sourceUrl": manifest["sourceUrl"],
            "manifestPath": repo_relative_path(manifest_path),
            "counts": manifest["counts"],
        })
    path = FORMATTED_DIR / "titles.json"
    path.write_text(json.dumps({"titles": titles}, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    log(f"wrote  {path.relative_to(ROOT)}")
    return path


def title_sort_key(path: Path) -> tuple[int, str]:
    match = re.match(r"Title\s+(\d+)\s+-", path.parent.name)
    return (int(match.group(1)) if match else 9999, path.parent.name)


def find_metadata_by_source_url(root: Path, source_url: str) -> Path:
    for path in root.rglob("*.json"):
        if path.name == "manifest.json":
            continue
        metadata = json.loads(path.read_text(encoding="utf-8"))
        if metadata.get("source_url") == source_url:
            return path
    raise FileNotFoundError(f"No formatted metadata found for {source_url}")


def repo_relative_path(path: Path) -> str:
    return path.relative_to(REPO_ROOT).as_posix()


def title_urls_for_run(*, all_titles: bool, title_numbers: list[str], delay_seconds: float, force: bool, offline: bool) -> list[str]:
    if title_numbers:
        return [title_url(number) for number in title_numbers]
    if not all_titles:
        return [title_url(DEFAULT_TITLE_NUMBER)]
    index_page = fetch(ORC_INDEX_URL, delay_seconds=delay_seconds, force=force, offline=offline)
    return extract_links(index_page, r"/ohio-revised-code/title-\d+", text_pattern=r"^Title\s+\d+")


def download_mirror(*, force: bool, delay_seconds: float, offline: bool, all_titles: bool, title_numbers: list[str]) -> tuple[int, int]:
    raw_count = 0
    formatted_count = 0
    title_urls = title_urls_for_run(all_titles=all_titles, title_numbers=title_numbers, delay_seconds=delay_seconds, force=force, offline=offline)
    if all_titles and not title_numbers:
        raw_count += 1
    log(f"found  {len(title_urls)} ORC titles")

    for title_index, current_title_url in enumerate(title_urls, start=1):
        log(f"title  {title_index}/{len(title_urls)} {current_title_url}")
        title_page = fetch(current_title_url, delay_seconds=delay_seconds, force=force, offline=offline)
        raw_count += 1
        title_markdown_path = format_page(title_page)
        formatted_count += 1

        chapter_urls = extract_links(title_page, r"/ohio-revised-code/chapter-\d+", text_pattern=r"^Chapter\s+\d+")
        log(f"found  {len(chapter_urls)} chapters in {page_title(title_page.html)}")
        for chapter_index, chapter_url in enumerate(chapter_urls, start=1):
            log(f"chapter {chapter_index}/{len(chapter_urls)} {chapter_url}")
            chapter_page = fetch(chapter_url, delay_seconds=delay_seconds, force=force, offline=offline)
            raw_count += 1
            format_page(chapter_page)
            formatted_count += 1
            section_pages = embedded_section_pages(chapter_page)
            log(f"found  {len(section_pages)} embedded sections in {chapter_url}")
            for section_index, section_page in enumerate(section_pages, start=1):
                log(f"section {section_index}/{len(section_pages)} {section_page.url}")
                format_page(section_page)
                formatted_count += 1

        write_manifest(title_markdown_path.parent)
    write_title_index()
    return raw_count, formatted_count


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Download and format ORC mirrors.")
    parser.add_argument("--force", action="store_true", help="Download pages even when raw HTML already exists.")
    parser.add_argument("--offline", action="store_true", help="Use only cached raw HTML and never make network requests.")
    parser.add_argument("--delay", type=float, default=DEFAULT_DELAY_SECONDS, help="Seconds to wait before each request.")
    parser.add_argument("--all-titles", action="store_true", help="Download every numeric ORC title listed on the ORC index page.")
    parser.add_argument("--title", action="append", default=[], help="Download one ORC title number. May be provided multiple times. Defaults to 35.")
    args = parser.parse_args()
    if args.force and args.offline:
        parser.error("--force cannot be used with --offline")
    return args


def main() -> int:
    args = parse_args()
    try:
        raw_count, formatted_count = download_mirror(force=args.force, delay_seconds=args.delay, offline=args.offline, all_titles=args.all_titles, title_numbers=args.title)
    except urllib.error.HTTPError as error:
        print(f"HTTP error while downloading {error.url}: {error.code} {error.reason}", file=sys.stderr)
        return 1
    except urllib.error.URLError as error:
        print(f"Network error while downloading ORC mirror: {error.reason}", file=sys.stderr)
        return 1
    except FileNotFoundError as error:
        print(error, file=sys.stderr)
        return 1
    except RuntimeError as error:
        print(error, file=sys.stderr)
        return 1

    print(f"Processed {raw_count} raw HTML pages and wrote {formatted_count} formatted Markdown files.")
    print(f"Raw HTML: {RAW_DIR}")
    print(f"Formatted Markdown: {FORMATTED_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
