import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { marked } from 'https://esm.sh/marked@12.0.2';
import DOMPurify from 'https://esm.sh/dompurify@3.1.6';

/* =====================  НАСТРОЙКИ (единственное место)  ===================== */
const SUPABASE_URL = 'https://YOUR-PROJECT-ID.supabase.co';
const SUPABASE_ANON_KEY = 'YOUR-ANON-PUBLIC-KEY';
/* Это публичные значения. Защита данных обеспечивается RLS в базе, а не секретностью ключа. */
/* ========================================================================== */

const PAGE_SIZE = 12;
const BUCKET_ASSETS = 'project-assets';
const BUCKET_FILES = 'project-files';
const PCOLS = 'id,slug,title,summary,category,tags,cover_path,downloads,updated_at,created_at,featured';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const state = { settings: null, categories: [], session: null, isAdmin: false };
const app = document.getElementById('app');

/* ---------------------------------- Утилиты ---------------------------------- */
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

DOMPurify.addHook('afterSanitizeAttributes', node => {
  if (node.tagName === 'A') { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer nofollow'); }
});
const md = t => DOMPurify.sanitize(marked.parse(t || '', { gfm: true, breaks: true }));

const fmtSize = n => {
  n = Number(n) || 0;
  if (n < 1024) return n + ' Б';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' КБ';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' МБ';
  return (n / 1073741824).toFixed(2) + ' ГБ';
};
const fmtDate = d => d ? new Date(d).toLocaleDateString('ru-RU') : '—';

const RU = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'c',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya' };
const slugify = s => s.toLowerCase().split('').map(c => RU[c] ?? c).join('').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const safeUrl = u => { try { const x = new URL(u); return ['http:', 'https:'].includes(x.protocol) ? x.href : ''; } catch { return ''; } };
const assetUrl = path => supabase.storage.from(BUCKET_ASSETS).getPublicUrl(path).data.publicUrl;
const catName = slug => state.categories.find(c => c.slug === slug)?.name || slug;
const extOf = f => (f.name.split('.').pop() || '').toLowerCase().replace(/[^a-z0-9]/g, '') || 'img';
const rid8 = () => crypto.randomUUID().slice(0, 8);
const stateBlock = (kind, msg) => `<div class="state ${kind}">${msg}</div>`;
const skeletonGrid = n => `<div class="grid">${'<div class="skeleton"></div>'.repeat(n)}</div>`;

function clientId() {
  try {
    let id = localStorage.getItem('dc_cid');
    if (!id) { id = crypto.randomUUID(); localStorage.setItem('dc_cid', id); }
    return id;
  } catch { return 'anon'; }
}

function toast(msg, type = 'info') {
  let box = $('#toasts');
  if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.appendChild(box); }
  const t = document.createElement('div');
  t.className = 'toast ' + type; t.textContent = msg; box.appendChild(t);
  setTimeout(() => t.remove(), 4500);
}

function confirmDialog(message, okText = 'Удалить') {
  return new Promise(resolve => {
    const d = document.createElement('dialog');
    d.className = 'dlg';
    d.innerHTML = `<p>${esc(message)}</p><div class="row end"><button class="btn" data-v="0">Отмена</button><button class="btn danger" data-v="1">${esc(okText)}</button></div>`;
    d.addEventListener('click', e => { const b = e.target.closest('button'); if (b) { d.close(); resolve(b.dataset.v === '1'); } });
    d.addEventListener('cancel', () => resolve(false));
    d.addEventListener('close', () => d.remove());
    document.body.appendChild(d);
    d.showModal();
  });
}

function friendlyError(e, fallback) {
  console.error(e);
  const msg = String(e?.message || '').toLowerCase();
  if (e?.code === '42501' || msg.includes('row-level security') || msg.includes('not allowed') || e?.status === 401 || e?.status === 403) return 'У вас нет прав для этого действия.';
  if (e?.code === '23505' || msg.includes('duplicate')) return 'Запись с такими данными уже существует.';
  if (e?.status === 413 || msg.includes('exceeded the maximum')) return 'Файл превышает допустимый размер.';
  return fallback;
}

function setBusy(root, flag) {
  root.querySelectorAll('button,input,select,textarea').forEach(el => { el.disabled = flag; });
}

function upsertMeta(key, value, isProp) {
  const sel = isProp ? `meta[property="${key}"]` : `meta[name="${key}"]`;
  let el = document.head.querySelector(sel);
  if (!el) { el = document.createElement('meta'); el.setAttribute(isProp ? 'property' : 'name', key); document.head.appendChild(el); }
  el.setAttribute('content', value || '');
}

function setMeta({ title, description, image } = {}) {
  const site = state.settings?.site_name || 'Dev Catalog';
  const full = title ? `${title} — ${site}` : site;
  const desc = description || state.settings?.description || '';
  document.title = full;
  upsertMeta('description', desc);
  upsertMeta('og:title', full, true);
  upsertMeta('og:description', desc, true);
  upsertMeta('og:url', location.href, true);
  upsertMeta('twitter:title', full);
  upsertMeta('twitter:description', desc);
  const img = image || (state.settings?.avatar_path ? assetUrl(state.settings.avatar_path) : '');
  if (img) { upsertMeta('og:image', img, true); upsertMeta('twitter:image', img); }
  $('#canonical').href = location.origin + location.pathname + location.hash;
}

function applySettings() {
  const s = state.settings;
  if (s?.favicon_path) $('#favicon').href = assetUrl(s.favicon_path);
  setMeta();
}

/* ------------------------- Загрузка с реальным прогрессом ------------------------- */
async function uploadWithProgress(bucket, path, file, onProgress) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw Object.assign(new Error('no_session'), { status: 401 });
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const url = `${SUPABASE_URL}/storage/v1/object/${bucket}/${path.split('/').map(encodeURIComponent).join('/')}`;
    xhr.open('POST', url);
    xhr.setRequestHeader('Authorization', 'Bearer ' + session.access_token);
    xhr.setRequestHeader('apikey', SUPABASE_ANON_KEY);
    xhr.setRequestHeader('x-upsert', 'false');
    xhr.setRequestHeader('cache-control', 'max-age=3600');
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(Math.round(e.loaded / e.total * 100)); };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300)
      ? resolve()
      : reject(Object.assign(new Error(xhr.responseText || 'HTTP ' + xhr.status), { status: xhr.status }));
    xhr.onerror = () => reject(new Error('network'));
    xhr.send(file);
  });
}

function uploadErrorMessage(e) {
  if (e?.status === 413) return 'Файл превышает лимит размера хранилища.';
  if (e?.status === 409) return 'Файл с таким именем уже есть в этом релизе.';
  if (e?.status === 401 || e?.status === 403) return 'У вас нет прав для загрузки.';
  if (e?.message === 'network') return 'Ошибка сети во время загрузки.';
  return 'Не удалось загрузить файл.';
}

async function removeObjects(bucket, paths) {
  paths = paths.filter(Boolean);
  for (let i = 0; i < paths.length; i += 100) {
    const { error } = await supabase.storage.from(bucket).remove(paths.slice(i, i + 100));
    if (error) throw error;
  }
}

