const titleIndexPath = 'reference/ohio-revised-code/data/formatted/titles.json';
const defaultTitleScope = 'Title 35 - Elections';

const state = {
  titleIndex: [],
  manifest: null,
  currentTitle: null,
  activeSection: null,
  sectionIndex: [],
  glossaryEntries: [],
  glossaryByTerm: new Map(),
  visibleGlossary: [],
  termUses: new Map(),
};

const els = {
  browserTitle: document.querySelector('#browserTitle'),
  collectionScope: document.querySelector('#collectionScope'),
  summary: document.querySelector('#summary'),
  chapterList: document.querySelector('#chapterList'),
  reader: document.querySelector('#reader'),
  references: document.querySelector('#referenceList'),
  glossary: document.querySelector('#glossaryList'),
  titleSelect: document.querySelector('#titleSelect'),
  glossaryPanel: document.querySelector('.glossary-panel'),
  glossaryResizeHandle: document.querySelector('#glossaryResizeHandle'),
  sectionsToggle: document.querySelector('#sectionsToggle'),
  sectionsClose: document.querySelector('#sectionsClose'),
  sectionsBackdrop: document.querySelector('#sectionsBackdrop'),
  sectionNav: document.querySelector('#sectionNav'),
  search: document.querySelector('#searchInput'),
  download: document.querySelector('#downloadLink'),
};

init().catch((error) => {
  els.reader.innerHTML = `<div class="reader-empty">Could not load the reference data: ${escapeHtml(error.message)}</div>`;
});

async function init() {
  const titleIndex = await fetchJson(titleIndexPath);
  state.titleIndex = titleIndex.titles || [];
  renderTitleSelect();
  bindTitleSelect();

  const route = routeFromLocation();
  const title = titleForRoute(route) || state.titleIndex.find((candidate) => candidate.scope === defaultTitleScope) || state.titleIndex[0];
  if (!title) {
    throw new Error('No ORC titles are available.');
  }
  await loadTitle(title, { route, replace: true });

  bindSearch();
  bindSectionsMenu();
  bindGlossaryNavigation();
  bindGlossaryResize();
  bindRouteNavigation();
}

async function loadTitle(title, options = {}) {
  const manifest = await fetchJson(title.manifestPath);
  state.currentTitle = title;
  state.manifest = manifest;
  state.sectionIndex = manifest.chapters.flatMap((chapter) => chapter.sections.map((section) => ({ chapter, section })));
  state.glossaryEntries = await loadGlossary(manifest);
  state.glossaryByTerm = buildGlossaryLookup(state.glossaryEntries);
  state.activeSection = null;
  state.visibleGlossary = [];
  state.termUses = new Map();

  els.browserTitle.textContent = manifest.scope;
  els.collectionScope.textContent = manifest.collection;
  els.summary.textContent = `${manifest.counts.chapters} chapters, ${manifest.counts.sections} sections`;
  els.download.href = manifest.downloads.zip;
  els.download.textContent = manifest.scope === defaultTitleScope ? 'Download ORC Title 35 ZIP' : 'Download ORC ZIP';
  els.titleSelect.value = title.manifestPath;

  renderNavigation(manifest.chapters);

  const firstSection = manifest.chapters[0]?.sections[0];
  const route = options.route || {};
  const routedSection = sectionForRoute(route) || firstSection;
  if (routedSection) {
    await openSection(routedSection.sourceUrl, { replace: options.replace, term: route.term });
  }
}

function renderTitleSelect() {
  els.titleSelect.innerHTML = state.titleIndex.map((title) => (
    `<option value="${escapeHtml(title.manifestPath)}">${escapeHtml(title.scope)}</option>`
  )).join('');
}

function bindTitleSelect() {
  els.titleSelect.addEventListener('change', async () => {
    const title = state.titleIndex.find((candidate) => candidate.manifestPath === els.titleSelect.value);
    if (!title || title.manifestPath === state.currentTitle?.manifestPath) {
      return;
    }
    els.search.value = '';
    await loadTitle(title, { replace: false });
  });
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
      button.addEventListener('click', () => {
        closeSectionsMenu();
        openSection(section.sourceUrl);
      });
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
    openSectionsMenu();
  });
}

function bindSectionsMenu() {
  els.sectionsToggle.addEventListener('click', () => {
    const isOpen = document.body.classList.contains('sections-open');
    if (isOpen) {
      closeSectionsMenu();
    } else {
      openSectionsMenu();
    }
  });
  els.sectionsClose.addEventListener('click', closeSectionsMenu);
  els.sectionsBackdrop.addEventListener('click', closeSectionsMenu);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeSectionsMenu();
    }
  });
}

