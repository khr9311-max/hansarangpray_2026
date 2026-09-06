-- ============================================================
--  사랑의교회 청년부 한반도이웃사랑선교국 2026 짝기도 매칭 · Supabase 스키마
--  Supabase 대시보드 > SQL Editor 에 붙여넣고 실행하세요.
-- ============================================================

-- 1. 참가자 -------------------------------------------------
create table if not exists public.participants (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  team            text not null,
  prayer_request  text not null,
  created_at      timestamptz not null default now()
);

create index if not exists participants_created_at_idx
  on public.participants (created_at);

-- 2. 매칭 회차 ----------------------------------------------
--    매칭을 실행할 때마다 새 회차가 쌓이고, 가장 최근 확정 회차만
--    is_active = true 를 유지합니다. (/display 는 이 회차를 봅니다)
create table if not exists public.match_rounds (
  id           uuid primary key default gen_random_uuid(),
  mode         text not null,              -- 'team' | 'random'
  target_size  smallint not null,          -- 2 | 3 | 4
  is_active    boolean not null default false,
  created_at   timestamptz not null default now()
);

create unique index if not exists match_rounds_single_active_idx
  on public.match_rounds (is_active) where is_active;

-- 3. 조 ------------------------------------------------------
create table if not exists public.match_groups (
  id            uuid primary key default gen_random_uuid(),
  round_id      uuid not null references public.match_rounds(id) on delete cascade,
  group_number  int not null,
  unique (round_id, group_number)
);

-- 4. 조원 ----------------------------------------------------
create table if not exists public.match_members (
  group_id        uuid not null references public.match_groups(id) on delete cascade,
  participant_id  uuid not null references public.participants(id) on delete cascade,
  seq             smallint not null default 0,
  primary key (group_id, participant_id)
);

-- ============================================================
--  RLS: 익명 사용자는 "제출"과 "조회"만 가능.
--  매칭 실행/삭제는 서버 액션이 service_role 키로 수행하며
--  service_role 은 RLS 를 우회합니다.
-- ============================================================
alter table public.participants  enable row level security;
alter table public.match_rounds  enable row level security;
alter table public.match_groups  enable row level security;
alter table public.match_members enable row level security;

drop policy if exists "anon can insert participants" on public.participants;
create policy "anon can insert participants"
  on public.participants for insert to anon, authenticated with check (true);

drop policy if exists "anon can read participants" on public.participants;
create policy "anon can read participants"
  on public.participants for select to anon, authenticated using (true);

drop policy if exists "anon can read rounds" on public.match_rounds;
create policy "anon can read rounds"
  on public.match_rounds for select to anon, authenticated using (true);

drop policy if exists "anon can read groups" on public.match_groups;
create policy "anon can read groups"
  on public.match_groups for select to anon, authenticated using (true);

drop policy if exists "anon can read members" on public.match_members;
create policy "anon can read members"
  on public.match_members for select to anon, authenticated using (true);

-- ============================================================
--  Realtime: /display 와 /admin 이 변경을 즉시 받도록 발행
-- ============================================================
alter publication supabase_realtime add table public.participants;
alter publication supabase_realtime add table public.match_rounds;
alter publication supabase_realtime add table public.match_groups;
alter publication supabase_realtime add table public.match_members;
