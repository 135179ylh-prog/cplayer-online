begin;

alter table public.cplayer_playlists
    add column if not exists purged_at timestamptz;

alter table public.cplayer_playlists
    drop constraint if exists cplayer_playlist_purge_shape;
alter table public.cplayer_playlists
    add constraint cplayer_playlist_purge_shape
    check (
        purged_at is null or (
            deleted_at is not null
            and name = '已永久删除'
            and songs = '[]'::jsonb
        )
    );

create index if not exists cplayer_playlists_user_deleted_idx
    on public.cplayer_playlists (user_id, deleted_at)
    where deleted_at is not null and purged_at is null;

create table if not exists public.cplayer_playlist_versions (
    user_id uuid not null references auth.users(id) on delete cascade,
    playlist_id text not null,
    snapshot_id text not null,
    name text not null,
    songs jsonb not null default '[]'::jsonb,
    reason text not null default 'edit',
    created_at timestamptz not null default timezone('utc', now()),
    primary key (user_id, playlist_id, snapshot_id),
    constraint cplayer_playlist_version_playlist_id_shape
        check (playlist_id like 'user\_pl\_%' escape '\' and char_length(playlist_id) <= 160),
    constraint cplayer_playlist_version_snapshot_id_shape
        check (char_length(btrim(snapshot_id)) between 1 and 200),
    constraint cplayer_playlist_version_name_shape
        check (char_length(btrim(name)) between 1 and 100),
    constraint cplayer_playlist_version_songs_shape
        check (jsonb_typeof(songs) = 'array' and jsonb_array_length(songs) <= 10000),
    constraint cplayer_playlist_version_reason_shape
        check (reason in ('edit', 'delete', 'restore', 'remote'))
);

create index if not exists cplayer_playlist_versions_lookup_idx
    on public.cplayer_playlist_versions (user_id, playlist_id, created_at desc);

alter table public.cplayer_playlist_versions enable row level security;
alter table public.cplayer_playlist_versions force row level security;

drop policy if exists cplayer_playlist_versions_select_own on public.cplayer_playlist_versions;
create policy cplayer_playlist_versions_select_own
on public.cplayer_playlist_versions
for select
to authenticated
using ((select auth.uid()) = user_id);

revoke all on table public.cplayer_playlist_versions from anon, authenticated;
grant select on table public.cplayer_playlist_versions to authenticated;

create or replace function public.cplayer_prune_playlist_versions(
    p_user_id uuid,
    p_playlist_id text default null
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
    delete from public.cplayer_playlist_versions
    where user_id = p_user_id
      and (p_playlist_id is null or playlist_id = p_playlist_id)
      and created_at <= timezone('utc', now()) - interval '90 days';

    delete from public.cplayer_playlist_versions target
    using (
        select user_id, playlist_id, snapshot_id
        from (
            select user_id, playlist_id, snapshot_id,
                   row_number() over (
                       partition by user_id, playlist_id
                       order by created_at desc, snapshot_id desc
                   ) as retained_rank
            from public.cplayer_playlist_versions
            where user_id = p_user_id
              and (p_playlist_id is null or playlist_id = p_playlist_id)
        ) ranked
        where retained_rank > 20
    ) expired
    where target.user_id = expired.user_id
      and target.playlist_id = expired.playlist_id
      and target.snapshot_id = expired.snapshot_id;
end;
$$;

create or replace function public.cplayer_ingest_playlist_versions(
    p_user_id uuid,
    p_playlist_id text,
    p_history jsonb
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
    v_item jsonb;
    v_snapshot_id text;
    v_name text;
    v_songs jsonb;
    v_reason text;
    v_created_at timestamptz;
begin
    if p_history is null or jsonb_typeof(p_history) <> 'array'
        or jsonb_array_length(p_history) > 20 then
        raise exception using errcode = '22023', message = 'invalid_playlist_history';
    end if;

    for v_item in select value from jsonb_array_elements(p_history)
    loop
        begin
            v_snapshot_id := btrim(v_item ->> 'snapshot_id');
            v_name := btrim(v_item ->> 'name');
            v_songs := v_item -> 'songs';
            v_reason := coalesce(nullif(v_item ->> 'reason', ''), 'edit');
            v_created_at := (v_item ->> 'created_at')::timestamptz;
        exception when others then
            raise exception using errcode = '22023', message = 'invalid_playlist_history';
        end;

        if v_item ->> 'playlist_id' is distinct from p_playlist_id
            or v_snapshot_id is null or char_length(v_snapshot_id) not between 1 and 200
            or v_name is null or char_length(v_name) not between 1 and 100
            or v_songs is null or jsonb_typeof(v_songs) <> 'array'
            or jsonb_array_length(v_songs) > 10000
            or octet_length(v_songs::text) > 5242880
            or v_reason not in ('edit', 'delete', 'restore', 'remote')
            or v_created_at > timezone('utc', now()) + interval '5 minutes' then
            raise exception using errcode = '22023', message = 'invalid_playlist_history';
        end if;

        if v_created_at > timezone('utc', now()) - interval '90 days' then
            insert into public.cplayer_playlist_versions (
                user_id, playlist_id, snapshot_id, name, songs, reason, created_at
            ) values (
                p_user_id, p_playlist_id, v_snapshot_id, v_name, v_songs, v_reason, v_created_at
            ) on conflict (user_id, playlist_id, snapshot_id) do nothing;
        end if;
    end loop;
end;
$$;

create or replace function public.cplayer_snapshot_playlist(
    p_row public.cplayer_playlists,
    p_reason text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
    if p_row.purged_at is not null then
        return;
    end if;
    if exists (
        select 1 from public.cplayer_playlist_versions
        where user_id = p_row.user_id
          and playlist_id = p_row.playlist_id
          and name = p_row.name
          and songs = p_row.songs
    ) then
        return;
    end if;
    insert into public.cplayer_playlist_versions (
        user_id, playlist_id, snapshot_id, name, songs, reason, created_at
    ) values (
        p_row.user_id,
        p_row.playlist_id,
        'server-' || p_row.version::text,
        p_row.name,
        p_row.songs,
        case when p_reason in ('edit', 'delete', 'restore', 'remote') then p_reason else 'edit' end,
        p_row.updated_at
    ) on conflict (user_id, playlist_id, snapshot_id) do nothing;
end;
$$;

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
        if (select count(*) from public.cplayer_playlists
            where user_id = v_user_id and purged_at is null) >= 500 then
            raise exception using errcode = '22023', message = 'playlist_limit_reached';
        end if;
        begin
            insert into public.cplayer_playlists (
                user_id, playlist_id, name, songs, version, updated_at, deleted_at, purged_at
            ) values (
                v_user_id, p_playlist_id, btrim(p_name), p_songs, 1,
                timezone('utc', now()), null, null
            ) returning * into v_row;
        exception
            when unique_violation then
                raise exception using errcode = 'P0001', message = 'cplayer_playlist_conflict';
        end;
    else
        select * into v_row
        from public.cplayer_playlists
        where user_id = v_user_id and playlist_id = p_playlist_id
        for update;
        if not found or v_row.version <> p_expected_version or v_row.purged_at is not null then
            raise exception using errcode = 'P0001', message = 'cplayer_playlist_conflict';
        end if;
        perform public.cplayer_snapshot_playlist(v_row, 'edit');
        update public.cplayer_playlists
        set name = btrim(p_name),
            songs = p_songs,
            version = version + 1,
            updated_at = timezone('utc', now()),
            deleted_at = null,
            purged_at = null
        where user_id = v_user_id and playlist_id = p_playlist_id
        returning * into v_row;
    end if;

    perform public.cplayer_prune_playlist_versions(v_user_id, p_playlist_id);
    return next v_row;
end;
$$;

create or replace function public.sync_cplayer_playlist_v2(
    p_playlist_id text,
    p_name text,
    p_songs jsonb,
    p_expected_version bigint,
    p_history jsonb
)
returns setof public.cplayer_playlists
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
    perform public.cplayer_ingest_playlist_versions(v_user_id, p_playlist_id, p_history);
    return query select * from public.sync_cplayer_playlist(
        p_playlist_id, p_name, p_songs, p_expected_version
    );
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

    select * into v_row
    from public.cplayer_playlists
    where user_id = v_user_id and playlist_id = p_playlist_id
    for update;
    if not found or v_row.version <> p_expected_version or v_row.purged_at is not null then
        raise exception using errcode = 'P0001', message = 'cplayer_playlist_conflict';
    end if;
    perform public.cplayer_snapshot_playlist(v_row, 'delete');
    update public.cplayer_playlists
    set version = version + 1,
        updated_at = timezone('utc', now()),
        deleted_at = timezone('utc', now())
    where user_id = v_user_id and playlist_id = p_playlist_id
    returning * into v_row;
    perform public.cplayer_prune_playlist_versions(v_user_id, p_playlist_id);
    return next v_row;
end;
$$;

create or replace function public.delete_cplayer_playlist_v2(
    p_playlist_id text,
    p_name text,
    p_songs jsonb,
    p_expected_version bigint,
    p_history jsonb
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
        or p_name is null or char_length(btrim(p_name)) not between 1 and 100
        or p_songs is null or jsonb_typeof(p_songs) <> 'array'
        or jsonb_array_length(p_songs) > 10000
        or octet_length(p_songs::text) > 5242880
        or p_expected_version is null or p_expected_version < 0 then
        raise exception using errcode = '22023', message = 'invalid_delete_request';
    end if;

    perform public.cplayer_ingest_playlist_versions(v_user_id, p_playlist_id, p_history);
    select * into v_row
    from public.cplayer_playlists
    where user_id = v_user_id and playlist_id = p_playlist_id
    for update;
    if not found then
        perform pg_advisory_xact_lock(hashtext(v_user_id::text));
        if (select count(*) from public.cplayer_playlists
            where user_id = v_user_id and purged_at is null) >= 500 then
            raise exception using errcode = '22023', message = 'playlist_limit_reached';
        end if;
        begin
            insert into public.cplayer_playlists (
                user_id, playlist_id, name, songs, version, updated_at, deleted_at, purged_at
            ) values (
                v_user_id, p_playlist_id, btrim(p_name), p_songs, 1,
                timezone('utc', now()), timezone('utc', now()), null
            ) returning * into v_row;
        exception
            when unique_violation then
                raise exception using errcode = 'P0001', message = 'cplayer_playlist_conflict';
        end;
        perform public.cplayer_prune_playlist_versions(v_user_id, p_playlist_id);
        return next v_row;
        return;
    end if;
    if v_row.version <> p_expected_version or v_row.purged_at is not null then
        raise exception using errcode = 'P0001', message = 'cplayer_playlist_conflict';
    end if;
    perform public.cplayer_snapshot_playlist(v_row, 'delete');
    update public.cplayer_playlists
    set name = btrim(p_name),
        songs = p_songs,
        version = version + 1,
        updated_at = timezone('utc', now()),
        deleted_at = timezone('utc', now())
    where user_id = v_user_id and playlist_id = p_playlist_id
    returning * into v_row;
    perform public.cplayer_prune_playlist_versions(v_user_id, p_playlist_id);
    return next v_row;
end;
$$;

create or replace function public.purge_cplayer_playlist(
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
        raise exception using errcode = '22023', message = 'invalid_purge_request';
    end if;

    select * into v_row
    from public.cplayer_playlists
    where user_id = v_user_id and playlist_id = p_playlist_id
    for update;
    if not found or v_row.version <> p_expected_version or v_row.purged_at is not null then
        raise exception using errcode = 'P0001', message = 'cplayer_playlist_conflict';
    end if;

    delete from public.cplayer_playlist_versions
    where user_id = v_user_id and playlist_id = p_playlist_id;
    update public.cplayer_playlists
    set name = '已永久删除',
        songs = '[]'::jsonb,
        version = version + 1,
        updated_at = timezone('utc', now()),
        deleted_at = coalesce(deleted_at, timezone('utc', now())),
        purged_at = timezone('utc', now())
    where user_id = v_user_id and playlist_id = p_playlist_id
    returning * into v_row;
    return next v_row;
end;
$$;

create or replace function public.cleanup_cplayer_playlist_data()
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
    v_user_id uuid := auth.uid();
    v_purged integer := 0;
begin
    if v_user_id is null then
        raise exception using errcode = '42501', message = 'authentication_required';
    end if;

    with expired as (
        update public.cplayer_playlists
        set name = '已永久删除',
            songs = '[]'::jsonb,
            version = version + 1,
            updated_at = timezone('utc', now()),
            purged_at = timezone('utc', now())
        where user_id = v_user_id
          and deleted_at is not null
          and purged_at is null
          and deleted_at <= timezone('utc', now()) - interval '30 days'
        returning playlist_id
    ), removed_history as (
        delete from public.cplayer_playlist_versions history
        using expired
        where history.user_id = v_user_id
          and history.playlist_id = expired.playlist_id
    )
    select count(*) into v_purged from expired;

    perform public.cplayer_prune_playlist_versions(v_user_id, null);
    return v_purged;
end;
$$;

revoke all on function public.cplayer_prune_playlist_versions(uuid, text) from public, anon, authenticated;
revoke all on function public.cplayer_ingest_playlist_versions(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.cplayer_snapshot_playlist(public.cplayer_playlists, text) from public, anon, authenticated;
revoke all on function public.sync_cplayer_playlist(text, text, jsonb, bigint) from public, anon;
revoke all on function public.sync_cplayer_playlist_v2(text, text, jsonb, bigint, jsonb) from public, anon;
revoke all on function public.delete_cplayer_playlist(text, bigint) from public, anon;
revoke all on function public.delete_cplayer_playlist_v2(text, text, jsonb, bigint, jsonb) from public, anon;
revoke all on function public.purge_cplayer_playlist(text, bigint) from public, anon;
revoke all on function public.cleanup_cplayer_playlist_data() from public, anon;

grant execute on function public.sync_cplayer_playlist(text, text, jsonb, bigint) to authenticated;
grant execute on function public.sync_cplayer_playlist_v2(text, text, jsonb, bigint, jsonb) to authenticated;
grant execute on function public.delete_cplayer_playlist(text, bigint) to authenticated;
grant execute on function public.delete_cplayer_playlist_v2(text, text, jsonb, bigint, jsonb) to authenticated;
grant execute on function public.purge_cplayer_playlist(text, bigint) to authenticated;
grant execute on function public.cleanup_cplayer_playlist_data() to authenticated;

commit;
