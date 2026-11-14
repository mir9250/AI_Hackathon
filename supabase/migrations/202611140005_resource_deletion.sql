-- User review/approval required before applying. 001..004 remain unchanged.
begin;
alter table public.photos add column deleting boolean not null default false;

-- Serialize resource writes and deletion transitions on the existing house row.
-- A check in Python alone cannot stop an AI start or paired-photo insert racing deletion.
create function public.guard_resource_deletion() returns trigger
language plpgsql security definer set search_path='' as $$
declare hid uuid; blocked boolean; cid uuid; pid uuid;
begin
  if tg_table_name in ('photos','contracts') then hid:=new.house_id;
  elsif tg_table_name in ('contract_pages','contract_analyses') then
    cid:=new.contract_id; select house_id into hid from public.contracts where contract_id=cid;
  else
    if tg_table_name='comparisons' then pid:=new.exit_photo_id;
    else pid:=new.photo_id; end if;
    select house_id into hid from public.photos where photo_id=pid;
  end if;
  perform 1 from public.houses where house_id=hid for update;
  if tg_table_name='photos' then
    if tg_op='UPDATE' and old.deleting then
      raise exception 'Resource deletion in progress' using errcode='55000';
    end if;
    if not new.deleting and new.paired_entry_photo_id is not null and exists(select 1 from public.photos
      where photo_id=new.paired_entry_photo_id and deleting) then
      raise exception 'Resource deletion in progress' using errcode='55000';
    end if;
  elsif tg_table_name='contracts' then
    if tg_op='UPDATE' and old.upload_status='deleting' then
      raise exception 'Resource deletion in progress' using errcode='55000';
    end if;
  elsif tg_table_name in ('contract_pages','contract_analyses') then
    select upload_status='deleting' into blocked from public.contracts where contract_id=cid;
    if blocked is distinct from false then
      raise exception 'Resource deletion in progress' using errcode='55000';
    end if;
  else
    select deleting into blocked from public.photos where photo_id=pid;
    if tg_table_name='comparisons' then
      if exists(select 1 from public.photos where photo_id=new.entry_photo_id and deleting) then blocked:=true; end if;
    end if;
    if blocked is distinct from false then
      raise exception 'Resource deletion in progress' using errcode='55000';
    end if;
  end if;
  return new;
end;
$$;
create trigger deletion_guard before insert or update on public.photos for each row execute function public.guard_resource_deletion();
create trigger deletion_guard before insert or update on public.contracts for each row execute function public.guard_resource_deletion();
create trigger deletion_guard before insert or update on public.contract_pages for each row execute function public.guard_resource_deletion();
create trigger deletion_guard before insert or update on public.analyses for each row execute function public.guard_resource_deletion();
create trigger deletion_guard before insert or update on public.comparisons for each row execute function public.guard_resource_deletion();
create trigger deletion_guard before insert or update on public.contract_analyses for each row execute function public.guard_resource_deletion();

