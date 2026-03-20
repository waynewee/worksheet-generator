create extension if not exists pgcrypto with schema extensions;

create table if not exists public.app_accounts (
  id uuid primary key default extensions.gen_random_uuid(),
  username text not null,
  password_hash text not null,
  created_at timestamptz not null default now(),
  constraint app_accounts_username_format_check check (
    char_length(username) between 3 and 30
    and username ~ '^[a-z0-9][a-z0-9_.-]*[a-z0-9]$'
  )
);

create unique index if not exists app_accounts_username_lower_idx
  on public.app_accounts (lower(username));

create table if not exists public.app_sessions (
  id uuid primary key default extensions.gen_random_uuid(),
  account_id uuid not null references public.app_accounts (id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 days'),
  revoked_at timestamptz,
  last_seen_at timestamptz not null default now()
);

create index if not exists app_sessions_account_id_idx
  on public.app_sessions (account_id, created_at desc);

create index if not exists app_sessions_token_hash_idx
  on public.app_sessions (token_hash);

create table if not exists public.assets (
  id uuid primary key default extensions.gen_random_uuid(),
  owner_account_id uuid references public.app_accounts (id) on delete cascade,
  name text not null,
  public_url text not null,
  width integer not null check (width > 0),
  height integer not null check (height > 0),
  byte_size integer,
  storage_path text not null unique,
  content_hash text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.worksheets (
  id uuid primary key default extensions.gen_random_uuid(),
  owner_account_id uuid references public.app_accounts (id) on delete cascade,
  name text not null,
  layout jsonb not null default '{"items": [], "groups": []}'::jsonb,
  item_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.assets
  add column if not exists owner_account_id uuid references public.app_accounts (id) on delete cascade;

alter table public.worksheets
  add column if not exists owner_account_id uuid references public.app_accounts (id) on delete cascade;

create index if not exists worksheets_updated_at_idx on public.worksheets (updated_at desc);
create index if not exists assets_created_at_idx on public.assets (created_at desc);
create index if not exists worksheets_owner_account_idx on public.worksheets (owner_account_id, updated_at desc);
create index if not exists assets_owner_account_idx on public.assets (owner_account_id, created_at desc);
create unique index if not exists assets_owner_account_hash_idx on public.assets (owner_account_id, content_hash) where owner_account_id is not null;

create or replace function public.normalize_account_username(input text)
returns text
language sql
immutable
as $$
  select lower(trim(coalesce(input, '')));
$$;

create or replace function public.current_app_session_token()
returns text
language sql
stable
as $$
  select case
    when coalesce(current_setting('request.headers', true), '') = '' then null
    else nullif((current_setting('request.headers', true)::json ->> 'x-app-session'), '')
  end;
$$;

create or replace function public.current_account_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select sessions.account_id
  from public.app_sessions as sessions
  where sessions.token_hash = encode(extensions.digest(public.current_app_session_token(), 'sha256'), 'hex')
    and sessions.revoked_at is null
    and sessions.expires_at > now()
  order by sessions.created_at desc
  limit 1;
$$;

create or replace function public.issue_account_session(target_account_id uuid, target_username text)
returns table(account_id uuid, username text, session_token text)
language plpgsql
security definer
set search_path = public
as $$
declare
  raw_token text;
begin
  raw_token := encode(extensions.gen_random_bytes(32), 'hex');

  insert into public.app_sessions (account_id, token_hash)
  values (target_account_id, encode(extensions.digest(raw_token, 'sha256'), 'hex'));

  return query
  select target_account_id, target_username, raw_token;
end;
$$;

revoke all on function public.issue_account_session(uuid, text) from public;

create or replace function public.sign_up_account(username_input text, password_input text)
returns table(account_id uuid, username text, session_token text)
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_username text := public.normalize_account_username(username_input);
  inserted_account public.app_accounts%rowtype;
begin
  if normalized_username !~ '^[a-z0-9][a-z0-9_.-]*[a-z0-9]$'
    or char_length(normalized_username) < 3
    or char_length(normalized_username) > 30 then
    raise exception using
      errcode = '22023',
      message = 'Username must be 3-30 characters and use only letters, numbers, dots, hyphens, or underscores';
  end if;

  if char_length(coalesce(password_input, '')) < 8 then
    raise exception using
      errcode = '22023',
      message = 'Password must be at least 8 characters';
  end if;

  insert into public.app_accounts (username, password_hash)
  values (
    normalized_username,
    extensions.crypt(password_input, extensions.gen_salt('bf', 10))
  )
  returning * into inserted_account;

  return query
  select *
  from public.issue_account_session(inserted_account.id, inserted_account.username);
exception
  when unique_violation then
    raise exception using
      errcode = '23505',
      message = 'Username is already taken';
end;
$$;

create or replace function public.sign_in_account(username_input text, password_input text)
returns table(account_id uuid, username text, session_token text)
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_username text := public.normalize_account_username(username_input);
  account_row public.app_accounts%rowtype;
begin
  select *
  into account_row
  from public.app_accounts as accounts
  where accounts.username = normalized_username
    and accounts.password_hash = extensions.crypt(password_input, accounts.password_hash)
  limit 1;

  if not found then
    raise exception using
      errcode = '28000',
      message = 'Invalid username or password';
  end if;

  return query
  select *
  from public.issue_account_session(account_row.id, account_row.username);
end;
$$;

create or replace function public.get_current_account()
returns table(account_id uuid, username text)
language sql
stable
security definer
set search_path = public
as $$
  select accounts.id, accounts.username
  from public.app_sessions as sessions
  join public.app_accounts as accounts on accounts.id = sessions.account_id
  where sessions.token_hash = encode(extensions.digest(public.current_app_session_token(), 'sha256'), 'hex')
    and sessions.revoked_at is null
    and sessions.expires_at > now()
  order by sessions.created_at desc
  limit 1;
$$;

create or replace function public.sign_out_account()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.app_sessions
  set revoked_at = now()
  where token_hash = encode(extensions.digest(public.current_app_session_token(), 'sha256'), 'hex')
    and revoked_at is null;
end;
$$;

alter table public.assets enable row level security;
alter table public.worksheets enable row level security;
alter table public.app_accounts enable row level security;
alter table public.app_sessions enable row level security;

drop policy if exists "Public read assets" on public.assets;
drop policy if exists "Public write assets" on public.assets;
drop policy if exists "Account read assets" on public.assets;
drop policy if exists "Account insert assets" on public.assets;
drop policy if exists "Account update assets" on public.assets;
drop policy if exists "Account delete assets" on public.assets;
create policy "Account read assets"
on public.assets for select
using (owner_account_id = public.current_account_id());

create policy "Account insert assets"
on public.assets for insert
with check (owner_account_id = public.current_account_id());

create policy "Account update assets"
on public.assets for update
using (owner_account_id = public.current_account_id())
with check (owner_account_id = public.current_account_id());

create policy "Account delete assets"
on public.assets for delete
using (owner_account_id = public.current_account_id());

drop policy if exists "Public read worksheets" on public.worksheets;
drop policy if exists "Public write worksheets" on public.worksheets;
drop policy if exists "Account read worksheets" on public.worksheets;
drop policy if exists "Account insert worksheets" on public.worksheets;
drop policy if exists "Account update worksheets" on public.worksheets;
drop policy if exists "Account delete worksheets" on public.worksheets;
create policy "Account read worksheets"
on public.worksheets for select
using (owner_account_id = public.current_account_id());

create policy "Account insert worksheets"
on public.worksheets for insert
with check (owner_account_id = public.current_account_id());

create policy "Account update worksheets"
on public.worksheets for update
using (owner_account_id = public.current_account_id())
with check (owner_account_id = public.current_account_id());

create policy "Account delete worksheets"
on public.worksheets for delete
using (owner_account_id = public.current_account_id());

insert into storage.buckets (id, name, public)
values ('worksheet-assets', 'worksheet-assets', false)
on conflict (id) do update set public = excluded.public;

drop policy if exists "Public read bucket assets" on storage.objects;
drop policy if exists "Public write bucket assets" on storage.objects;
drop policy if exists "Account read bucket assets" on storage.objects;
drop policy if exists "Account insert bucket assets" on storage.objects;
drop policy if exists "Account update bucket assets" on storage.objects;
drop policy if exists "Account delete bucket assets" on storage.objects;

create policy "Account read bucket assets"
on storage.objects for select
using (
  bucket_id = 'worksheet-assets'
  and split_part(name, '/', 1) = coalesce(public.current_account_id()::text, '')
);

create policy "Account insert bucket assets"
on storage.objects for insert
with check (
  bucket_id = 'worksheet-assets'
  and split_part(name, '/', 1) = coalesce(public.current_account_id()::text, '')
);

create policy "Account update bucket assets"
on storage.objects for update
using (
  bucket_id = 'worksheet-assets'
  and split_part(name, '/', 1) = coalesce(public.current_account_id()::text, '')
)
with check (
  bucket_id = 'worksheet-assets'
  and split_part(name, '/', 1) = coalesce(public.current_account_id()::text, '')
);

create policy "Account delete bucket assets"
on storage.objects for delete
using (
  bucket_id = 'worksheet-assets'
  and split_part(name, '/', 1) = coalesce(public.current_account_id()::text, '')
);
