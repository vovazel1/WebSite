-- =========================================================
-- Dev Catalog: схема, RLS, Storage, RPC, demo-данные
-- Запустить целиком: Supabase → SQL Editor → New query → Run
-- =========================================================
create extension if not exists pgcrypto;

-- ---------- Таблицы ----------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  role text not null default 'user' check (role in ('admin','user')),
  created_at timestamptz not null default now()
);

create table public.categories (
  slug text primary key check (slug ~ '^[a-z0-9-]+$'),
  name text not null,
  position int not null default 0,
  created_at timestamptz not null default now()
);

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  title text not null check (char_length(title) between 1 and 120),
  summary text not null default '' check (char_length(summary) <= 300),
  description text not null default '',
  category text not null references public.categories(slug) on update cascade,
  tags text[] not null default '{}',
  supported_versions text not null default '',
  cover_path text,
  featured boolean not null default false,
  status text not null default 'draft' check (status in ('draft','published','archived')),
  downloads integer not null default 0,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index projects_status_updated_idx on public.projects (status, updated_at desc);
create index projects_tags_idx on public.projects using gin (tags);

create table public.project_images (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  storage_path text not null unique,
  position int not null default 0,
  created_at timestamptz not null default now()
);
create index project_images_project_idx on public.project_images (project_id, position);