create function public.begin_resource_deletion(p_user_id uuid,p_kind text,p_id uuid,p_expected_exit uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare hid uuid; owner_id uuid; target public.photos; paired uuid; ids uuid[]; manifest jsonb;
begin
  if p_kind='photo' then select house_id into hid from public.photos where photo_id=p_id;
  elsif p_kind='contract' then select house_id into hid from public.contracts where contract_id=p_id;
  else raise exception 'Invalid resource type'; end if;
  if hid is null then return jsonb_build_object('action','gone'); end if;
  select user_id into owner_id from public.houses where house_id=hid for update;
  if owner_id is distinct from p_user_id then return jsonb_build_object('action','forbidden'); end if;
  if p_kind='photo' then
    select * into target from public.photos where photo_id=p_id;
    if not found then return jsonb_build_object('action','gone'); end if;
    if target.stage='entry' then
      select photo_id into paired from public.photos where paired_entry_photo_id=p_id;
      if not target.deleting and paired is distinct from p_expected_exit then
        return jsonb_build_object('action','confirmation_changed');
      end if;
    elsif exists(select 1 from public.photos where photo_id=target.paired_entry_photo_id and deleting) then
      return jsonb_build_object('action','parent_deleting');
    end if;
    ids:=array_remove(array[p_id,paired],null);
    if exists(select 1 from public.analyses where photo_id=any(ids) and status='analyzing'
        and (started_at is null or started_at>clock_timestamp()-interval '3 minutes'))
      or exists(select 1 from public.comparisons where (exit_photo_id=any(ids) or entry_photo_id=any(ids)) and status='analyzing'
        and (started_at is null or started_at>clock_timestamp()-interval '3 minutes')) then
      return jsonb_build_object('action','busy');
    end if;
    -- HTTP AI requests time out before 3 minutes. Expire abandoned work without
    -- another paid call, before freezing the resource. Late finishes fail status guards.
    update public.ai_request_logs set status='failed',error_code='AI_STALE',completed_at=clock_timestamp()
      where user_id=p_user_id and resource_id=any(ids) and task_type in ('photo_analysis','photo_comparison')
        and status in ('pending','analyzing');
    update public.analyses set status='failed',error_code='AI_STALE'
      where photo_id=any(ids) and status='analyzing';
    update public.comparisons set status='failed',error_code='AI_STALE'
      where (exit_photo_id=any(ids) or entry_photo_id=any(ids)) and status='analyzing';
    update public.photos set deleting=true where photo_id=any(ids) and not deleting;
    select jsonb_agg(to_jsonb(p)) into manifest from public.photos p where photo_id=any(ids);
    return jsonb_build_object('action','prepared','house_id',hid,'photos',manifest);
  end if;
  if not exists(select 1 from public.contracts where contract_id=p_id) then return jsonb_build_object('action','gone'); end if;
  if exists(select 1 from public.contract_analyses where contract_id=p_id and status='analyzing'
    and (started_at is null or started_at>clock_timestamp()-interval '3 minutes')) then
    return jsonb_build_object('action','busy');
  end if;
  update public.ai_request_logs set status='failed',error_code='AI_STALE',completed_at=clock_timestamp()
    where user_id=p_user_id and resource_id=p_id and task_type='contract_analysis' and status in ('pending','analyzing');
  update public.contract_analyses set status='failed',error_code='AI_STALE' where contract_id=p_id and status='analyzing';
  update public.contracts set upload_status='deleting' where contract_id=p_id and upload_status<>'deleting';
  return jsonb_build_object('action','prepared','house_id',hid,
    'contract',(select to_jsonb(c) from public.contracts c where contract_id=p_id),
    'pages',coalesce((select jsonb_agg(to_jsonb(p)) from public.contract_pages p where contract_id=p_id),'[]'::jsonb));
end;
$$;

create function public.finish_resource_deletion(p_user_id uuid,p_kind text,p_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare hid uuid; owner_id uuid; target public.photos;
begin
  if p_kind='photo' then select house_id into hid from public.photos where photo_id=p_id;
  elsif p_kind='contract' then select house_id into hid from public.contracts where contract_id=p_id;
  else raise exception 'Invalid resource type'; end if;
  if hid is null then return jsonb_build_object('action','deleted'); end if;
  select user_id into owner_id from public.houses where house_id=hid for update;
  if owner_id is distinct from p_user_id then return jsonb_build_object('action','forbidden'); end if;
  if p_kind='photo' then
    select * into target from public.photos where photo_id=p_id;
    if not found then return jsonb_build_object('action','deleted'); end if;
    if not target.deleting then return jsonb_build_object('action','not_prepared'); end if;
    -- Exit FK and comparison.entry_photo_id prohibit deleting an entry first.
    if target.stage='entry' then
      if exists(select 1 from public.photos where paired_entry_photo_id=p_id and not deleting) then
        return jsonb_build_object('action','not_prepared');
      end if;
      delete from public.photos where paired_entry_photo_id=p_id;
    end if;
    delete from public.photos where photo_id=p_id;
  else
    if exists(select 1 from public.contracts where contract_id=p_id and upload_status<>'deleting') then
      return jsonb_build_object('action','not_prepared');
    end if;
    delete from public.contracts where contract_id=p_id;
  end if;
  -- ai_request_logs deliberately retained: attempted_at still counts towards KST cap.
  -- resource_id is an opaque UUID, not a FK; logs contain no document/body/filename.
  return jsonb_build_object('action','deleted');
end;
$$;
revoke all on function public.guard_resource_deletion(),public.begin_resource_deletion(uuid,text,uuid,uuid),
 public.finish_resource_deletion(uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.begin_resource_deletion(uuid,text,uuid,uuid),public.finish_resource_deletion(uuid,text,uuid) to service_role;
commit;