function dropzone(el, onFiles, { multiple = true, accept = '' } = {}) {
  el.classList.add('dz');
  el.innerHTML = `<input type="file" hidden ${multiple ? 'multiple' : ''} ${accept ? `accept="${accept}"` : ''}><strong>Перетащите ${multiple ? 'файлы' : 'файл'} сюда</strong><br><span class="muted">или нажмите, чтобы выбрать</span>`;
  const input = $('input', el);
  el.addEventListener('click', e => { if (e.target !== input) input.click(); });
  input.addEventListener('change', () => { if (input.files.length) onFiles([...input.files]); input.value = ''; });
  ['dragenter', 'dragover'].forEach(ev => el.addEventListener(ev, e => { e.preventDefault(); el.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => el.addEventListener(ev, e => { e.preventDefault(); el.classList.remove('over'); }));
  el.addEventListener('drop', e => {
    const fs = [...e.dataTransfer.files];
    if (fs.length) onFiles(multiple ? fs : [fs[0]]);
  });
}

/* ---------------------------------- Авторизация ---------------------------------- */
async function refreshAuth() {
  const { data: { session } } = await supabase.auth.getSession();
  state.session = session; state.isAdmin = false;
  if (session) {
    const { data } = await supabase.from('profiles').select('role').eq('id', session.user.id).maybeSingle();
    state.isAdmin = data?.role === 'admin';
  }
}

/* ------------------------------------ Роутер ------------------------------------ */
let rendering = false, again = false;
async function render() {
  if (rendering) { again = true; return; }
  rendering = true;
  try {
    const raw = location.hash.replace(/^#/, '') || '/';
    const [path, qs = ''] = raw.split('?');
    const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
    const params = new URLSearchParams(qs);
    window.scrollTo(0, 0);
    if (parts[0] === 'admin') await renderAdmin(parts.slice(1));
    else await renderPublic(parts, params);
  } catch (e) {
    console.error(e);
    shell(stateBlock('error', 'Не удалось загрузить страницу. <button class="btn" onclick="location.reload()">Обновить</button>'));
  } finally {
    rendering = false;
    if (again) { again = false; render(); }
  }
}

/* ================================== ПУБЛИЧНАЯ ЧАСТЬ ================================== */
function socialLinks() {
  const s = state.settings || {};
  const items = [['GitHub', s.github_url], ['Discord', s.discord_url], ['Telegram', s.telegram_url]];
  (Array.isArray(s.other_links) ? s.other_links : []).forEach(l => items.push([l.name, l.url]));
  return items.filter(([, u]) => safeUrl(u)).map(([n, u]) => `<a href="${esc(safeUrl(u))}" target="_blank" rel="noopener noreferrer">${esc(n)}</a>`).join('');
}

function shell(inner) {
  const s = state.settings || {};
  app.innerHTML = `
  <header class="top"><div class="wrap">
    <a class="brand" href="#/">${s.avatar_path ? `<img src="${esc(assetUrl(s.avatar_path))}" alt="">` : ''}<span>${esc(s.site_name || 'Dev Catalog')}</span></a>
    <nav><a href="#/">Главная</a><a href="#/projects">Проекты</a>${state.session ? '<a href="#/admin">Админка</a>' : ''}</nav>
  </div></header>
  <main class="wrap">${inner}</main>
  <footer class="foot"><div class="wrap row between"><span>© ${new Date().getFullYear()} ${esc(s.site_name || '')}</span><span class="row gap">${socialLinks()}</span></div></footer>`;
}

function cardHtml(p) {
  const img = p.cover_path
    ? `<img loading="lazy" src="${esc(assetUrl(p.cover_path))}" alt="">`
    : `<div class="ph">${esc((p.title || '?').slice(0, 1).toUpperCase())}</div>`;
  return `<a class="card" href="#/projects/${encodeURIComponent(p.slug)}">
    <div class="thumb">${img}</div>
    <div class="cbody">
      <div class="row between"><span class="chip">${esc(catName(p.category))}</span><span class="muted sm">⬇ ${p.downloads}</span></div>
      <h3>${esc(p.title)}</h3><p class="muted">${esc(p.summary)}</p>
      <div class="tags">${(p.tags || []).slice(0, 4).map(t => `<span class="tag">#${esc(t)}</span>`).join('')}</div>
    </div></a>`;
}

async function renderPublic(parts, params) {
  if (parts.length === 0) return pageHome();
  if (parts[0] === 'projects' && parts.length === 1) return pageProjects(params);
  if (parts[0] === 'projects' && parts.length === 2) return pageProject(parts[1]);
  setMeta({ title: 'Страница не найдена' });
  shell(stateBlock('', 'Страница не найдена. <a class="btn" href="#/">На главную</a>'));
}

async function pageHome() {
  const s = state.settings || {};
  setMeta();
  shell(`
    <section class="hero">
      <h1>${esc(s.site_name || 'Dev Catalog')}</h1>
      <p>${esc(s.description || '')}</p>
      <p><a class="btn primary" href="#/projects">Все проекты</a></p>
    </section>
    <div id="home-data">${skeletonGrid(3)}</div>`);
  const [feat, last] = await Promise.all([
    supabase.from('projects').select(PCOLS).eq('status', 'published').eq('featured', true).order('updated_at', { ascending: false }).limit(6),
    supabase.from('projects').select(PCOLS).eq('status', 'published').order('updated_at', { ascending: false }).limit(6)
  ]);
  if (feat.error || last.error) { $('#home-data').innerHTML = stateBlock('error', 'Не удалось загрузить проекты.'); return; }
  const section = (title, list) => list.length ? `<h2>${title}</h2><div class="grid">${list.map(cardHtml).join('')}</div>` : '';
  $('#home-data').innerHTML = `
    ${section('Избранные проекты', feat.data)}
    ${section('Последние обновления', last.data)}
    ${state.categories.length ? `<h2>Категории</h2><div class="row">${state.categories.map(c => `<a class="chip" href="#/projects?cat=${esc(c.slug)}">${esc(c.name)}</a>`).join('')}</div>` : ''}
    ${(!feat.data.length && !last.data.length) ? stateBlock('', 'Пока нет опубликованных проектов.') : ''}
    ${s.about ? `<h2>Обо мне</h2><div class="panel md">${md(s.about)}</div>` : ''}`;
}

async function pageProjects(params) {
  setMeta({ title: 'Проекты', description: 'Все проекты каталога' });
  const st = {
    q: params.get('q') || '', cat: params.get('cat') || '', tag: params.get('tag') || '',
    sort: params.get('sort') || 'new', page: Math.max(1, parseInt(params.get('page') || '1', 10) || 1)
  };
  const { data: tagRows } = await supabase.from('projects').select('tags').eq('status', 'published');
  const allTags = [...new Set((tagRows || []).flatMap(r => r.tags || []))].sort();
  shell(`
    <h1>Проекты</h1>
    <div class="toolbar">
      <input id="f-q" type="search" placeholder="Поиск по названию, описанию, тегам…" value="${esc(st.q)}">
      <select id="f-cat"><option value="">Все категории</option>${state.categories.map(c => `<option value="${esc(c.slug)}" ${c.slug === st.cat ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
      <select id="f-tag"><option value="">Все теги</option>${allTags.map(t => `<option value="${esc(t)}" ${t === st.tag ? 'selected' : ''}>#${esc(t)}</option>`).join('')}</select>
      <select id="f-sort">${[['new', 'Сначала новые'], ['upd', 'По обновлению'], ['dl', 'По скачиваниям'], ['name', 'По названию']].map(([v, l]) => `<option value="${v}" ${v === st.sort ? 'selected' : ''}>${l}</option>`).join('')}</select>
    </div>
    <div id="plist"></div><div class="pager" id="pager"></div>`);

  const sorters = { new: ['created_at', false], upd: ['updated_at', false], dl: ['downloads', false], name: ['title', true] };

  async function load() {
    const qs = new URLSearchParams();
    if (st.q) qs.set('q', st.q); if (st.cat) qs.set('cat', st.cat); if (st.tag) qs.set('tag', st.tag);
    if (st.sort !== 'new') qs.set('sort', st.sort); if (st.page > 1) qs.set('page', st.page);
    history.replaceState(null, '', '#/projects' + (qs.toString() ? '?' + qs : ''));

    $('#plist').innerHTML = skeletonGrid(6);
    let q = supabase.from('projects').select(PCOLS, { count: 'exact' }).eq('status', 'published');
    if (st.cat) q = q.eq('category', st.cat);
    if (st.tag) q = q.contains('tags', [st.tag]);
    const term = st.q.trim().replace(/[,()%*\\"{}]/g, ' ').trim();
    if (term) {
      const low = term.toLowerCase();
      const slugs = state.categories.filter(c => c.name.toLowerCase().includes(low) || c.slug.includes(low)).map(c => c.slug);
      const f = [`title.ilike.%${term}%`, `summary.ilike.%${term}%`, `tags.cs.{${low}}`];
      if (slugs.length) f.push(`category.in.(${slugs.join(',')})`);
      q = q.or(f.join(','));
    }
    const [col, asc] = sorters[st.sort] || sorters.new;
    q = q.order(col, { ascending: asc }).range((st.page - 1) * PAGE_SIZE, st.page * PAGE_SIZE - 1);
    const { data, error, count } = await q;
    if (error) { console.error(error); $('#plist').innerHTML = stateBlock('error', 'Не удалось загрузить проекты.'); $('#pager').innerHTML = ''; return; }
    $('#plist').innerHTML = data.length ? `<div class="grid">${data.map(cardHtml).join('')}</div>` : stateBlock('', 'Ничего не найдено.');
    const pages = Math.max(1, Math.ceil((count || 0) / PAGE_SIZE));
    $('#pager').innerHTML = pages > 1
      ? `<button class="btn" id="pg-prev" ${st.page <= 1 ? 'disabled' : ''}>←</button><span class="muted">${st.page} / ${pages}</span><button class="btn" id="pg-next" ${st.page >= pages ? 'disabled' : ''}>→</button>` : '';
    $('#pg-prev')?.addEventListener('click', () => { st.page--; load(); window.scrollTo(0, 0); });
    $('#pg-next')?.addEventListener('click', () => { st.page++; load(); window.scrollTo(0, 0); });
  }

  let timer;
  $('#f-q').addEventListener('input', e => { clearTimeout(timer); timer = setTimeout(() => { st.q = e.target.value; st.page = 1; load(); }, 300); });
  $('#f-cat').addEventListener('change', e => { st.cat = e.target.value; st.page = 1; load(); });
  $('#f-tag').addEventListener('change', e => { st.tag = e.target.value; st.page = 1; load(); });
  $('#f-sort').addEventListener('change', e => { st.sort = e.target.value; st.page = 1; load(); });
  await load();
}

async function pageProject(slug) {
  shell(`<div class="skeleton" style="height:420px"></div>`);
  const { data: p, error } = await supabase.from('projects')
    .select('*, project_images(*), releases(*, release_files(*))')
    .eq('slug', slug).eq('status', 'published').maybeSingle();
  if (error) throw error;
  if (!p) { setMeta({ title: 'Проект не найден' }); shell(stateBlock('', 'Проект не найден. <a class="btn" href="#/projects">К проектам</a>')); return; }

  const rels = (p.releases || []).filter(r => r.status === 'published')
    .sort((a, b) => (b.released_at || '').localeCompare(a.released_at || '') || b.created_at.localeCompare(a.created_at));
  const latest = rels[0];
  const imgs = [...(p.cover_path ? [p.cover_path] : []), ...(p.project_images || []).sort((a, b) => a.position - b.position).map(i => i.storage_path)];
  const author = state.settings?.site_name || '';

  setMeta({ title: p.title, description: p.summary, image: imgs[0] ? assetUrl(imgs[0]) : undefined });

  const fileLine = f => `<div class="fileline"><span>${esc(f.original_name)} <span class="muted sm">${fmtSize(f.size_bytes)} · ⬇ ${f.downloads}</span></span><button class="btn primary" data-dl="${esc(f.id)}" data-name="${esc(f.original_name)}">Скачать</button></div>`;

  shell(`
    <p><a class="muted" href="#/projects">← Все проекты</a></p>
    <div class="pj">
      <div>
        <h1>${esc(p.title)}</h1>
        <p class="muted">${esc(p.summary)}</p>
        <div class="row"><span class="chip">${esc(catName(p.category))}</span>${(p.tags || []).map(t => `<a class="tag" href="#/projects?tag=${encodeURIComponent(t)}">#${esc(t)}</a>`).join('')}</div>
        ${imgs.length ? `<div style="margin-top:20px"><div class="gal-main"><img id="gal-img" src="${esc(assetUrl(imgs[0]))}" alt=""></div>
          ${imgs.length > 1 ? `<div class="gal-th">${imgs.map((im, i) => `<img data-i="${i}" class="${i ? '' : 'on'}" src="${esc(assetUrl(im))}" alt="">`).join('')}</div>` : ''}</div>` : ''}
        <h2>Описание</h2><div class="md">${p.description ? md(p.description) : '<p class="muted">Описание пока не добавлено.</p>'}</div>
      </div>
      <aside>
        <div class="panel">
          <h3>Скачать</h3>
          ${latest ? `<dl class="kv"><dt>Версия</dt><dd>${esc(latest.version)}</dd><dt>Дата релиза</dt><dd>${fmtDate(latest.released_at)}</dd>
            <dt>Поддержка</dt><dd>${esc(latest.supported_versions || p.supported_versions || '—')}</dd></dl>
            ${(latest.release_files || []).map(fileLine).join('') || '<p class="muted">В этом релизе нет файлов.</p>'}`
            : '<p class="muted">Опубликованных релизов пока нет.</p>'}
        </div>
        <div class="panel" style="margin-top:14px"><dl class="kv" style="margin:0">
          <dt>Автор</dt><dd>${esc(author)}</dd>
          <dt>Опубликован</dt><dd>${fmtDate(p.published_at || p.created_at)}</dd>
          <dt>Обновлён</dt><dd>${fmtDate(p.updated_at)}</dd>
          <dt>Скачиваний</dt><dd>${p.downloads}</dd>
          ${p.supported_versions ? `<dt>Поддержка</dt><dd>${esc(p.supported_versions)}</dd>` : ''}
        </dl></div>
      </aside>
    </div>
    <h2>Релизы</h2>
    ${rels.length ? rels.map((r, i) => `<details class="rel" ${i === 0 ? 'open' : ''}>
      <summary><strong>v${esc(r.version)}</strong><span class="muted">${fmtDate(r.released_at)}</span>${r.supported_versions ? `<span class="chip">${esc(r.supported_versions)}</span>` : ''}</summary>
      ${r.description ? `<p class="muted">${esc(r.description)}</p>` : ''}
      ${r.changelog ? `<div class="md">${md(r.changelog)}</div>` : ''}
      ${r.checksum ? `<p class="sm muted">Checksum: <code>${esc(r.checksum)}</code></p>` : ''}
      <div style="margin:10px 0">${(r.release_files || []).map(fileLine).join('') || '<p class="muted">Нет файлов.</p>'}</div>
    </details>`).join('') : stateBlock('', 'Релизов пока нет.')}`);

  $('.gal-th')?.addEventListener('click', e => {
    const im = e.target.closest('img[data-i]'); if (!im) return;
    $('#gal-img').src = im.src;
    document.querySelectorAll('.gal-th img').forEach(x => x.classList.toggle('on', x === im));
  });
}

async function downloadFile(fileId, name, btn) {
  if (btn) btn.disabled = true;
  try {
    const { data: path, error } = await supabase.rpc('register_download', { p_file: fileId, p_client: clientId() });
    if (error) throw error;
    const { data, error: e2 } = await supabase.storage.from(BUCKET_FILES).createSignedUrl(path, 120, { download: name });
    if (e2) throw e2;
    const a = document.createElement('a');
    a.href = data.signedUrl; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
  } catch (e) {
    console.error(e); toast('Не удалось скачать файл.', 'error');
  } finally { if (btn) btn.disabled = false; }
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-dl]');
  if (b) downloadFile(b.dataset.dl, b.dataset.name, b);
});

/* ===================================== АДМИНКА ===================================== */
function loginPage() {
  setMeta({ title: 'Вход' });
  app.innerHTML = `<div class="login"><form id="lf" class="panel"><h1>Вход</h1>
    <label>Email</label><input id="l-email" type="email" required autocomplete="username">
    <label>Пароль</label><input id="l-pass" type="password" required autocomplete="current-password">
    <p><button class="btn primary" style="width:100%">Войти</button></p></form>
    <a class="muted" href="#/">← На сайт</a></div>`;
  $('#lf').onsubmit = async e => {
    e.preventDefault();
    const f = e.target; setBusy(f, true);
    const { error } = await supabase.auth.signInWithPassword({ email: $('#l-email').value.trim(), password: $('#l-pass').value });
    if (error) { setBusy(f, false); toast('Неверный email или пароль.', 'error'); return; }
    await refreshAuth(); render();
  };
}

function noAccessPage() {
  app.innerHTML = `<div class="login"><div class="panel"><h1>Нет доступа</h1><p class="muted">У вашего аккаунта нет прав администратора.</p>
    <button class="btn" id="lo">Выйти</button></div></div>`;
  $('#lo').onclick = async () => { await supabase.auth.signOut(); await refreshAuth(); location.hash = '#/'; render(); };
}

function adminShell(active, inner) {
  const links = [['', 'Dashboard'], ['projects', 'Projects'], ['releases', 'Releases'], ['files', 'Files'], ['settings', 'Settings']];
  app.innerHTML = `<div class="adm">
    <aside class="side" id="side"><div class="side-h">${esc(state.settings?.site_name || 'Admin')}</div>
      <nav>${links.map(([h, l]) => `<a class="${active === h ? 'on' : ''}" href="#/admin${h ? '/' + h : ''}">${l}</a>`).join('')}</nav>
      <div class="side-f"><a href="#/">← На сайт</a><button class="btn" id="logout">Выйти</button></div></aside>
    <div class="adm-main"><div class="adm-top"><button class="btn" id="burger">☰</button><span class="muted sm">${esc(state.session.user.email)}</span></div>
    <div class="adm-body">${inner}</div></div></div>`;
  $('#burger').onclick = () => $('#side').classList.toggle('open');
  $('#side').addEventListener('click', e => { if (e.target.closest('a')) $('#side').classList.remove('open'); });
  $('#logout').onclick = async () => { await supabase.auth.signOut(); await refreshAuth(); location.hash = '#/'; render(); };
}

async function renderAdmin(parts) {
  setMeta({ title: 'Админка' });
  if (!state.session) return loginPage();
  if (!state.isAdmin) return noAccessPage();
  const [a, b, c, d] = parts;
  if (!a) return adminDashboard();
  if (a === 'projects') {
    if (!b) return adminProjects();
    if (b === 'new') return adminProjectEditor(null);
    if (c === 'releases' && d === 'new') return adminReleaseEditor(null, b);
    if (c === 'releases') return adminReleases(b);
    return adminProjectEditor(b);
  }
  if (a === 'releases') return b ? adminReleaseEditor(b, null) : adminReleases(null);
  if (a === 'files') return adminFiles();
  if (a === 'settings') return adminSettings();
  adminShell('', stateBlock('', 'Раздел не найден.'));
}

/* ---------------------------------- Dashboard ---------------------------------- */
async function adminDashboard() {
  adminShell('', `<h1>Dashboard</h1><div class="skeleton" style="height:120px"></div>`);
  const cnt = (t, f) => { let q = supabase.from(t).select('*', { count: 'exact', head: true }); if (f) q = f(q); return q; };
  const [a, b, c, d, dl, lp, lf] = await Promise.all([
    cnt('projects'), cnt('projects', q => q.eq('status', 'published')), cnt('releases'), cnt('release_files'),
    supabase.from('projects').select('downloads'),
    supabase.from('projects').select('id,title,status,created_at').order('created_at', { ascending: false }).limit(5),
    supabase.from('release_files').select('id,original_name,size_bytes,created_at').order('created_at', { ascending: false }).limit(5)
  ]);
  if ([a, b, c, d, dl, lp, lf].some(r => r.error)) { adminShell('', stateBlock('error', 'Не удалось загрузить данные.')); return; }
  const total = (dl.data || []).reduce((s, r) => s + r.downloads, 0);
  adminShell('', `<h1>Dashboard</h1>
    <div class="stats">
      <div class="stat"><b>${a.count}</b><span class="muted">Проектов</span></div>
      <div class="stat"><b>${b.count}</b><span class="muted">Опубликовано</span></div>
      <div class="stat"><b>${c.count}</b><span class="muted">Релизов</span></div>
      <div class="stat"><b>${d.count}</b><span class="muted">Файлов</span></div>
      <div class="stat"><b>${total}</b><span class="muted">Скачиваний</span></div>
    </div>
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(300px,1fr))">
      <div class="panel"><h3>Последние проекты</h3>${lp.data.map(p => `<div class="fileline"><a href="#/admin/projects/${p.id}">${esc(p.title)}</a><span class="badge ${p.status}">${p.status}</span></div>`).join('') || '<p class="muted">Пусто</p>'}</div>
      <div class="panel"><h3>Последние загрузки</h3>${lf.data.map(f => `<div class="fileline"><span>${esc(f.original_name)}</span><span class="muted sm">${fmtSize(f.size_bytes)} · ${fmtDate(f.created_at)}</span></div>`).join('') || '<p class="muted">Пусто</p>'}</div>
    </div>`);
}

/* ------------------------------------ Projects ------------------------------------ */
async function deleteProject(id) {
  const [pr, im, fl] = await Promise.all([
    supabase.from('projects').select('cover_path').eq('id', id).single(),
    supabase.from('project_images').select('storage_path').eq('project_id', id),
    supabase.from('release_files').select('storage_path, releases!inner(project_id)').eq('releases.project_id', id)
  ]);
  if (pr.error || im.error || fl.error) throw (pr.error || im.error || fl.error);
  await removeObjects(BUCKET_ASSETS, [pr.data.cover_path, ...im.data.map(i => i.storage_path)]);
  await removeObjects(BUCKET_FILES, fl.data.map(f => f.storage_path));
  const { error } = await supabase.from('projects').delete().eq('id', id);
  if (error) throw error;
}

async function adminProjects() {
  adminShell('projects', `<h1>Projects</h1><div class="skeleton" style="height:200px"></div>`);
  const { data, error } = await supabase.from('projects').select('id,slug,title,category,status,updated_at,downloads').order('updated_at', { ascending: false });
  if (error) { console.error(error); adminShell('projects', stateBlock('error', 'Не удалось загрузить проекты.')); return; }
  adminShell('projects', `<div class="row between"><h1>Projects</h1><a class="btn primary" href="#/admin/projects/new">+ New Project</a></div>
    ${data.length ? `<div class="tablewrap"><table><thead><tr><th>Project</th><th>Category</th><th>Status</th><th>Updated</th><th>Downloads</th><th>Actions</th></tr></thead><tbody>
    ${data.map(p => `<tr><td><strong>${esc(p.title)}</strong><div class="muted sm">${esc(p.slug)}</div></td><td>${esc(catName(p.category))}</td>
      <td><span class="badge ${p.status}">${p.status}</span></td><td>${fmtDate(p.updated_at)}</td><td>${p.downloads}</td>
      <td class="row"><a class="btn" href="#/admin/projects/${p.id}">Edit</a><a class="btn" href="#/admin/projects/${p.id}/releases">Releases</a><button class="btn danger" data-del="${p.id}" data-title="${esc(p.title)}">Delete</button></td></tr>`).join('')}
    </tbody></table></div>` : stateBlock('', 'Проектов пока нет. Создайте первый.')}`);
  $('.adm-body').onclick = async e => {
    const b = e.target.closest('[data-del]'); if (!b) return;
    if (!await confirmDialog(`Удалить проект «${b.dataset.title}» вместе со всеми релизами и файлами? Это действие нельзя отменить.`)) return;
    b.disabled = true;
    try { await deleteProject(b.dataset.del); toast('Проект удалён.', 'success'); adminProjects(); }
    catch (err) { toast(friendlyError(err, 'Не удалось удалить проект.'), 'error'); b.disabled = false; }
  };
}

async function adminProjectEditor(id) {
  let p = { title: '', slug: '', summary: '', description: '', category: state.categories[0]?.slug || 'other', tags: [], supported_versions: '', featured: false, status: 'draft', cover_path: null };
  let images = [];
  if (id) {
    adminShell('projects', `<div class="skeleton" style="height:300px"></div>`);
    const { data, error } = await supabase.from('projects').select('*, project_images(*)').eq('id', id).maybeSingle();
    if (error || !data) { adminShell('projects', stateBlock('error', 'Проект не найден.')); return; }
    p = data; images = (data.project_images || []).sort((a, b) => a.position - b.position);
  }
  let tags = [...(p.tags || [])];
  let slugTouched = !!id;

  adminShell('projects', `
    <div class="row between"><h1>${id ? 'Редактирование проекта' : 'Новый проект'}</h1><a class="btn" href="#/admin/projects">← К списку</a></div>
    <div class="tabs" id="tabs">${['General', 'Description', 'Images', 'Tags', 'Settings'].map((t, i) => `<button type="button" class="tab ${i ? '' : 'on'}" data-t="${i}">${t}</button>`).join('')}</div>
    <form id="pf" class="panel">
      <section data-s="0">
        <label>Название *</label><input id="f-title" value="${esc(p.title)}" maxlength="120">
        <label>Slug (адрес страницы) *</label><input id="f-slug" value="${esc(p.slug)}">
        <label>Краткое описание (до 300 символов)</label><textarea id="f-sum" maxlength="300" style="min-height:80px;font-family:inherit">${esc(p.summary)}</textarea>
        <label>Категория</label><select id="f-cat">${state.categories.map(c => `<option value="${esc(c.slug)}" ${c.slug === p.category ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
        <label>Поддерживаемые версии</label><input id="f-sv" value="${esc(p.supported_versions)}" placeholder="Minecraft 1.21.x">
      </section>
      <section data-s="1" hidden>
        <label>Полное описание (Markdown)</label><textarea id="f-desc" style="min-height:260px">${esc(p.description)}</textarea>
        <label>Предпросмотр</label><div class="panel md" id="md-prev"></div>
      </section>
      <section data-s="2" hidden>${id ? '<div id="img-box"></div>' : '<p class="muted">Сначала сохраните проект (Save Draft), затем здесь появится загрузка изображений.</p>'}</section>
      <section data-s="3" hidden>
        <label>Теги (Enter или запятая)</label><input id="f-tagin" placeholder="например: forge">
        <div class="chips" id="tag-chips"></div>
      </section>
      <section data-s="4" hidden>
        <label><input type="checkbox" id="f-feat" ${p.featured ? 'checked' : ''}> Избранный проект (показывается на главной)</label>
        <label>Статус</label><select id="f-status">${['draft', 'published', 'archived'].map(s => `<option ${s === p.status ? 'selected' : ''}>${s}</option>`).join('')}</select>
      </section>
      <div class="row actions">
        <button type="button" class="btn" data-save="draft">Save Draft</button>
        <button type="button" class="btn primary" data-save="published">Publish</button>
        <button type="button" class="btn" data-save="archived">Archive</button>
        ${id ? '<button type="button" class="btn" data-save="keep">Save</button>' : ''}
      </div>
    </form>`);

  const form = $('#pf');
  $('#tabs').onclick = e => {
    const b = e.target.closest('[data-t]'); if (!b) return;
    document.querySelectorAll('#tabs .tab').forEach(x => x.classList.toggle('on', x === b));
    form.querySelectorAll('section').forEach(s => { s.hidden = s.dataset.s !== b.dataset.t; });
  };
  form.onsubmit = e => e.preventDefault();

  $('#f-title').addEventListener('input', e => { if (!slugTouched) $('#f-slug').value = slugify(e.target.value); });
  $('#f-slug').addEventListener('input', () => { slugTouched = true; });

  const prev = () => { $('#md-prev').innerHTML = md($('#f-desc').value) || '<span class="muted">Пусто</span>'; };
  $('#f-desc').addEventListener('input', prev); prev();

  const drawTags = () => {
    $('#tag-chips').innerHTML = tags.map((t, i) => `<span class="chip">#${esc(t)}<button type="button" data-rt="${i}">✕</button></span>`).join('') || '<span class="muted">Тегов нет</span>';
  };
  const addTag = raw => {
    const t = raw.toLowerCase().trim().replace(/[\s,{}"\\]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
    if (t && !tags.includes(t)) tags.push(t);
    drawTags();
  };
  $('#f-tagin').addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(e.target.value); e.target.value = ''; }
  });
  $('#f-tagin').addEventListener('blur', e => { if (e.target.value.trim()) { addTag(e.target.value); e.target.value = ''; } });
  $('#tag-chips').onclick = e => { const b = e.target.closest('[data-rt]'); if (b) { tags.splice(+b.dataset.rt, 1); drawTags(); } };
  drawTags();

  form.querySelector('.actions').onclick = async e => {
    const b = e.target.closest('[data-save]'); if (!b) return;
    const title = $('#f-title').value.trim();
    const slug = $('#f-slug').value.trim();
    if (!title) return toast('Введите название.', 'error');
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return toast('Slug: только a-z, 0-9 и дефисы.', 'error');
    const status = b.dataset.save === 'keep' ? $('#f-status').value : b.dataset.save;
    const row = {
      title, slug, summary: $('#f-sum').value.trim(), description: $('#f-desc').value,
      category: $('#f-cat').value, tags, supported_versions: $('#f-sv').value.trim(),
      featured: $('#f-feat').checked, status
    };
    setBusy(form, true);
    const q = id ? supabase.from('projects').update(row).eq('id', id).select('id').single()
                 : supabase.from('projects').insert(row).select('id').single();
    const { data, error } = await q;
    setBusy(form, false);
    if (error) { toast(friendlyError(error, 'Не удалось сохранить проект.'), 'error'); return; }
    toast('Проект сохранён.', 'success');
    $('#f-status').value = status;
    if (!id) location.hash = '#/admin/projects/' + data.id;
  };

  if (!id) return;

  /* ---- изображения ---- */
  const assets = () => supabase.storage.from(BUCKET_ASSETS);
  const checkImg = f => {
    if (!f.type.startsWith('image/')) { toast(`«${f.name}» — не изображение.`, 'error'); return false; }
    if (f.size > 10 * 1024 * 1024) { toast(`«${f.name}» больше 10 МБ.`, 'error'); return false; }
    return true;
  };
  async function setCover(file) {
    const path = `projects/${id}/cover-${rid8()}.${extOf(file)}`;
    const up = await assets().upload(path, file, { contentType: file.type, upsert: false, cacheControl: '31536000' });
    if (up.error) throw up.error;
    const { error } = await supabase.from('projects').update({ cover_path: path }).eq('id', id);
    if (error) { await assets().remove([path]); throw error; }
    if (p.cover_path) await assets().remove([p.cover_path]);
    p.cover_path = path;
  }
  async function addShot(file) {
    const path = `projects/${id}/shots/${rid8()}.${extOf(file)}`;
    const up = await assets().upload(path, file, { contentType: file.type, upsert: false, cacheControl: '31536000' });
    if (up.error) throw up.error;
    const position = images.length ? Math.max(...images.map(i => i.position)) + 1 : 0;
    const { data, error } = await supabase.from('project_images').insert({ project_id: id, storage_path: path, position }).select('*').single();
    if (error) { await assets().remove([path]); throw error; }
    images.push(data);
  }
  function renderImages() {
    const box = $('#img-box'); if (!box) return;
    box.innerHTML = `<h3>Обложка</h3>
      <div class="row">${p.cover_path ? `<img class="cover-prev" src="${esc(assetUrl(p.cover_path))}" alt=""><button type="button" class="btn danger" id="cover-del">Удалить</button>` : '<span class="muted">Не задана</span>'}</div>
      <div id="cover-dz"></div>
      <h3 style="margin-top:26px">Скриншоты</h3>
      <div class="shots">${images.map((im, i) => `<div class="shot"><img src="${esc(assetUrl(im.storage_path))}" alt="">
        <div class="row"><button type="button" class="btn" data-mv="${i}" data-d="-1">←</button><button type="button" class="btn" data-mv="${i}" data-d="1">→</button><button type="button" class="btn danger" data-rm="${i}">✕</button></div></div>`).join('') || '<span class="muted">Пока нет скриншотов</span>'}</div>
      <div id="shots-dz"></div>`;
    dropzone($('#cover-dz'), async files => {
      if (!checkImg(files[0])) return;
      toast('Загрузка обложки…');
      try { await setCover(files[0]); toast('Обложка обновлена.', 'success'); } catch (e) { toast(friendlyError(e, 'Не удалось загрузить изображение.'), 'error'); }
      renderImages();
    }, { multiple: false, accept: 'image/*' });
    dropzone($('#shots-dz'), async files => {
      toast('Загрузка скриншотов…');
      for (const f of files) {
        if (!checkImg(f)) continue;
        try { await addShot(f); } catch (e) { toast(friendlyError(e, `Не удалось загрузить «${f.name}».`), 'error'); }
      }
      renderImages();
    }, { accept: 'image/*' });
    box.onclick = async e => {
      const t = e.target.closest('button'); if (!t) return;
      try {
        if (t.id === 'cover-del') {
          const { error } = await supabase.from('projects').update({ cover_path: null }).eq('id', id);
          if (error) throw error;
          await assets().remove([p.cover_path]); p.cover_path = null;
        } else if (t.dataset.rm !== undefined) {
          const im = images[+t.dataset.rm];
          if (!await confirmDialog('Удалить скриншот?')) return;
          const { error } = await supabase.from('project_images').delete().eq('id', im.id);
          if (error) throw error;
          await assets().remove([im.storage_path]); images.splice(+t.dataset.rm, 1);
        } else if (t.dataset.mv !== undefined) {
          const i = +t.dataset.mv, j = i + +t.dataset.d;
          if (j < 0 || j >= images.length) return;
          const a = images[i], b = images[j];
          const r1 = await supabase.from('project_images').update({ position: b.position }).eq('id', a.id);
          const r2 = await supabase.from('project_images').update({ position: a.position }).eq('id', b.id);
          if (r1.error || r2.error) throw (r1.error || r2.error);
          [a.position, b.position] = [b.position, a.position];
          images.sort((x, y) => x.position - y.position);
        } else return;
      } catch (err) { toast(friendlyError(err, 'Не удалось выполнить действие.'), 'error'); }
      renderImages();
    };
  }
  renderImages();
}

/* ------------------------------------ Releases ------------------------------------ */
async function deleteRelease(id) {
  const { data, error } = await supabase.from('release_files').select('storage_path').eq('release_id', id);
  if (error) throw error;
  await removeObjects(BUCKET_FILES, data.map(f => f.storage_path));
  const r = await supabase.from('releases').delete().eq('id', id);
  if (r.error) throw r.error;
}

async function adminReleases(projectId) {
  adminShell('releases', `<h1>Releases</h1><div class="skeleton" style="height:200px"></div>`);
  let q = supabase.from('releases').select('id,project_id,version,released_at,status,projects(title),release_files(count)').order('released_at', { ascending: false });
  if (projectId) q = q.eq('project_id', projectId);
  const { data, error } = await q;
  if (error) { console.error(error); adminShell('releases', stateBlock('error', 'Не удалось загрузить релизы.')); return; }
  let title = '';
  if (projectId) { const pr = await supabase.from('projects').select('title').eq('id', projectId).maybeSingle(); title = pr.data?.title || ''; }
  adminShell('releases', `<div class="row between"><h1>Releases${title ? ': ' + esc(title) : ''}</h1>
    ${projectId ? `<a class="btn primary" href="#/admin/projects/${projectId}/releases/new">+ New Release</a>` : '<span class="muted sm">Новый релиз: Projects → Releases нужного проекта</span>'}</div>
    ${data.length ? `<div class="tablewrap"><table><thead><tr><th>Project</th><th>Version</th><th>Date</th><th>Status</th><th>Files</th><th>Actions</th></tr></thead><tbody>
    ${data.map(r => `<tr><td>${esc(r.projects?.title || '')}</td><td><strong>v${esc(r.version)}</strong></td><td>${fmtDate(r.released_at)}</td>
      <td><span class="badge ${r.status}">${r.status}</span></td><td>${r.release_files?.[0]?.count ?? 0}</td>
      <td class="row"><a class="btn" href="#/admin/releases/${r.id}">Edit</a><button class="btn danger" data-del="${r.id}" data-v="${esc(r.version)}">Delete</button></td></tr>`).join('')}
    </tbody></table></div>` : stateBlock('', 'Релизов пока нет.')}`);
  $('.adm-body').onclick = async e => {
    const b = e.target.closest('[data-del]'); if (!b) return;
    if (!await confirmDialog(`Удалить релиз v${b.dataset.v} вместе с файлами?`)) return;
    b.disabled = true;
    try { await deleteRelease(b.dataset.del); toast('Релиз удалён.', 'success'); adminReleases(projectId); }
    catch (err) { toast(friendlyError(err, 'Не удалось удалить релиз.'), 'error'); b.disabled = false; }
  };
}

async function adminReleaseEditor(releaseId, projectId) {
  let r = { id: null, project_id: projectId, version: '', released_at: new Date().toISOString().slice(0, 10), description: '', changelog: '', supported_versions: '', checksum: '', status: 'draft' };
  let files = [], projectTitle = '';
  adminShell('releases', `<div class="skeleton" style="height:300px"></div>`);
  if (releaseId) {
    const { data, error } = await supabase.from('releases').select('*, release_files(*), projects(title)').eq('id', releaseId).maybeSingle();
    if (error || !data) { adminShell('releases', stateBlock('error', 'Релиз не найден.')); return; }
    r = data; files = (data.release_files || []).sort((a, b) => a.created_at.localeCompare(b.created_at)); projectTitle = data.projects?.title || '';
  } else {
    const pr = await supabase.from('projects').select('title').eq('id', projectId).maybeSingle();
    if (!pr.data) { adminShell('releases', stateBlock('error', 'Проект не найден.')); return; }
    projectTitle = pr.data.title;
  }
  let queue = []; // {key, file, state: 'wait'|'uploading'|'done'|'error', pct, err}

  adminShell('releases', `
    <div class="row between"><h1>${releaseId ? 'Редактирование релиза' : 'Новый релиз'}</h1><a class="btn" href="#/admin/projects/${r.project_id}/releases">← К релизам</a></div>
    <p class="muted">Проект: ${esc(projectTitle)}</p>
    <form id="rf" class="panel">
      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(200px,1fr))">
        <div><label>Version *</label><input id="r-ver" value="${esc(r.version)}" placeholder="1.4.0" maxlength="40"></div>
        <div><label>Release date</label><input id="r-date" type="date" value="${esc(r.released_at)}"></div>
        <div><label>Supported versions</label><input id="r-sv" value="${esc(r.supported_versions)}" placeholder="Minecraft 1.21.x"></div>
        <div><label>Checksum (SHA-256, необязательно)</label><input id="r-sum" value="${esc(r.checksum || '')}"></div>
      </div>
      <label>Краткое описание релиза</label><input id="r-desc" value="${esc(r.description)}">
      <label>Changelog (Markdown)</label><textarea id="r-log">${esc(r.changelog)}</textarea>
      <label>Статус: <strong>${esc(r.status)}</strong></label>
      <h3 style="margin-top:22px">Файлы</h3>
      <div id="f-exist"></div>
      <div id="f-dz"></div>
      <div id="f-queue"></div>
      <div class="row actions">
        <button type="button" class="btn" data-save="draft">Save Draft</button>
        <button type="button" class="btn primary" data-save="published">Publish</button>
        <button type="button" class="btn" data-save="archived">Archive</button>
      </div>
    </form>`);

  const form = $('#rf');
  form.onsubmit = e => e.preventDefault();

  const drawExisting = () => {
    $('#f-exist').innerHTML = files.map(f => `<div class="fileline"><span>${esc(f.original_name)} <span class="muted sm">${fmtSize(f.size_bytes)} · ⬇ ${f.downloads}</span></span><button type="button" class="btn danger" data-fdel="${f.id}">Удалить</button></div>`).join('') || '<p class="muted">Файлов пока нет.</p>';
  };
  const drawQueue = () => {
    $('#f-queue').innerHTML = queue.map(it => `<div class="q-item"><div class="row between"><span>${esc(it.file.name)} <span class="muted sm">${fmtSize(it.file.size)}</span></span>
      <span class="sm ${it.state === 'error' ? '' : 'muted'}" style="${it.state === 'error' ? 'color:#fca5a5' : it.state === 'done' ? 'color:#86efac' : ''}">
      ${it.state === 'wait' ? 'Ожидает' : it.state === 'uploading' ? it.pct + '%' : it.state === 'done' ? '✓ Загружено' : esc(it.err)}</span>
      ${it.state === 'wait' || it.state === 'error' ? `<button type="button" class="btn" data-qrm="${it.key}">✕</button>` : ''}</div>
      <div class="bar"><i style="width:${it.state === 'done' ? 100 : it.pct || 0}%"></i></div></div>`).join('');
  };
  drawExisting();
  dropzone($('#f-dz'), fs => {
    fs.forEach(f => queue.push({ key: rid8(), file: f, state: 'wait', pct: 0, err: '' }));
    drawQueue();
  });

  form.addEventListener('click', async e => {
    const q = e.target.closest('[data-qrm]');
    if (q) { queue = queue.filter(i => i.key !== q.dataset.qrm); drawQueue(); return; }
    const d = e.target.closest('[data-fdel]');
    if (d) {
      if (!await confirmDialog('Удалить файл из релиза?')) return;
      const f = files.find(x => x.id === d.dataset.fdel);
      try {
        await removeObjects(BUCKET_FILES, [f.storage_path]);
        const { error } = await supabase.from('release_files').delete().eq('id', f.id);
        if (error) throw error;
        files = files.filter(x => x.id !== f.id); drawExisting(); toast('Файл удалён.', 'success');
      } catch (err) { toast(friendlyError(err, 'Не удалось удалить файл.'), 'error'); }
    }
  });

  form.querySelector('.actions').addEventListener('click', async e => {
    const b = e.target.closest('[data-save]'); if (!b) return;
    const version = $('#r-ver').value.trim();
    if (!version) return toast('Введите номер версии.', 'error');
    const target = b.dataset.save;
    const row = {
      project_id: r.project_id, version, released_at: $('#r-date').value || new Date().toISOString().slice(0, 10),
      description: $('#r-desc').value.trim(), changelog: $('#r-log').value,
      supported_versions: $('#r-sv').value.trim(), checksum: $('#r-sum').value.trim() || null
    };
    setBusy(form, true);
    try {
      if (!r.id) {
        const { data, error } = await supabase.from('releases').insert({ ...row, status: 'draft' }).select('id').single();
        if (error) throw error;
        r.id = data.id; r.status = 'draft';
        history.replaceState(null, '', '#/admin/releases/' + r.id);
      } else {
        const { error } = await supabase.from('releases').update(row).eq('id', r.id);
        if (error) throw error;
      }
    } catch (err) { setBusy(form, false); toast(friendlyError(err, 'Не удалось сохранить релиз.'), 'error'); return; }

    // загрузка файлов
    const onUnload = ev => { ev.preventDefault(); ev.returnValue = ''; };
    window.addEventListener('beforeunload', onUnload);
    let failed = 0;
    for (const it of queue.filter(i => i.state !== 'done')) {
      it.state = 'uploading'; it.pct = 0; drawQueue();
      const safe = it.file.name.replace(/[^A-Za-z0-9._-]/g, '_');
      const path = `${r.project_id}/${r.id}/${safe}`;
      try {
        await uploadWithProgress(BUCKET_FILES, path, it.file, pct => { it.pct = pct; drawQueue(); });
        const { data, error } = await supabase.from('release_files').insert({
          release_id: r.id, original_name: it.file.name, storage_path: path,
          mime_type: it.file.type || 'application/octet-stream', size_bytes: it.file.size
        }).select('*').single();
        if (error) { await supabase.storage.from(BUCKET_FILES).remove([path]); throw error; }
        files.push(data); it.state = 'done'; it.pct = 100;
      } catch (err) {
        failed++; it.state = 'error'; it.err = uploadErrorMessage(err); console.error(err);
      }
      drawQueue();
    }
    window.removeEventListener('beforeunload', onUnload);
    queue = queue.filter(i => i.state !== 'done'); drawQueue(); drawExisting();
    if (failed) {
      setBusy(form, false);
      toast(`Не загружено файлов: ${failed}. Релиз сохранён, статус не изменён. Повторите попытку.`, 'error');
      return;
    }
    const { error } = await supabase.from('releases').update({ status: target }).eq('id', r.id);
    setBusy(form, false);
    if (error) { toast(friendlyError(error, 'Не удалось изменить статус релиза.'), 'error'); return; }
    toast('Релиз сохранён.', 'success');
    location.hash = '#/admin/projects/' + r.project_id + '/releases';
  });
}

/* -------------------------------------- Files -------------------------------------- */
async function adminFiles() {
  adminShell('files', `<h1>Files</h1><div class="skeleton" style="height:200px"></div>`);
  const { data, error } = await supabase.from('release_files')
    .select('id,original_name,storage_path,size_bytes,downloads,created_at,releases(version,projects(title))')
    .order('created_at', { ascending: false }).limit(200);
  if (error) { console.error(error); adminShell('files', stateBlock('error', 'Не удалось загрузить файлы.')); return; }
  adminShell('files', `<h1>Files</h1>
    ${data.length ? `<div class="tablewrap"><table><thead><tr><th>File</th><th>Project</th><th>Version</th><th>Size</th><th>Downloads</th><th>Uploaded</th><th>Actions</th></tr></thead><tbody>
    ${data.map(f => `<tr><td>${esc(f.original_name)}</td><td>${esc(f.releases?.projects?.title || '')}</td><td>v${esc(f.releases?.version || '')}</td>
      <td>${fmtSize(f.size_bytes)}</td><td>${f.downloads}</td><td>${fmtDate(f.created_at)}</td>
      <td><button class="btn danger" data-del="${f.id}">Delete</button></td></tr>`).join('')}
    </tbody></table></div>` : stateBlock('', 'Файлов пока нет.')}`);
  $('.adm-body').onclick = async e => {
    const b = e.target.closest('[data-del]'); if (!b) return;
    const f = data.find(x => x.id === b.dataset.del);
    if (!await confirmDialog(`Удалить файл «${f.original_name}»?`)) return;
    b.disabled = true;
    try {
      await removeObjects(BUCKET_FILES, [f.storage_path]);
      const { error: er } = await supabase.from('release_files').delete().eq('id', f.id);
      if (er) throw er;
      toast('Файл удалён.', 'success'); adminFiles();
    } catch (err) { toast(friendlyError(err, 'Не удалось удалить файл.'), 'error'); b.disabled = false; }
  };
}

/* ------------------------------------ Settings ------------------------------------ */
async function adminSettings() {
  adminShell('settings', `<h1>Settings</h1><div class="skeleton" style="height:300px"></div>`);
  const { data, error } = await supabase.from('site_settings').select('*').eq('id', 1).maybeSingle();
  if (error) { console.error(error); adminShell('settings', stateBlock('error', 'Не удалось загрузить настройки.')); return; }
  let s = data || { id: 1, site_name: 'Dev Catalog', description: '', about: '', other_links: [] };
  const links = (Array.isArray(s.other_links) ? s.other_links : []).map(l => `${l.name} | ${l.url}`).join('\n');
  adminShell('settings', `<h1>Settings</h1>
    <form id="sf" class="panel">
      <label>Название сайта</label><input id="s-name" value="${esc(s.site_name)}">
      <label>Описание</label><input id="s-desc" value="${esc(s.description)}">
      <label>Обо мне (Markdown)</label><textarea id="s-about">${esc(s.about)}</textarea>
      <label>GitHub URL</label><input id="s-gh" value="${esc(s.github_url || '')}" placeholder="https://github.com/…">
      <label>Discord URL</label><input id="s-dc" value="${esc(s.discord_url || '')}">
      <label>Telegram URL</label><input id="s-tg" value="${esc(s.telegram_url || '')}">
      <label>Другие ссылки (по одной в строке: Название | https://…)</label><textarea id="s-links" style="min-height:90px">${esc(links)}</textarea>
      <div class="row actions"><button type="button" class="btn primary" id="s-save">Сохранить</button></div>
    </form>
    <div class="panel" style="margin-top:18px"><h3>Аватар / логотип</h3>
      <div class="row">${s.avatar_path ? `<img class="cover-prev" style="width:80px" src="${esc(assetUrl(s.avatar_path))}" alt="">` : '<span class="muted">Не задан</span>'}</div>
      <label>Выбрать изображение</label><input type="file" id="s-avatar" accept="image/*">
      <h3 style="margin-top:22px">Favicon</h3>
      <div class="row">${s.favicon_path ? `<img class="cover-prev" style="width:48px" src="${esc(assetUrl(s.favicon_path))}" alt="">` : '<span class="muted">Не задан</span>'}</div>
      <label>Выбрать изображение (PNG/SVG/ICO)</label><input type="file" id="s-fav" accept="image/*">
    </div>`);

  const reload = async () => {
    const r = await supabase.from('site_settings').select('*').eq('id', 1).maybeSingle();
    if (r.data) { state.settings = r.data; applySettings(); }
  };
  $('#s-save').onclick = async () => {
    const other = $('#s-links').value.split('\n').map(l => l.split('|').map(x => x.trim())).filter(([n, u]) => n && safeUrl(u)).map(([n, u]) => ({ name: n, url: safeUrl(u) }));
    const urlOrNull = v => { v = v.trim(); return v && safeUrl(v) ? safeUrl(v) : null; };
    const gh = $('#s-gh').value.trim(), dc = $('#s-dc').value.trim(), tg = $('#s-tg').value.trim();
    if ((gh && !safeUrl(gh)) || (dc && !safeUrl(dc)) || (tg && !safeUrl(tg))) return toast('Ссылки должны начинаться с http:// или https://', 'error');
    const row = { id: 1, site_name: $('#s-name').value.trim() || 'Dev Catalog', description: $('#s-desc').value.trim(), about: $('#s-about').value, github_url: urlOrNull(gh), discord_url: urlOrNull(dc), telegram_url: urlOrNull(tg), other_links: other };
    const f = $('#sf'); setBusy(f, true);
    const { error: er } = await supabase.from('site_settings').upsert(row);
    setBusy(f, false);
    if (er) { toast(friendlyError(er, 'Не удалось сохранить настройки.'), 'error'); return; }
    await reload(); toast('Настройки сохранены.', 'success');
  };
  const uploadSite = async (kind, input) => {
    const file = input.files[0]; if (!file) return;
    if (!file.type.startsWith('image/') || file.size > 10 * 1024 * 1024) return toast('Нужно изображение до 10 МБ.', 'error');
    const col = kind === 'avatar' ? 'avatar_path' : 'favicon_path';
    const path = `site/${kind}-${rid8()}.${extOf(file)}`;
    try {
      const up = await supabase.storage.from(BUCKET_ASSETS).upload(path, file, { contentType: file.type, upsert: false, cacheControl: '31536000' });
      if (up.error) throw up.error;
      const { error: er } = await supabase.from('site_settings').upsert({ id: 1, [col]: path });
      if (er) { await supabase.storage.from(BUCKET_ASSETS).remove([path]); throw er; }
      if (s[col]) await supabase.storage.from(BUCKET_ASSETS).remove([s[col]]);
      await reload(); toast('Изображение обновлено.', 'success'); adminSettings();
    } catch (err) { toast(friendlyError(err, 'Не удалось загрузить изображение.'), 'error'); }
  };
  $('#s-avatar').onchange = e => uploadSite('avatar', e.target);
  $('#s-fav').onchange = e => uploadSite('favicon', e.target);
}

/* -------------------------------------- Старт -------------------------------------- */
async function init() {
  if (SUPABASE_URL.includes('YOUR-PROJECT') || SUPABASE_ANON_KEY.includes('YOUR-ANON')) {
    app.innerHTML = '<div class="state" style="margin:80px 20px">Откройте <code>app.js</code> и впишите SUPABASE_URL и SUPABASE_ANON_KEY.</div>';
    return;
  }
  try { await refreshAuth(); } catch (e) { console.error(e); }
  try {
    const [s, c] = await Promise.all([
      supabase.from('site_settings').select('*').eq('id', 1).maybeSingle(),
      supabase.from('categories').select('*').order('position')
    ]);
    state.settings = s.data; state.categories = c.data || [];
  } catch (e) { console.error(e); }
  applySettings();
  window.addEventListener('hashchange', render);
  render();
}
init();