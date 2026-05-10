-- =============================================================
-- Auto monitoring — schéma pro Supabase
-- Spustit jednou v SQL Editoru po vytvoření Supabase projektu
-- =============================================================

-- Generická key/value tabulka pro data každého uživatele.
-- Přihlášený uživatel uvidí (a může psát) pouze své záznamy.
create table if not exists public.user_data (
  user_id    uuid          references auth.users on delete cascade not null,
  key        text          not null,
  value      jsonb         not null,
  updated_at timestamptz   not null default now(),
  primary key (user_id, key)
);

-- Index pro rychlé dotazy podle key (frontend většinou volá storage.get(key))
create index if not exists user_data_key_idx on public.user_data (key);

-- Row Level Security
alter table public.user_data enable row level security;

-- Smazat staré politiky (kdyby existovaly z dřívějšího pokusu)
drop policy if exists "user reads own data"   on public.user_data;
drop policy if exists "user inserts own data" on public.user_data;
drop policy if exists "user updates own data" on public.user_data;
drop policy if exists "user deletes own data" on public.user_data;

-- Každý vidí jen své řádky
create policy "user reads own data"
  on public.user_data for select
  using (auth.uid() = user_id);

-- Každý může vkládat jen své řádky
create policy "user inserts own data"
  on public.user_data for insert
  with check (auth.uid() = user_id);

-- Každý může měnit jen své řádky
create policy "user updates own data"
  on public.user_data for update
  using (auth.uid() = user_id);

-- Každý může mazat jen své řádky
create policy "user deletes own data"
  on public.user_data for delete
  using (auth.uid() = user_id);

-- =============================================================
-- HOTOVO. Aplikace teď může volat:
--   supabase.from('user_data').select(...).eq('user_id', auth.uid()).eq('key', 'current-trip')
-- a Supabase díky RLS sám zajistí, že každý uvidí jen své záznamy.
-- =============================================================


-- =============================================================
-- NOTIFIKACE — log odeslaných e-mailů (zabrání duplikátům)
-- Worker (cron) sem zapisuje vždy, když pošle e-mail uživateli
-- o blížícím se termínu STK/pojištění/dálniční známky.
-- =============================================================

create table if not exists public.notifications_sent (
  id                uuid          primary key default gen_random_uuid(),
  user_id           uuid          references auth.users on delete cascade not null,
  vehicle_id        text          not null,
  doc_type          text          not null,                 -- 'stk' | 'insurance' | 'vignette'
  expiration_date   date          not null,
  notification_type text          not null,                 -- 'month' | 'week'
  sent_at           timestamptz   not null default now()
);

-- Unikátní kombinace zabrání odeslání téhož mailu vícekrát
create unique index if not exists notifications_sent_dedup
  on public.notifications_sent (user_id, vehicle_id, doc_type, expiration_date, notification_type);

-- RLS: klient nemá přístup vůbec, jen worker přes service_role key (který RLS obchází)
alter table public.notifications_sent enable row level security;
-- (žádné policies = žádný přístup z klienta — service_role to neřeší)

-- =============================================================
-- HOTOVO. Worker teď může logovat odeslané notifikace
-- a kontrolovat duplikáty před každým odesláním.
-- =============================================================
