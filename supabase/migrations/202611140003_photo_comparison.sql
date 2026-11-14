-- Apply once AFTER approval, after 001 and 002. Existing tables/RLS are unchanged.
-- Uses the SAME ai-usage user lock and attempted_at counter as entry analysis.
begin;
create function public.begin_photo_comparison(p_user_id uuid, p_photo_id uuid, p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  owner_id uuid;
  photo_stage text;
  paired_id uuid;
  current_row public.comparisons;
  ts timestamptz := clock_timestamp();
begin
  perform pg_advisory_xact_lock(hashtextextended('photo-comparison:' || p_photo_id::text, 0));
  select h.user_id, p.stage, p.paired_entry_photo_id into owner_id, photo_stage, paired_id from public.photos p
    join public.houses h on h.house_id = p.house_id where p.photo_id = p_photo_id;
  if owner_id is null then return jsonb_build_object('action','not_found'); end if;
  if owner_id <> p_user_id then return jsonb_build_object('action','forbidden'); end if;
  if photo_stage <> 'exit' then return jsonb_build_object('action','invalid_stage'); end if;
  if not exists(select 1 from public.photos p join public.photos e on e.photo_id=p.paired_entry_photo_id
    where p.photo_id=p_photo_id and e.stage='entry' and e.house_id=p.house_id and e.location=p.location) then
    return jsonb_build_object('action','invalid_pair');
  end if;
  select * into current_row from public.comparisons where exit_photo_id = p_photo_id for update;
  if current_row.status = 'completed' then
    return jsonb_build_object('action','completed','analysis',to_jsonb(current_row));
  end if;
  if current_row.status = 'analyzing' and current_row.started_at > ts - interval '3 minutes' then
    return jsonb_build_object('action','busy');
  end if;
  if current_row.active_request_id is not null then
    update public.ai_request_logs set status='failed', error_code='AI_STALE', completed_at=ts
      where request_id=current_row.active_request_id and status in ('pending','analyzing');
  end if;
  insert into public.ai_request_logs(request_id,user_id,task_type,resource_id,status)
    values(p_request_id,p_user_id,'photo_comparison',p_photo_id,'pending');
  insert into public.comparisons(exit_photo_id,entry_photo_id,status,started_at,active_request_id)
    values(p_photo_id,paired_id,'analyzing',ts,p_request_id)
    on conflict(exit_photo_id) do update set status='analyzing', started_at=ts,
      active_request_id=p_request_id, overall_result=null, changes='[]'::jsonb,
      error_code=null, model_name=null;
  return jsonb_build_object('action','acquired');
end;
$$;

create function public.reserve_photo_comparison_attempt(p_user_id uuid, p_photo_id uuid,
  p_active_request_id uuid, p_attempt_id uuid, p_limit integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  current_row public.comparisons;
  ts timestamptz;
  day_start timestamptz;
  used bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended('photo-comparison:' || p_photo_id::text, 0));
  if not exists(select 1 from public.photos p join public.houses h on h.house_id=p.house_id
    where p.photo_id=p_photo_id and p.stage='exit' and h.user_id=p_user_id
    and exists(select 1 from public.photos e where e.photo_id=p.paired_entry_photo_id
      and e.stage='entry' and e.house_id=p.house_id and e.location=p.location)) then
    return jsonb_build_object('action','forbidden');
  end if;
  select * into current_row from public.comparisons where exit_photo_id=p_photo_id for update;
  if current_row.status is distinct from 'analyzing'
    or current_row.active_request_id is distinct from p_active_request_id then
    return jsonb_build_object('action','superseded');
  end if;
  -- Same lock namespace must be used by future AI tasks for a shared daily quota.
  perform pg_advisory_xact_lock(hashtextextended('ai-usage:' || p_user_id::text, 0));
  ts := clock_timestamp();
  if current_row.started_at <= ts - interval '3 minutes' then
    return jsonb_build_object('action','superseded');
  end if;
  if p_attempt_id = p_active_request_id and exists(select 1 from public.ai_request_logs
    where request_id=p_attempt_id and attempted_at is not null and status='analyzing') then
    return jsonb_build_object('action','reserved','request_id',p_attempt_id);
  end if;
  day_start := date_trunc('day', ts at time zone 'Asia/Seoul') at time zone 'Asia/Seoul';
  select count(*) into used from public.ai_request_logs where user_id=p_user_id
    and attempted_at >= day_start and attempted_at < day_start + interval '24 hours';
  if used >= least(greatest(coalesce(p_limit,30),1),30) then
    return jsonb_build_object('action','limit');
  end if;
  if p_attempt_id = p_active_request_id then
    update public.ai_request_logs set status='analyzing', attempted_at=ts, error_code=null
      where request_id=p_attempt_id and user_id=p_user_id and status='pending';
    if not found then return jsonb_build_object('action','superseded'); end if;
  else
    insert into public.ai_request_logs(request_id,user_id,task_type,resource_id,status,attempted_at)
      values(p_attempt_id,p_user_id,'photo_comparison',p_photo_id,'analyzing',ts);
  end if;
  update public.comparisons set active_request_id=p_attempt_id where exit_photo_id=p_photo_id;
  return jsonb_build_object('action','reserved','request_id',p_attempt_id);
end;
$$;

create function public.finish_photo_comparison_attempt(p_user_id uuid, p_photo_id uuid,
  p_request_id uuid, p_result jsonb, p_error_code text, p_final boolean, p_model text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare current_row public.comparisons;
begin
  perform pg_advisory_xact_lock(hashtextextended('photo-comparison:' || p_photo_id::text, 0));
  if not exists(select 1 from public.photos p join public.houses h on h.house_id=p.house_id
    where p.photo_id=p_photo_id and p.stage='exit' and h.user_id=p_user_id
    and exists(select 1 from public.photos e where e.photo_id=p.paired_entry_photo_id
      and e.stage='entry' and e.house_id=p.house_id and e.location=p.location)) then
    return jsonb_build_object('action','forbidden');
  end if;
  select * into current_row from public.comparisons where exit_photo_id=p_photo_id for update;
  if current_row.status is distinct from 'analyzing'
    or current_row.active_request_id is distinct from p_request_id then
    return jsonb_build_object('action','superseded');
  end if;
  if p_result is not null then
    if not exists(select 1 from public.ai_request_logs where request_id=p_request_id and attempted_at is not null and status='analyzing') then
      raise exception 'Completion requires a reserved attempt' using errcode='23514';
    end if;
    if not p_final or p_error_code is not null
      or coalesce(p_result->>'overall_result','') not in ('change_suspected','needs_review','no_visible_change')
      or jsonb_typeof(p_result->'changes') is distinct from 'array' then
      raise exception 'Invalid analysis result' using errcode='23514';
    end if;
  elsif p_error_code is null then
    raise exception 'Failure requires an error code' using errcode='23514';
  end if;
  update public.ai_request_logs set status=case when p_result is null then 'failed' else 'completed' end,
    error_code=p_error_code, completed_at=clock_timestamp() where request_id=p_request_id and status in ('pending','analyzing');
  if p_final then
    update public.comparisons set status=case when p_result is null then 'failed' else 'completed' end,
      overall_result=p_result->>'overall_result', changes=coalesce(p_result->'changes','[]'::jsonb),
      error_code=p_error_code, model_name=p_model where exit_photo_id=p_photo_id returning * into current_row;
  end if;
  return jsonb_build_object('action','saved','analysis',to_jsonb(current_row));
end;
$$;

revoke all on function public.begin_photo_comparison(uuid,uuid,uuid),
  public.reserve_photo_comparison_attempt(uuid,uuid,uuid,uuid,integer),
  public.finish_photo_comparison_attempt(uuid,uuid,uuid,jsonb,text,boolean,text) from public, anon, authenticated;
grant execute on function public.begin_photo_comparison(uuid,uuid,uuid),
  public.reserve_photo_comparison_attempt(uuid,uuid,uuid,uuid,integer),
  public.finish_photo_comparison_attempt(uuid,uuid,uuid,jsonb,text,boolean,text) to service_role;
commit;
