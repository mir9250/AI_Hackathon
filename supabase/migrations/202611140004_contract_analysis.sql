-- Apply once AFTER user approval, after 001/002/003. No changes to prior migrations.
-- Same ai-usage user lock and attempted_at counter for all three AI tasks.
begin;
create function public.begin_contract_analysis(p_user_id uuid, p_contract_id uuid, p_request_id uuid, p_consent boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  owner_id uuid;
  contract_status text;
  current_row public.contract_analyses;
  ts timestamptz := clock_timestamp();
begin
  perform pg_advisory_xact_lock(hashtextextended('contract-analysis:' || p_contract_id::text, 0));
  if p_consent is distinct from true then return jsonb_build_object('action','consent_required'); end if;
  select h.user_id, c.upload_status into owner_id, contract_status from public.contracts c
    join public.houses h on h.house_id=c.house_id where c.contract_id=p_contract_id;
  if owner_id is null then return jsonb_build_object('action','not_found'); end if;
  if owner_id <> p_user_id then return jsonb_build_object('action','forbidden'); end if;
  if contract_status <> 'ready' then return jsonb_build_object('action','not_ready'); end if;
  select * into current_row from public.contract_analyses where contract_id = p_contract_id for update;
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
    values(p_request_id,p_user_id,'contract_analysis',p_contract_id,'pending');
  insert into public.contract_analyses(contract_id,status,started_at,active_request_id,consent_at)
    values(p_contract_id,'analyzing',ts,p_request_id,ts)
    on conflict(contract_id) do update set status='analyzing', started_at=ts,
      active_request_id=p_request_id, consent_at=ts, document_quality=null, summary=null,
      findings='[]'::jsonb, checklist='[]'::jsonb, warnings='[]'::jsonb,
      error_code=null, model_name=null;
  return jsonb_build_object('action','acquired');
end;
$$;

create function public.reserve_contract_ai_attempt(p_user_id uuid, p_contract_id uuid,
  p_active_request_id uuid, p_attempt_id uuid, p_limit integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  current_row public.contract_analyses;
  ts timestamptz;
  day_start timestamptz;
  used bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended('contract-analysis:' || p_contract_id::text, 0));
  if not exists(select 1 from public.contracts c join public.houses h on h.house_id=c.house_id
    where c.contract_id=p_contract_id and c.upload_status='ready' and h.user_id=p_user_id) then
    return jsonb_build_object('action','forbidden');
  end if;
  select * into current_row from public.contract_analyses where contract_id=p_contract_id for update;
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
      values(p_attempt_id,p_user_id,'contract_analysis',p_contract_id,'analyzing',ts);
  end if;
  update public.contract_analyses set active_request_id=p_attempt_id where contract_id=p_contract_id;
  return jsonb_build_object('action','reserved','request_id',p_attempt_id);
end;
$$;

create function public.finish_contract_ai_attempt(p_user_id uuid, p_contract_id uuid,
  p_request_id uuid, p_result jsonb, p_error_code text, p_final boolean, p_model text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare current_row public.contract_analyses;
begin
  perform pg_advisory_xact_lock(hashtextextended('contract-analysis:' || p_contract_id::text, 0));
  if not exists(select 1 from public.contracts c join public.houses h on h.house_id=c.house_id
    where c.contract_id=p_contract_id and c.upload_status='ready' and h.user_id=p_user_id) then
    return jsonb_build_object('action','forbidden');
  end if;
  select * into current_row from public.contract_analyses where contract_id=p_contract_id for update;
  if current_row.status is distinct from 'analyzing'
    or current_row.active_request_id is distinct from p_request_id then
    return jsonb_build_object('action','superseded');
  end if;
  if p_result is not null then
    if not exists(select 1 from public.ai_request_logs where request_id=p_request_id and attempted_at is not null and status='analyzing') then
      raise exception 'Completion requires a reserved attempt' using errcode='23514';
    end if;
    if not p_final
      or (p_result->>'document_quality'='unreadable' and p_error_code is distinct from 'AI_CONTRACT_UNREADABLE')
      or (p_result->>'document_quality'<>'unreadable' and p_error_code is not null)
      or coalesce(p_result->>'document_quality','') not in ('readable','partially_readable','unreadable')
      or jsonb_typeof(p_result->'summary') is distinct from 'object'
      or jsonb_typeof(p_result->'findings') is distinct from 'array'
      or jsonb_typeof(p_result->'checklist') is distinct from 'array'
      or jsonb_typeof(p_result->'warnings') is distinct from 'array' then
      raise exception 'Invalid analysis result' using errcode='23514';
    end if;
  elsif p_error_code is null then
    raise exception 'Failure requires an error code' using errcode='23514';
  end if;
  update public.ai_request_logs set status=case when p_result is null or p_result->>'document_quality'='unreadable' then 'failed' else 'completed' end,
    error_code=p_error_code, completed_at=clock_timestamp() where request_id=p_request_id and status in ('pending','analyzing');
  if p_final then
    update public.contract_analyses set status=case when p_result is null or p_result->>'document_quality'='unreadable' then 'failed' else 'completed' end,
      document_quality=p_result->>'document_quality', summary=p_result->'summary',
      findings=coalesce(p_result->'findings','[]'::jsonb), checklist=coalesce(p_result->'checklist','[]'::jsonb),
      warnings=coalesce(p_result->'warnings','[]'::jsonb),
      error_code=p_error_code, model_name=p_model where contract_id=p_contract_id returning * into current_row;
  end if;
  return jsonb_build_object('action','saved','analysis',to_jsonb(current_row));
end;
$$;

revoke all on function public.begin_contract_analysis(uuid,uuid,uuid,boolean),
  public.reserve_contract_ai_attempt(uuid,uuid,uuid,uuid,integer),
  public.finish_contract_ai_attempt(uuid,uuid,uuid,jsonb,text,boolean,text) from public, anon, authenticated;
grant execute on function public.begin_contract_analysis(uuid,uuid,uuid,boolean),
  public.reserve_contract_ai_attempt(uuid,uuid,uuid,uuid,integer),
  public.finish_contract_ai_attempt(uuid,uuid,uuid,jsonb,text,boolean,text) to service_role;
commit;
