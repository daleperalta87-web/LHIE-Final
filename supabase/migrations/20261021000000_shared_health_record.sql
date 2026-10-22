-- Shared Health Record (SHR) schema.
-- Plain Postgres, written in Supabase migration layout so it also works with `supabase db push`.

-- (no extensions required)

-- ---------------------------------------------------------------------------
-- Registries (stand-ins for PhilSys, NHFR, NHWR)
-- ---------------------------------------------------------------------------
create table if not exists registry_patients (
  philsys_id   text primary key,
  family_name  text not null,
  given_name   text not null,
  gender       text not null check (gender in ('male','female','other','unknown')),
  birth_date   date not null,
  active       boolean not null default true
);

create table if not exists registry_facilities (
  nhfr_code   text primary key,
  name        text not null,
  fac_type    text not null,
  active      boolean not null default true
);

create table if not exists registry_health_workers (
  nhwr_id       text primary key,
  family_name   text not null,
  given_name    text not null,
  role          text not null,
  nhfr_code     text not null references registry_facilities(nhfr_code),
  active        boolean not null default true
);

-- ---------------------------------------------------------------------------
-- EMR clients (API Manager credentials)
-- ---------------------------------------------------------------------------
create table if not exists emr_clients (
  emr_id      text primary key,
  name        text not null,
  nhfr_code   text not null references registry_facilities(nhfr_code),
  api_key     text not null unique default md5(random()::text || clock_timestamp()::text)
);

-- ---------------------------------------------------------------------------
-- SHR core: FHIR resources stored as jsonb
-- ---------------------------------------------------------------------------
create table if not exists fhir_resources (
  id              uuid primary key default gen_random_uuid(),
  resource_type   text not null,
  fhir_id         text not null,
  version_id      int  not null default 1,
  patient_philsys text,
  source_emr      text references emr_clients(emr_id),
  resource        jsonb not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (resource_type, fhir_id),
  check (resource ->> 'resourceType' = resource_type)
);
create index if not exists fhir_resources_patient_idx on fhir_resources (patient_philsys, resource_type);
create index if not exists fhir_resources_gin_idx on fhir_resources using gin (resource jsonb_path_ops);

-- Every prior version is kept (FHIR history).
create table if not exists fhir_resource_history (
  id            bigint generated always as identity primary key,
  resource_type text not null,
  fhir_id       text not null,
  version_id    int  not null,
  resource      jsonb not null,
  source_emr    text,
  recorded_at   timestamptz not null default now()
);
create index if not exists fhir_history_lookup_idx on fhir_resource_history (resource_type, fhir_id, version_id);

-- ---------------------------------------------------------------------------
-- Referrals and back-referrals
-- ---------------------------------------------------------------------------
create table if not exists referrals (
  id                 uuid primary key default gen_random_uuid(),
  direction          text not null check (direction in ('referral','back_referral')),
  status             text not null default 'sent' check (status in ('sent','received','completed','rejected')),
  from_emr           text not null references emr_clients(emr_id),
  to_emr             text not null references emr_clients(emr_id),
  patient_philsys    text not null references registry_patients(philsys_id),
  service_request_id text,                       -- FHIR ServiceRequest id this thread is about
  parent_referral_id uuid references referrals(id),
  reason             text,
  bundle             jsonb not null,             -- the FHIR transaction Bundle as received
  created_at         timestamptz not null default now(),
  check (from_emr <> to_emr)
);
create index if not exists referrals_to_idx on referrals (to_emr, status, created_at desc);
create index if not exists referrals_patient_idx on referrals (patient_philsys);

-- ---------------------------------------------------------------------------
-- Audit trail
-- ---------------------------------------------------------------------------
create table if not exists audit_log (
  id        bigint generated always as identity primary key,
  ts        timestamptz not null default now(),
  emr_id    text,
  action    text not null,
  outcome   text not null check (outcome in ('ok','rejected','error')),
  detail    jsonb not null default '{}'::jsonb
);
create index if not exists audit_log_ts_idx on audit_log (ts desc);

-- ---------------------------------------------------------------------------
-- Security: RLS on everything. The API server connects as the table owner
-- (bypasses RLS); anon/authenticated roles on Supabase get no access.
-- ---------------------------------------------------------------------------
alter table registry_patients       enable row level security;
alter table registry_facilities     enable row level security;
alter table registry_health_workers enable row level security;
alter table emr_clients             enable row level security;
alter table fhir_resources          enable row level security;
alter table fhir_resource_history   enable row level security;
alter table referrals               enable row level security;
alter table audit_log               enable row level security;

-- ---------------------------------------------------------------------------
-- Ingest function: stores a FHIR transaction Bundle atomically
--   p = { emr_id, direction, to_emr, patient_philsys, service_request_id,
--         parent_referral_id, reason, bundle }
-- ---------------------------------------------------------------------------
create or replace function shr_ingest(p jsonb) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  entry      jsonb;
  res        jsonb;
  rtype      text;
  rid        text;
  existing   fhir_resources%rowtype;
  new_ver    int;
  stored     int := 0;
  ref_row    referrals%rowtype;
begin
  for entry in select * from jsonb_array_elements(p->'bundle'->'entry') loop
    res   := entry->'resource';
    rtype := res->>'resourceType';
    rid   := res->>'id';

    select * into existing from fhir_resources
     where resource_type = rtype and fhir_id = rid for update;

    if found and (existing.resource - 'meta') = (res - 'meta') then
      continue;  -- identical content: no new version
    end if;

    if found then
      new_ver := existing.version_id + 1;
      insert into fhir_resource_history (resource_type, fhir_id, version_id, resource, source_emr)
        values (existing.resource_type, existing.fhir_id, existing.version_id, existing.resource, existing.source_emr);
      update fhir_resources
         set resource = jsonb_set(res, '{meta}', coalesce(res->'meta','{}'::jsonb) || jsonb_build_object('versionId', new_ver::text, 'lastUpdated', now())),
             version_id = new_ver, updated_at = now(), source_emr = p->>'emr_id'
       where id = existing.id;
    else
      insert into fhir_resources (resource_type, fhir_id, patient_philsys, source_emr, resource)
        values (rtype, rid,
                case when rtype in ('Organization','Practitioner') then null else p->>'patient_philsys' end,
                p->>'emr_id',
                jsonb_set(res, '{meta}', coalesce(res->'meta','{}'::jsonb) || jsonb_build_object('versionId','1','lastUpdated', now())));
    end if;
    stored := stored + 1;
  end loop;

  insert into referrals (direction, status, from_emr, to_emr, patient_philsys,
                         service_request_id, parent_referral_id, reason, bundle)
  values (p->>'direction',
          case when p->>'direction' = 'back_referral' then 'completed' else 'sent' end,
          p->>'emr_id', p->>'to_emr', p->>'patient_philsys',
          p->>'service_request_id', nullif(p->>'parent_referral_id','')::uuid,
          p->>'reason', p->'bundle')
  returning * into ref_row;

  -- A back-referral closes the originating referral
  if ref_row.parent_referral_id is not null then
    update referrals set status = 'completed' where id = ref_row.parent_referral_id;
  end if;

  insert into audit_log (emr_id, action, outcome, detail)
  values (p->>'emr_id', 'store_' || (p->>'direction'), 'ok',
          jsonb_build_object('referral_id', ref_row.id, 'resources_stored', stored,
                             'patient', p->>'patient_philsys', 'to', p->>'to_emr'));

  return jsonb_build_object('referral_id', ref_row.id, 'resources_stored', stored, 'status', ref_row.status);
end;
$$;