function openSectionsMenu() {
  document.body.classList.add('sections-open');
  els.sectionsToggle.setAttribute('aria-expanded', 'true');
}

function closeSectionsMenu() {
  document.body.classList.remove('sections-open');
  els.sectionsToggle.setAttribute('aria-expanded', 'false');
}

function bindGlossaryResize() {
  els.glossaryResizeHandle.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = els.glossaryPanel.getBoundingClientRect().height;
    const minHeight = 180;
    const maxHeight = Math.round(window.innerHeight * 0.7);

    els.glossaryResizeHandle.setPointerCapture(event.pointerId);
    document.body.classList.add('resizing-glossary');

    const resize = (moveEvent) => {
      const nextHeight = Math.min(maxHeight, Math.max(minHeight, startHeight + startY - moveEvent.clientY));
      document.documentElement.style.setProperty('--glossary-height', `${Math.round(nextHeight)}px`);
    };

    const stopResize = () => {
      document.body.classList.remove('resizing-glossary');
      els.glossaryResizeHandle.removeEventListener('pointermove', resize);
      els.glossaryResizeHandle.removeEventListener('pointerup', stopResize);
      els.glossaryResizeHandle.removeEventListener('pointercancel', stopResize);
    };

    els.glossaryResizeHandle.addEventListener('pointermove', resize);
    els.glossaryResizeHandle.addEventListener('pointerup', stopResize);
    els.glossaryResizeHandle.addEventListener('pointercancel', stopResize);
  });
}

function bindRouteNavigation() {
  window.addEventListener('popstate', handleRouteNavigation);
  window.addEventListener('hashchange', handleRouteNavigation);
}

async function handleRouteNavigation() {
  const route = routeFromLocation();
  const title = titleForRoute(route);
  if (title && title.manifestPath !== state.currentTitle?.manifestPath) {
    await loadTitle(title, { route, replace: true });
    return;
  }
  const section = sectionForRoute(route);
  if (section) {
    await openSection(section.sourceUrl, { updateUrl: false, term: route.term });
  }
}