create table public.releases (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  version text not null check (char_length(version) between 1 and 40),
  released_at date not null default current_date,
  description text not null default '',
  changelog text not null default '',
  supported_versions text not null default '',
  checksum text,
  status text not null default 'draft' check (status in ('draft','published','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, version)
);
create index releases_project_status_idx on public.releases (project_id, status);

create table public.release_files (
  id uuid primary key default gen_random_uuid(),
  release_id uuid not null references public.releases(id) on delete cascade,
  original_name text not null,
  storage_path text not null unique,
  mime_type text not null default 'application/octet-stream',
  size_bytes bigint not null default 0,
  downloads integer not null default 0,
  created_at timestamptz not null default now()
);
create index release_files_release_idx on public.release_files (release_id);

create table public.download_events (
  id uuid primary key default gen_random_uuid(),
  file_id uuid not null references public.release_files(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  client_id text not null,
  created_at timestamptz not null default now()
);
create index download_events_rate_idx on public.download_events (file_id, client_id, created_at desc);

create table public.site_settings (
  id int primary key check (id = 1),
  site_name text not null default 'Dev Catalog',
  description text not null default '',
  about text not null default '',
  avatar_path text,
  favicon_path text,
  github_url text,
  discord_url text,
  telegram_url text,
  other_links jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

-- ---------- Функции и триггеры ----------
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

create trigger projects_updated before update on public.projects
  for each row execute function public.set_updated_at();
create trigger releases_updated before update on public.releases
  for each row execute function public.set_updated_at();
create trigger settings_updated before update on public.site_settings
  for each row execute function public.set_updated_at();

create or replace function public.set_published_at()
returns trigger language plpgsql as $$
begin
  if new.status = 'published' and new.published_at is null then new.published_at = now(); end if;
  return new;
end $$;
create trigger projects_published before insert or update on public.projects
  for each row execute function public.set_published_at();

-- Профиль создаётся автоматически с ролью user (admin выдаётся вручную)
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, role) values (new.id, new.email, 'user')
  on conflict (id) do nothing;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Если пользователи уже были созданы до этого скрипта
insert into public.profiles (id, email, role)
select id, email, 'user' from auth.users on conflict (id) do nothing;

-- Скачивание: проверка, защита от накрутки (1 раз в час на файл с одного клиента), счётчики.
-- Возвращает путь в Storage только для опубликованных файлов.
create or replace function public.register_download(p_file uuid, p_client text)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_path text;
  v_project uuid;
  v_client text := left(coalesce(p_client, 'anon'), 64);
  v_recent int;
begin
  select f.storage_path, r.project_id into v_path, v_project
  from public.release_files f
  join public.releases r on r.id = f.release_id
  join public.projects p on p.id = r.project_id
  where f.id = p_file and r.status = 'published' and p.status = 'published';

  if v_path is null then raise exception 'not_found'; end if;

  select count(*) into v_recent from public.download_events
  where file_id = p_file and client_id = v_client and created_at > now() - interval '1 hour';

  if v_recent = 0 then
    insert into public.download_events (file_id, project_id, client_id) values (p_file, v_project, v_client);
    update public.release_files set downloads = downloads + 1 where id = p_file;
    update public.projects set downloads = downloads + 1 where id = v_project;
  end if;

  return v_path;
end $$;
revoke all on function public.register_download(uuid, text) from public;
grant execute on function public.register_download(uuid, text) to anon, authenticated;

-- ---------- RLS ----------
alter table public.profiles        enable row level security;
alter table public.categories      enable row level security;
alter table public.projects        enable row level security;
alter table public.project_images  enable row level security;
alter table public.releases        enable row level security;
alter table public.release_files   enable row level security;
alter table public.download_events enable row level security;
alter table public.site_settings   enable row level security;

-- profiles: видеть свой профиль; менять роли может только админ
create policy "profiles read own or admin" on public.profiles for select
  using (id = auth.uid() or public.is_admin());
create policy "profiles admin write" on public.profiles for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- categories и site_settings: читают все
create policy "categories read" on public.categories for select using (true);
create policy "categories admin write" on public.categories for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy "settings read" on public.site_settings for select using (true);
create policy "settings admin write" on public.site_settings for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- projects: гости видят только published
create policy "projects read" on public.projects for select
  using (status = 'published' or public.is_admin());
create policy "projects admin write" on public.projects for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Дочерние таблицы: подзапрос сам проходит через RLS родителя,
-- поэтому гость видит только строки опубликованных родителей.
create policy "images read" on public.project_images for select
  using (exists (select 1 from public.projects p where p.id = project_images.project_id));
create policy "images admin write" on public.project_images for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy "releases read" on public.releases for select
  using (
    public.is_admin()
    or (status = 'published'
        and exists (select 1 from public.projects p where p.id = releases.project_id))
  );
create policy "releases admin write" on public.releases for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy "files read" on public.release_files for select
  using (exists (select 1 from public.releases r where r.id = release_files.release_id));
create policy "files admin write" on public.release_files for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- download_events: только админ читает; писать можно лишь через register_download()
create policy "events admin read" on public.download_events for select to authenticated
  using (public.is_admin());

-- ---------- Storage ----------
-- project-assets: публичный (обложки, скриншоты, аватар, favicon), лимит 10 МБ
-- project-files: ПРИВАТНЫЙ (релизные файлы), лимит 50 МБ (повысить можно в настройках Storage на платном тарифе)
insert into storage.buckets (id, name, public, file_size_limit) values
  ('project-assets', 'project-assets', true, 10485760),
  ('project-files',  'project-files',  false, 52428800)
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit;

create policy "assets admin insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'project-assets' and public.is_admin());
create policy "assets admin update" on storage.objects for update to authenticated
  using (bucket_id = 'project-assets' and public.is_admin());
create policy "assets admin delete" on storage.objects for delete to authenticated
  using (bucket_id = 'project-assets' and public.is_admin());

create policy "files admin insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'project-files' and public.is_admin());
create policy "files admin update" on storage.objects for update to authenticated
  using (bucket_id = 'project-files' and public.is_admin());
create policy "files admin delete" on storage.objects for delete to authenticated
  using (bucket_id = 'project-files' and public.is_admin());

-- Подписанную ссылку можно получить только для файла опубликованного релиза (админ: для любого)
create policy "files read published" on storage.objects for select
  using (
    bucket_id = 'project-files'
    and (
      public.is_admin()
      or exists (
        select 1 from public.release_files f
        join public.releases r on r.id = f.release_id
        join public.projects p on p.id = r.project_id
        where f.storage_path = storage.objects.name
          and r.status = 'published' and p.status = 'published'
      )
    )
  );

-- ---------- Начальные данные ----------
insert into public.categories (slug, name, position) values
  ('programs','Programs',1),
  ('minecraft-mods','Minecraft Mods',2),
  ('resource-packs','Resource Packs',3),
  ('plugins','Plugins',4),
  ('tools','Tools',5),
  ('other','Other',6)
on conflict do nothing;

insert into public.site_settings (id, site_name, description, about) values
  (1, 'Dev Catalog', 'Каталог моих программ, модов и утилит.',
   E'Привет! Я разработчик. Здесь собраны мои проекты.\n\nТекст можно изменить в **Admin → Settings**.')
on conflict (id) do nothing;

-- ---------- DEMO-данные (легко удалить, см. конец файла) ----------
insert into public.projects (slug, title, summary, description, category, tags, supported_versions, featured, status) values
 ('example-mod','Example Mod','Демонстрационный Minecraft-мод.',
  E'# Возможности\n\n- Первая возможность\n- Вторая возможность\n\n## Установка\n\nПоложите `.jar` в папку `mods`.',
  'minecraft-mods', array['demo','minecraft','forge'], 'Minecraft 1.21.x', true, 'published'),
 ('developer-tool','Developer Tool','Демонстрационная утилита для разработчиков.',
  E'# Описание\n\nПример проекта в категории **Tools**.\n\n```\ndev-tool --help\n```',
  'tools', array['demo','cli'], 'Windows 10+', true, 'published'),
 ('example-resource-pack','Example Resource Pack','Демонстрационный пакет ресурсов.',
  E'# Пак ресурсов\n\nТекстуры 16x для примера.',
  'resource-packs', array['demo','textures'], 'Minecraft 1.20–1.21', false, 'published');

insert into public.releases (project_id, version, released_at, description, changelog, supported_versions, status)
select id, '1.0.0', current_date, 'Первый релиз.', E'## 1.0.0\n\n- Первая версия', supported_versions, 'published'
from public.projects where 'demo' = any(tags);

-- Удалить demo-данные позже:
-- delete from public.projects where 'demo' = any(tags);