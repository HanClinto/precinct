const manifestPath = 'reference/ohio-revised-code/data/formatted/Title 35 - Elections/manifest.json';

const state = {
  manifest: null,
  activeSection: null,
  sectionIndex: [],
};

const els = {
  browserTitle: document.querySelector('#browserTitle'),
  collectionScope: document.querySelector('#collectionScope'),
  summary: document.querySelector('#summary'),
  chapterList: document.querySelector('#chapterList'),
  reader: document.querySelector('#reader'),
  references: document.querySelector('#referenceList'),
  search: document.querySelector('#searchInput'),
  download: document.querySelector('#downloadLink'),
};

init().catch((error) => {
  els.reader.innerHTML = `<div class="reader-empty">Could not load the reference data: ${escapeHtml(error.message)}</div>`;
});

async function init() {
  const manifest = await fetchJson(manifestPath);
  state.manifest = manifest;
  state.sectionIndex = manifest.chapters.flatMap((chapter) => chapter.sections.map((section) => ({ chapter, section })));

  els.browserTitle.textContent = manifest.scope;
  els.collectionScope.textContent = manifest.collection;
  els.summary.textContent = `${manifest.counts.chapters} chapters, ${manifest.counts.sections} sections`;
  els.download.href = manifest.downloads.zip;

  renderNavigation(manifest.chapters);
  bindSearch();

  const firstSection = manifest.chapters[0]?.sections[0];
  if (firstSection) {
    await openSection(firstSection.sourceUrl);
  }
}

function renderNavigation(chapters, query = '') {
  const normalizedQuery = normalize(query);
  els.chapterList.innerHTML = '';

  chapters.forEach((chapter, chapterIndex) => {
    const matchingSections = normalizedQuery
      ? chapter.sections.filter((section) => searchableText(chapter, section).includes(normalizedQuery))
      : chapter.sections;
    const chapterMatches = normalize(chapter.title).includes(normalizedQuery);
    if (normalizedQuery && !chapterMatches && matchingSections.length === 0) {
      return;
    }

    const block = document.createElement('div');
    block.className = `chapter-block ${chapterIndex === 0 || normalizedQuery ? 'open' : ''}`;

    const chapterButton = document.createElement('button');
    chapterButton.className = 'chapter-button';
    chapterButton.type = 'button';
    chapterButton.textContent = chapter.title;
    chapterButton.addEventListener('click', () => block.classList.toggle('open'));
    block.append(chapterButton);

    const sectionList = document.createElement('div');
    sectionList.className = 'section-list';
    matchingSections.forEach((section) => {
      const button = document.createElement('button');
      button.className = `section-button ${state.activeSection === section.sourceUrl ? 'active' : ''}`;
      button.type = 'button';
      button.textContent = section.title;
      button.addEventListener('click', () => openSection(section.sourceUrl));
      sectionList.append(button);
    });
    block.append(sectionList);
    els.chapterList.append(block);
  });

  if (!els.chapterList.children.length) {
    els.chapterList.innerHTML = '<div class="summary">No matching sections.</div>';
  }
}

function bindSearch() {
  els.search.addEventListener('input', () => {
    renderNavigation(state.manifest.chapters, els.search.value);
  });
}

async function openSection(sourceUrl) {
  const match = state.sectionIndex.find(({ section }) => section.sourceUrl === sourceUrl);
  if (!match) {
    return;
  }
  state.activeSection = sourceUrl;
  renderNavigation(state.manifest.chapters, els.search.value);

  const markdown = await fetchText(match.section.markdownPath);
  els.reader.innerHTML = renderMarkdown(markdown, els.search.value);
  els.reader.focus({ preventScroll: true });
  els.reader.scrollTop = 0;
  renderReferences(match.section.references);
}

function renderReferences(references) {
  if (!references?.length) {
    els.references.innerHTML = '<div class="muted-text">No ORC cross-references detected in this section.</div>';
    return;
  }
  els.references.innerHTML = references.map((reference) => {
    const local = state.sectionIndex.find(({ section }) => section.sourceUrl === reference.url);
    const attrs = local ? `href="#" data-source="${escapeHtml(reference.url)}"` : `href="${escapeHtml(reference.url)}" target="_blank" rel="noreferrer"`;
    return `<a class="reference-pill" ${attrs}>${escapeHtml(reference.label)}</a>`;
  }).join('');

  els.references.querySelectorAll('[data-source]').forEach((link) => {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      openSection(link.dataset.source);
    });
  });
}

function renderMarkdown(markdown, query = '') {
  const lines = markdown.split(/\r?\n/);
  const body = [];
  let listOpen = false;

  for (const line of lines) {
    if (!line.trim()) {
      if (listOpen) {
        body.push('</ul>');
        listOpen = false;
      }
      continue;
    }

    if (line.startsWith('Source:') || line.startsWith('Scraped:')) {
      body.push(`<p class="source-line">${formatInline(line)}</p>`);
      continue;
    }

    if (line.startsWith('# ')) {
      body.push(`<h1>${formatInline(line.slice(2))}</h1>`);
      continue;
    }

    if (line.startsWith('## ')) {
      body.push(`<h2>${formatInline(line.slice(3))}</h2>`);
      continue;
    }

    if (line.startsWith('- ')) {
      if (!listOpen) {
        body.push('<ul>');
        listOpen = true;
      }
      body.push(`<li>${formatInline(line.slice(2))}</li>`);
      continue;
    }

    if (listOpen) {
      body.push('</ul>');
      listOpen = false;
    }
    body.push(`<p>${formatInline(line)}</p>`);
  }

  if (listOpen) {
    body.push('</ul>');
  }

  const html = body.join('');
  return query ? highlight(html, query) : html;
}

function formatInline(text) {
  return escapeHtml(text).replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
}

function highlight(html, query) {
  const value = query.trim();
  if (!value) {
    return html;
  }
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return html.replace(new RegExp(`(${escaped})`, 'gi'), '<mark>$1</mark>');
}

function searchableText(chapter, section) {
  return normalize(`${chapter.title} ${section.title} ${section.number}`);
}

function normalize(value) {
  return String(value || '').toLowerCase();
}

async function fetchJson(path) {
  const response = await fetch(encodeURI(path));
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function fetchText(path) {
  const response = await fetch(encodeURI(path));
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.text();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
