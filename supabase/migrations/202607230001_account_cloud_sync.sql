begin;

create table if not exists public.cplayer_playlists (
    user_id uuid not null references auth.users(id) on delete cascade,
    playlist_id text not null,
    name text not null,
    songs jsonb not null default '[]'::jsonb,
    version bigint not null default 1,
    updated_at timestamptz not null default timezone('utc', now()),
    deleted_at timestamptz,
    primary key (user_id, playlist_id),
    constraint cplayer_playlist_id_shape
        check (playlist_id like 'user\_pl\_%' escape '\' and char_length(playlist_id) <= 160),
    constraint cplayer_playlist_name_shape
        check (char_length(btrim(name)) between 1 and 100),
    constraint cplayer_playlist_songs_shape
        check (jsonb_typeof(songs) = 'array' and jsonb_array_length(songs) <= 10000),
    constraint cplayer_playlist_version_shape
        check (version >= 1)
);

alter table public.cplayer_playlists enable row level security;
alter table public.cplayer_playlists force row level security;

drop policy if exists cplayer_playlists_select_own on public.cplayer_playlists;
create policy cplayer_playlists_select_own
on public.cplayer_playlists
for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists cplayer_playlists_insert_own on public.cplayer_playlists;
create policy cplayer_playlists_insert_own
on public.cplayer_playlists
for insert
to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists cplayer_playlists_update_own on public.cplayer_playlists;
create policy cplayer_playlists_update_own
on public.cplayer_playlists
for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists cplayer_playlists_delete_own on public.cplayer_playlists;
create policy cplayer_playlists_delete_own
on public.cplayer_playlists
for delete
to authenticated
using ((select auth.uid()) = user_id);

revoke all on table public.cplayer_playlists from anon, authenticated;
grant select on table public.cplayer_playlists to authenticated;

create or replace function public.sync_cplayer_playlist(
    p_playlist_id text,
    p_name text,
    p_songs jsonb,
    p_expected_version bigint
)
returns setof public.cplayer_playlists
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
    v_user_id uuid := auth.uid();
    v_row public.cplayer_playlists;
begin
    if v_user_id is null then
        raise exception using errcode = '42501', message = 'authentication_required';
    end if;
    if p_playlist_id is null or p_playlist_id not like 'user\_pl\_%' escape '\'
        or char_length(p_playlist_id) > 160 then
        raise exception using errcode = '22023', message = 'invalid_playlist_id';
    end if;
    if p_name is null or char_length(btrim(p_name)) not between 1 and 100 then
        raise exception using errcode = '22023', message = 'invalid_playlist_name';
    end if;
    if p_songs is null or jsonb_typeof(p_songs) <> 'array'
        or jsonb_array_length(p_songs) > 10000
        or octet_length(p_songs::text) > 5242880 then
        raise exception using errcode = '22023', message = 'invalid_playlist_songs';
    end if;
    if p_expected_version is null or p_expected_version < 0 then
        raise exception using errcode = '22023', message = 'invalid_expected_version';
    end if;

    if p_expected_version = 0 then
        perform pg_advisory_xact_lock(hashtext(v_user_id::text));
        if (select count(*) from public.cplayer_playlists where user_id = v_user_id) >= 500 then
            raise exception using errcode = '22023', message = 'playlist_limit_reached';
        end if;
        begin
            insert into public.cplayer_playlists (
                user_id, playlist_id, name, songs, version, updated_at, deleted_at
            ) values (
                v_user_id, p_playlist_id, btrim(p_name), p_songs, 1,
                timezone('utc', now()), null
            )
            returning * into v_row;
        exception
            when unique_violation then
                raise exception using errcode = 'P0001', message = 'cplayer_playlist_conflict';
        end;
    else
        update public.cplayer_playlists
        set name = btrim(p_name),
            songs = p_songs,
            version = version + 1,
            updated_at = timezone('utc', now()),
            deleted_at = null
        where user_id = v_user_id
          and playlist_id = p_playlist_id
          and version = p_expected_version
        returning * into v_row;
        if not found then
            raise exception using errcode = 'P0001', message = 'cplayer_playlist_conflict';
        end if;
    end if;

    return next v_row;
end;
$$;

create or replace function public.delete_cplayer_playlist(
    p_playlist_id text,
    p_expected_version bigint
)
returns setof public.cplayer_playlists
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
    v_user_id uuid := auth.uid();
    v_row public.cplayer_playlists;
begin
    if v_user_id is null then
        raise exception using errcode = '42501', message = 'authentication_required';
    end if;
    if p_playlist_id is null or p_playlist_id not like 'user\_pl\_%' escape '\'
        or char_length(p_playlist_id) > 160
        or p_expected_version is null or p_expected_version < 1 then
        raise exception using errcode = '22023', message = 'invalid_delete_request';
    end if;

    update public.cplayer_playlists
    set version = version + 1,
        updated_at = timezone('utc', now()),
        deleted_at = timezone('utc', now())
    where user_id = v_user_id
      and playlist_id = p_playlist_id
      and version = p_expected_version
    returning * into v_row;
    if not found then
        raise exception using errcode = 'P0001', message = 'cplayer_playlist_conflict';
    end if;

    return next v_row;
end;
$$;

create or replace function public.delete_cplayer_account()
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
    v_user_id uuid := auth.uid();
begin
    if v_user_id is null then
        raise exception using errcode = '42501', message = 'authentication_required';
    end if;
    delete from auth.users where id = v_user_id;
    if not found then
        raise exception using errcode = 'P0002', message = 'account_not_found';
    end if;
end;
$$;

revoke all on function public.sync_cplayer_playlist(text, text, jsonb, bigint) from public, anon;
revoke all on function public.delete_cplayer_playlist(text, bigint) from public, anon;
revoke all on function public.delete_cplayer_account() from public, anon;
grant execute on function public.sync_cplayer_playlist(text, text, jsonb, bigint) to authenticated;
grant execute on function public.delete_cplayer_playlist(text, bigint) to authenticated;
grant execute on function public.delete_cplayer_account() to authenticated;

commit;