async function openSection(sourceUrl, options = {}) {
  const match = state.sectionIndex.find(({ section }) => section.sourceUrl === sourceUrl);
  if (!match) {
    return;
  }
  state.activeSection = sourceUrl;
  renderNavigation(state.manifest.chapters, els.search.value);

  const markdown = await fetchText(match.section.markdownPath);
  const glossaryEntries = glossaryEntriesForMarkdown(markdown, match.section);
  els.reader.innerHTML = renderMarkdown(markdown, els.search.value);
  annotateGlossaryTerms(els.reader, glossaryEntries);
  els.reader.focus({ preventScroll: true });
  els.reader.scrollTop = 0;
  renderReferences(match.section.references);
  renderGlossary(glossaryEntries);
  if (options.updateUrl !== false) {
    updateRoute(match.section, options.term, { replace: options.replace });
  }
  if (options.term) {
    focusGlossaryTerm(options.term, { updateUrl: false });
  }
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

function renderGlossary(entries, activeTerm = '') {
  state.visibleGlossary = entries;
  if (!entries.length) {
    els.glossary.innerHTML = '<div class="muted-text">No glossary terms detected in this section.</div>';
    return;
  }

  els.glossary.innerHTML = entries.map((entry) => {
    const activeClass = entry.normalized === activeTerm ? ' active' : '';
    const uses = state.termUses.get(entry.normalized) || [];
    return `<article class="glossary-entry${activeClass}" id="glossary-${escapeHtml(entry.id)}" data-term="${escapeHtml(entry.normalized)}">
      <h4>${escapeHtml(entry.term)}</h4>
      <p class="glossary-scope">${escapeHtml(entry.scope || entry.source_title)}</p>
      <div class="glossary-definition">${formatGlossaryDefinition(entry, entries)}</div>
      ${formatGlossaryUses(entry, uses)}
      <a class="glossary-source" href="${escapeHtml(entry.source_url)}" target="_blank" rel="noreferrer">${escapeHtml(entry.source_title)}</a>
    </article>`;
  }).join('');
}

function formatGlossaryUses(entry, uses) {
  if (!uses.length) {
    return '<p class="glossary-uses-empty">No uses detected in the active section.</p>';
  }
  const items = uses.map((use) => `<li><button type="button" data-use-id="${escapeHtml(use.id)}">${escapeHtml(use.context)}</button></li>`).join('');
  return `<div class="glossary-uses">
    <button class="glossary-uses-toggle" type="button" aria-expanded="false">Used ${uses.length} ${uses.length === 1 ? 'time' : 'times'} in this section</button>
    <ul hidden>${items}</ul>
  </div>`;
}

function formatGlossaryDefinition(entry, entries) {
  const relatedEntries = entries
    .filter((candidate) => candidate.normalized !== entry.normalized && candidate.term.length >= 5)
    .sort((left, right) => right.term.length - left.term.length);
  if (!relatedEntries.length) {
    return escapeHtml(entry.definition).replace(/\n{2,}/g, '<br><br>');
  }
  const lookup = new Map(relatedEntries.map((candidate) => [candidate.normalized, candidate]));
  const pattern = new RegExp(`\\b(${relatedEntries.map((candidate) => escapeRegExp(candidate.term)).join('|')})\\b`, 'gi');
  return escapeHtml(entry.definition)
    .replace(pattern, (match) => {
      const relatedEntry = lookup.get(normalizeGlossaryTerm(match));
      if (!relatedEntry) {
        return match;
      }
      return `<button class="glossary-inline" type="button" data-term="${escapeHtml(relatedEntry.normalized)}">${match}</button>`;
    })
    .replace(/\n{2,}/g, '<br><br>');
}

function glossaryEntriesForMarkdown(markdown, section) {
  const text = markdown
    .split(/\r?\n/)
    .filter((line) => !line.startsWith('Source:') && !line.startsWith('Scraped:') && !line.startsWith('# '))
    .join(' ');
  const preferred = new Map();

  for (const entry of section.glossary || []) {
    preferred.set(entry.normalized, entry);
  }

  for (const entry of state.glossaryEntries) {
    if (entry.term.length < 5 || preferred.has(entry.normalized)) {
      continue;
    }
    const pattern = new RegExp(`\\b${escapeRegExp(entry.term)}\\b`, 'i');
    if (pattern.test(text)) {
      preferred.set(entry.normalized, entry);
    }
  }

  return [...preferred.values()].sort((left, right) => {
    const leftIndex = text.toLowerCase().indexOf(left.term.toLowerCase());
    const rightIndex = text.toLowerCase().indexOf(right.term.toLowerCase());
    return normalizedIndex(leftIndex) - normalizedIndex(rightIndex) || left.term.localeCompare(right.term);
  });
}

function annotateGlossaryTerms(root, entries) {
  state.termUses = new Map();
  if (!entries.length) {
    return;
  }
  const terms = entries
    .filter((entry) => entry.term.length >= 5)
    .sort((left, right) => right.term.length - left.term.length);
  if (!terms.length) {
    return;
  }
  const lookup = new Map(terms.map((entry) => [entry.normalized, entry]));
  const pattern = new RegExp(`\\b(${terms.map((entry) => escapeRegExp(entry.term)).join('|')})\\b`, 'gi');
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      pattern.lastIndex = 0;
      return shouldAnnotateNode(node) && pattern.test(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const nodes = [];
  while (walker.nextNode()) {
    nodes.push(walker.currentNode);
  }
  for (const node of nodes) {
    pattern.lastIndex = 0;
    const fragment = document.createDocumentFragment();
    let lastIndex = 0;
    const context = contextForNode(node);
    for (const match of node.nodeValue.matchAll(pattern)) {
      const entry = lookup.get(normalizeGlossaryTerm(match[0]));
      if (!entry) {
        continue;
      }
      fragment.append(document.createTextNode(node.nodeValue.slice(lastIndex, match.index)));
      const button = document.createElement('button');
      button.className = 'glossary-term';
      button.type = 'button';
      button.dataset.term = entry.normalized;
      button.id = termUseId(entry.normalized);
      button.textContent = match[0];
      recordTermUse(entry.normalized, button.id, context);
      fragment.append(button);
      lastIndex = match.index + match[0].length;
    }
    fragment.append(document.createTextNode(node.nodeValue.slice(lastIndex)));
    node.replaceWith(fragment);
  }
}

function termUseId(term) {
  const count = (state.termUses.get(term)?.length || 0) + 1;
  return `use-${term.replace(/[^a-z0-9]+/g, '-')}-${count}`;
}

function recordTermUse(term, id, context) {
  const uses = state.termUses.get(term) || [];
  uses.push({ id, context });
  state.termUses.set(term, uses);
}

function contextForNode(node) {
  const container = node.parentElement?.closest('p, li') || node.parentElement;
  const text = normalizeText(container?.textContent || node.nodeValue || '');
  return text.length > 130 ? `${text.slice(0, 127)}...` : text;
}

function shouldAnnotateNode(node) {
  const parent = node.parentElement;
  return parent && !parent.closest('a, button, h1, .source-line');
}

function bindGlossaryNavigation() {
  document.addEventListener('click', (event) => {
    const usageToggle = event.target.closest('.glossary-uses-toggle');
    if (usageToggle && els.glossary.contains(usageToggle)) {
      event.preventDefault();
      toggleGlossaryUses(usageToggle);
      return;
    }

    const useLink = event.target.closest('[data-use-id]');
    if (useLink && els.glossary.contains(useLink)) {
      event.preventDefault();
      focusTermUse(useLink.dataset.useId);
      return;
    }

    const trigger = event.target.closest('[data-term]');
    if (!trigger || (!els.reader.contains(trigger) && !els.glossary.contains(trigger))) {
      return;
    }
    event.preventDefault();
    focusGlossaryTerm(trigger.dataset.term);
  });
}

function toggleGlossaryUses(button) {
  const list = button.nextElementSibling;
  if (!list) {
    return;
  }
  const isExpanded = button.getAttribute('aria-expanded') === 'true';
  button.setAttribute('aria-expanded', String(!isExpanded));
  list.hidden = isExpanded;
}

function focusGlossaryTerm(term, options = {}) {
  const normalizedTerm = normalizeGlossaryTerm(term);
  let entry = state.visibleGlossary.find((candidate) => candidate.normalized === normalizedTerm);
  if (!entry) {
    entry = state.glossaryByTerm.get(normalizedTerm);
    if (entry) {
      renderGlossary([...state.visibleGlossary, entry], normalizedTerm);
    }
  } else {
    renderGlossary(state.visibleGlossary, normalizedTerm);
  }
  const target = document.querySelector(`#glossary-${CSS.escape(entry?.id || '')}`);
  if (target) {
    target.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
  if (entry && options.updateUrl !== false) {
    updateRoute(activeSection(), entry.normalized);
  }
}

function focusTermUse(id) {
  const target = document.getElementById(id);
  if (!target) {
    return;
  }
  target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  target.classList.add('glossary-term-focus');
  if (target.dataset.term) {
    updateRoute(activeSection(), target.dataset.term);
  }
  window.setTimeout(() => target.classList.remove('glossary-term-focus'), 1200);
}

function activeSection() {
  return state.sectionIndex.find(({ section }) => section.sourceUrl === state.activeSection)?.section;
}

function updateRoute(section, term = '', options = {}) {
  if (!section) {
    return;
  }
  const params = new URLSearchParams();
  if (state.currentTitle?.scope && state.currentTitle.scope !== defaultTitleScope) {
    params.set('title', state.currentTitle.scope);
  }
  params.set('section', section.number || section.sourceUrl);
  if (term) {
    params.set('term', normalizeGlossaryTerm(term));
  }
  const nextUrl = `${location.pathname}${location.search}#${params.toString()}`;
  const currentUrl = `${location.pathname}${location.search}${location.hash}`;
  if (nextUrl === currentUrl) {
    return;
  }
  const method = options.replace ? 'replaceState' : 'pushState';
  history[method](null, '', nextUrl);
}

function routeFromLocation() {
  const hash = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
  const params = new URLSearchParams(hash);
  return {
    title: params.get('title') || '',
    section: params.get('section') || '',
    term: params.get('term') || '',
  };
}

function titleForRoute(route) {
  if (!route.title) {
    return null;
  }
  const normalizedTitle = normalize(route.title);
  return state.titleIndex.find((title) => (
    normalize(title.scope) === normalizedTitle
    || normalize(title.manifestPath) === normalizedTitle
    || normalize(title.scope).includes(normalizedTitle)
  )) || null;
}

function sectionForRoute(route) {
  if (!route.section) {
    return null;
  }
  const normalizedSection = normalize(route.section);
  const match = state.sectionIndex.find(({ section }) => (
    normalize(section.number) === normalizedSection
    || normalize(section.sourceUrl) === normalizedSection
    || normalize(section.title).includes(normalizedSection)
  ));
  return match?.section || null;
}

async function loadGlossary(manifest) {
  if (!manifest.glossaryPath) {
    return [];
  }
  const glossary = await fetchJson(manifest.glossaryPath);
  return glossary.entries || [];
}

function buildGlossaryLookup(entries) {
  const lookup = new Map();
  for (const entry of entries) {
    if (!lookup.has(entry.normalized)) {
      lookup.set(entry.normalized, entry);
    }
  }
  return lookup;
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

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeGlossaryTerm(value) {
  return normalize(String(value || '').replace(/\s+/g, ' ').trim());
}

function normalizedIndex(index) {
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
