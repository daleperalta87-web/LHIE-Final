'use strict';
// Shared Health Record server: API Manager + Orchestrator + FHIR read API + dashboard host.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const db = require('./src/db');
const { query, rows, audit } = db;
const fhir = require('./src/fhir');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1'; // localhost only by default
function parseAllowedOrigins(value) {
  const origins = value.split(',').map((origin) => origin.trim()).filter(Boolean);
  return new Set(origins.map((origin) => {
    let parsed;
    try { parsed = new URL(origin); } catch { throw new Error(`Invalid CORS origin: ${origin}`); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) {
      throw new Error(`CORS entries must be exact HTTP(S) origins without paths: ${origin}`);
    }
    return origin;
  }));
}
const ALLOWED_ORIGINS = parseAllowedOrigins(process.env.CORS_ALLOWED_ORIGINS || '');

// ---------------------------------------------------------------- helpers
const send = (res, status, body, type = 'application/json') => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const fhirSend = (res, status, body) => send(res, status, body, 'application/fhir+json');
function isCorsIntegrationPath(pathname) {
  return pathname === '/openapi.json' || pathname === '/api/health'
    || ['/api/patients/search', '/api/inbox', '/api/outbox', '/api/referrals'].includes(pathname)
    || /^\/api\/patients\/[0-9-]+\/record$/.test(pathname)
    || /^\/api\/referrals\/[0-9a-f-]{36}\/(receive|back-referral)$/.test(pathname);
}
function applyCors(req, res) {
  const origin = req.headers.origin;
  const pathname = new URL(req.url, 'http://localhost').pathname;
  res.setHeader('vary', 'Origin');
  if (origin && ALLOWED_ORIGINS.has(origin) && isCorsIntegrationPath(pathname)) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('access-control-allow-headers', 'Content-Type, X-API-Key');
    res.setHeader('access-control-max-age', '600');
  }
}
const readBody = (req) => new Promise((resolve, reject) => {
  let data = '';
  req.on('data', (c) => { data += c; if (data.length > 2_000_000) { reject(new Error('Body too large')); req.destroy(); } });
  req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(Object.assign(new Error('Invalid JSON body'), { status: 400 })); } });
});
const outcome = (status, severity, diagnostics) =>
  ({ resourceType: 'OperationOutcome', issue: [{ severity, code: status === 404 ? 'not-found' : 'processing', diagnostics }] });

// ---------------------------------------------------------------- registry lookups
const one = (table, key, val) =>
  query(`select to_jsonb(r) from ${table} r where ${key} = (:'p'::jsonb)->>'k';`, { k: val });
const getPatient = (id) => one('registry_patients', 'philsys_id', id);
const getFacility = (code) => one('registry_facilities', 'nhfr_code', code);
const getWorker = (id) => one('registry_health_workers', 'nhwr_id', id);
const getEmrById = (id) => one('emr_clients', 'emr_id', id);
const getEmrByKey = (key) => one('emr_clients', 'api_key', key);
const resourceExists = async (type, id) =>
  !!(await query(`select to_jsonb(1) from fhir_resources where resource_type=(:'p'::jsonb)->>'t' and fhir_id=(:'p'::jsonb)->>'i';`, { t: type, i: id }));

class Rejected extends Error {
  constructor(step, message, steps, status = 422) { super(message); this.step = step; this.steps = steps; this.status = status; }
}

// ---------------------------------------------------------------- orchestrator
function stepper() {
  const steps = [];
  return {
    steps,
    async run(name, fn) {
      try { const detail = await fn(); steps.push({ step: name, ok: true, detail: detail || undefined }); return detail; }
      catch (e) { steps.push({ step: name, ok: false, detail: e.message }); throw new Rejected(name, e.message, steps); }
    },
  };
}

async function handleReferral(emr, input) {
  const s = stepper();
  let patientRow, toEmr, toFac, fromFac, worker, built;

  await s.run('Validate Patient (PhilSys)', async () => {
    patientRow = await getPatient(input.patientPhilsysId);
    if (!patientRow) throw new Error(`PhilSys ID ${input.patientPhilsysId} not found`);
    if (!patientRow.active) throw new Error('Patient is not active in PhilSys');
    return `${patientRow.given_name} ${patientRow.family_name}`;
  });
  await s.run('Validate Facility (NHFR)', async () => {
    toEmr = await getEmrById(input.toEmr);
    if (!toEmr) throw new Error(`Unknown receiving EMR "${input.toEmr}"`);
    if (toEmr.emr_id === emr.emr_id) throw new Error('Cannot refer to your own facility');
    fromFac = await getFacility(emr.nhfr_code); toFac = await getFacility(toEmr.nhfr_code);
    if (!fromFac?.active || !toFac?.active) throw new Error('Facility inactive in NHFR');
    return `${fromFac.nhfr_code} -> ${toFac.nhfr_code}`;
  });
  await s.run('Validate Health Worker (NHWR)', async () => {
    worker = await getWorker(input.practitionerNhwr);
    if (!worker) throw new Error(`NHWR ID ${input.practitionerNhwr} not found`);
    if (!worker.active) throw new Error('Health worker inactive in NHWR');
    if (worker.nhfr_code !== emr.nhfr_code) throw new Error(`${worker.nhwr_id} is not registered at ${emr.nhfr_code}`);
    return `${worker.given_name} ${worker.family_name}`;
  });
  await s.run('Validate Patient Record (FHIR)', async () => {
    if (!input.reason || !String(input.reason).trim()) throw new Error('Referral reason is required');
    built = fhir.buildReferralBundle({ patientRow, fromFac, toFac, worker, input });
    const v = await fhir.validateBundle(built.bundle, resourceExists);
    if (!v.valid) throw new Error(v.errors.join('; '));
    return `${built.bundle.entry.length} resources valid`;
  });
  let stored;
  await s.run('Store Patient Record at Shared Health Record', async () => {
    stored = await query(`select shr_ingest(:'p'::jsonb);`, {
      emr_id: emr.emr_id, direction: 'referral', to_emr: toEmr.emr_id, patient_philsys: patientRow.philsys_id,
      service_request_id: built.serviceRequestId, reason: input.reason, bundle: built.bundle,
    });
    return `referral ${stored.referral_id}`;
  });
  return { ...stored, steps: s.steps };
}

async function handleBackReferral(emr, referralId, input) {
  const s = stepper();
  let ref, patientRow, toEmr, toFac, fromFac, worker, sr, task, built;

  await s.run('Validate Referral Thread', async () => {
    ref = await query(`select to_jsonb(r) - 'bundle' from referrals r where id::text = (:'p'::jsonb)->>'k';`, { k: referralId });
    if (!ref) throw new Error('Referral not found');
    if (ref.direction !== 'referral') throw new Error('Only an original referral can be answered');
    if (ref.to_emr !== emr.emr_id) throw new Error('This referral was not sent to your facility');
    if (ref.status === 'completed') throw new Error('Referral already completed');
    sr = await query(`select resource from fhir_resources where resource_type='ServiceRequest' and fhir_id=(:'p'::jsonb)->>'k';`, { k: ref.service_request_id });
    task = await query(`select resource from fhir_resources where resource_type='Task' and fhir_id=(:'p'::jsonb)->>'k';`, { k: fhir.ids.task(ref.service_request_id) });
    if (!sr || !task) throw new Error('Original ServiceRequest/Task missing from SHR');
    return `ServiceRequest/${ref.service_request_id}`;
  });
  await s.run('Validate Patient (PhilSys)', async () => {
    patientRow = await getPatient(ref.patient_philsys);
    if (!patientRow?.active) throw new Error('Patient not active in PhilSys');
    return `${patientRow.given_name} ${patientRow.family_name}`;
  });
  await s.run('Validate Facility (NHFR)', async () => {
    toEmr = await getEmrById(ref.from_emr);
    fromFac = await getFacility(emr.nhfr_code); toFac = await getFacility(toEmr.nhfr_code);
    if (!fromFac?.active || !toFac?.active) throw new Error('Facility inactive in NHFR');
    return `${fromFac.nhfr_code} -> ${toFac.nhfr_code}`;
  });
  await s.run('Validate Health Worker (NHWR)', async () => {
    worker = await getWorker(input.practitionerNhwr);
    if (!worker?.active) throw new Error(`NHWR ID ${input.practitionerNhwr} not found or inactive`);
    if (worker.nhfr_code !== emr.nhfr_code) throw new Error(`${worker.nhwr_id} is not registered at ${emr.nhfr_code}`);
    return `${worker.given_name} ${worker.family_name}`;
  });
  await s.run('Validate Patient Record (FHIR)', async () => {
    if (!input.findings || !String(input.findings).trim()) throw new Error('Findings / outcome summary is required');
    built = fhir.buildBackReferralBundle({ patientRow, fromFac, toFac, worker, input, serviceRequest: sr, task });
    const v = await fhir.validateBundle(built.bundle, resourceExists);
    if (!v.valid) throw new Error(v.errors.join('; '));
    return `${built.bundle.entry.length} resources valid`;
  });
  let stored;
  await s.run('Store Patient Record at Shared Health Record', async () => {
    stored = await query(`select shr_ingest(:'p'::jsonb);`, {
      emr_id: emr.emr_id, direction: 'back_referral', to_emr: toEmr.emr_id, patient_philsys: patientRow.philsys_id,
      service_request_id: ref.service_request_id, parent_referral_id: ref.id, reason: input.findings, bundle: built.bundle,
    });
    return `back-referral ${stored.referral_id}`;
  });
  return { ...stored, steps: s.steps };
}

// ---------------------------------------------------------------- queries for dashboard / FHIR
const referralList = (where = 'true') => `
  select r.id, r.direction, r.status, r.from_emr, r.to_emr, r.patient_philsys,
         p.given_name || ' ' || p.family_name as patient_name,
         r.reason, r.service_request_id, r.parent_referral_id, r.created_at,
         jsonb_array_length(r.bundle->'entry') as resources
  from referrals r join registry_patients p on p.philsys_id = r.patient_philsys
  where ${where} order by r.created_at desc limit 200`;

async function patientRecordBundle(philsys) {
  const patientResources = await query(`select coalesce(json_agg(resource order by resource->>'resourceType'), '[]'::json) from (
      select resource from fhir_resources where patient_philsys = (:'p'::jsonb)->>'k'
    ) x;`, { k: philsys });
  const references = new Map();
  const collect = (node) => {
    if (Array.isArray(node)) return node.forEach(collect);
    if (!node || typeof node !== 'object') return;
    if (typeof node.reference === 'string') {
      const match = node.reference.match(/^(Organization|Practitioner)\/([A-Za-z0-9\-.]+)$/);
      if (match) references.set(`${match[1]}/${match[2]}`, { resourceType: match[1], id: match[2] });
    }
    Object.values(node).forEach(collect);
  };
  patientResources.forEach(collect);

  const referencedResources = references.size
    ? await query(`select coalesce(json_agg(resource order by resource_type, fhir_id), '[]'::json)
        from fhir_resources
        where (resource_type, fhir_id) in (
          select item->>'resourceType', item->>'id'
          from jsonb_array_elements((:'p'::jsonb)->'references') item
        );`, { references: [...references.values()] })
    : [];
  const list = [...patientResources, ...referencedResources];
  return { resourceType: 'Bundle', type: 'searchset', total: list.length, entry: list.map((r) => ({ fullUrl: `${r.resourceType}/${r.id}`, resource: r })) };
}

// ---------------------------------------------------------------- router
const PUBLIC_DIR = path.join(__dirname, 'public');

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const q = Object.fromEntries(url.searchParams);
  const m = req.method;

  if (m === 'OPTIONS') {
    const origin = req.headers.origin;
    const requestedMethod = req.headers['access-control-request-method'];
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (!origin || !ALLOWED_ORIGINS.has(origin) || !isCorsIntegrationPath(pathname)) return send(res, 403, { error: 'Origin or API path not allowed' });
    if (requestedMethod && !['GET', 'POST'].includes(requestedMethod.toUpperCase())) {
      return send(res, 405, { error: 'CORS method not allowed' });
    }
    return send(res, 204, '');
  }

  if (m === 'GET' && p === '/openapi.json') {
    return send(res, 200, fs.readFileSync(path.join(__dirname, 'openapi.json')), 'application/vnd.oai.openapi+json;version=3.1.0');
  }
  if (m === 'GET' && p === '/api/health') {
    await query('select to_jsonb(true);');
    return send(res, 200, { status: 'ok', service: 'shared-health-record', fhirVersion: '4.0.1' });
  }

  // ---- static dashboard
  if (m === 'GET' && (p === '/' || p === '/index.html')) {
    return send(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, 'index.html')), 'text/html; charset=utf-8');
  }
  if (m === 'GET' && p === '/patient-prefill.js') {
    return send(res, 200, fs.readFileSync(path.join(__dirname, 'src', 'patient-prefill.js')), 'text/javascript; charset=utf-8');
  }

  // ---- FHIR read API (open on localhost; put auth in front before exposing)
  if (p === '/fhir/metadata' && m === 'GET') {
    return fhirSend(res, 200, {
      resourceType: 'CapabilityStatement', status: 'active', date: new Date().toISOString(), kind: 'instance',
      fhirVersion: '4.0.1', format: ['json'],
      rest: [{ mode: 'server', resource: ['Patient', 'Organization', 'Practitioner', 'Encounter', 'Condition', 'Observation', 'MedicationStatement', 'MedicationRequest', 'ServiceRequest', 'Task', 'Communication']
        .map((type) => ({ type, interaction: [{ code: 'read' }, { code: 'search-type' }, { code: 'vread' }] })) }],
    });
  }
  let mm;
  if (m === 'GET' && (mm = p.match(/^\/fhir\/([A-Za-z]+)$/))) {
    const list = await query(`select coalesce(json_agg(resource order by updated_at desc), '[]'::json) from (
        select resource, updated_at from fhir_resources
        where resource_type = (:'p'::jsonb)->>'t'
          and ((:'p'::jsonb)->>'patient' is null or patient_philsys = (:'p'::jsonb)->>'patient')
        limit least(coalesce(((:'p'::jsonb)->>'n')::int, 50), 500)) x;`,
      { t: mm[1], patient: q.patient ?? null, n: q._count ?? null });
    return fhirSend(res, 200, { resourceType: 'Bundle', type: 'searchset', total: list.length, entry: list.map((r) => ({ fullUrl: `${r.resourceType}/${r.id}`, resource: r })) });
  }
  if (m === 'GET' && (mm = p.match(/^\/fhir\/([A-Za-z]+)\/([A-Za-z0-9\-.]+)(\/_history)?$/))) {
    if (mm[3]) {
      const h = await query(`select coalesce(json_agg(resource order by v desc), '[]'::json) from (
          select resource, version_id v from fhir_resources where resource_type=(:'p'::jsonb)->>'t' and fhir_id=(:'p'::jsonb)->>'i'
          union all select resource, version_id from fhir_resource_history where resource_type=(:'p'::jsonb)->>'t' and fhir_id=(:'p'::jsonb)->>'i') x;`, { t: mm[1], i: mm[2] });
      if (!h.length) return fhirSend(res, 404, outcome(404, 'error', `${mm[1]}/${mm[2]} not found`));
      return fhirSend(res, 200, { resourceType: 'Bundle', type: 'history', total: h.length, entry: h.map((r) => ({ resource: r })) });
    }
    const r = await query(`select resource from fhir_resources where resource_type=(:'p'::jsonb)->>'t' and fhir_id=(:'p'::jsonb)->>'i';`, { t: mm[1], i: mm[2] });
    return r ? fhirSend(res, 200, r) : fhirSend(res, 404, outcome(404, 'error', `${mm[1]}/${mm[2]} not found`));
  }

  // ---- dashboard / admin (read-only, localhost)
  if (m === 'GET' && p === '/api/demo/config') {
    const [emrs, patients, facilities, workers] = await Promise.all([
      query(rows('select emr_id, name, nhfr_code, api_key from emr_clients order by emr_id')),
      query(rows('select philsys_id, given_name, family_name, gender, birth_date from registry_patients order by family_name')),
      query(rows('select nhfr_code, name, fac_type from registry_facilities order by nhfr_code')),
      query(rows('select nhwr_id, given_name, family_name, role, nhfr_code from registry_health_workers order by nhwr_id')),
    ]);
    return send(res, 200, { emrs, patients, facilities, workers });
  }
  if (m === 'GET' && p === '/api/shr/stats') {
    return send(res, 200, await query(`select jsonb_build_object(
      'resources', (select count(*) from fhir_resources),
      'versions',  (select count(*) from fhir_resource_history),
      'patients',  (select count(distinct patient_philsys) from fhir_resources where patient_philsys is not null),
      'byType',    (select coalesce(jsonb_object_agg(resource_type, c), '{}') from (select resource_type, count(*) c from fhir_resources group by 1) t),
      'referrals', (select coalesce(jsonb_object_agg(direction || ':' || status, c), '{}') from (select direction, status, count(*) c from referrals group by 1,2) t)
    );`));
  }
  if (m === 'GET' && p === '/api/shr/patients') {
    const search = (q.q || '').trim();
    const patients = await query(rows(`
      select f.patient_philsys as philsys_id,
             f.resource->'name'->0->'given'->>0 as given_name,
             f.resource->'name'->0->>'family' as family_name,
             f.resource->>'gender' as gender,
             f.resource->>'birthDate' as birth_date,
             coalesce((f.resource->>'active')::boolean, true) as active,
             f.updated_at,
             (select count(*) from fhir_resources r where r.patient_philsys = f.patient_philsys) as resources,
             (select count(*) from referrals r where r.patient_philsys = f.patient_philsys) as referrals
      from fhir_resources f
      where f.resource_type = 'Patient' and f.patient_philsys is not null
        and ((:'p'::jsonb)->>'q' is null
          or position(lower((:'p'::jsonb)->>'q') in lower(concat_ws(' ',
            f.patient_philsys, f.fhir_id,
            (select string_agg(concat_ws(' ', n->>'text',
              (select string_agg(given_name, ' ')
               from jsonb_array_elements_text(coalesce(n->'given', '[]'::jsonb)) given_names(given_name)),
              n->>'family'), ' ')
             from jsonb_array_elements(coalesce(f.resource->'name', '[]'::jsonb)) names(n))
          ))) > 0)
      order by family_name, given_name`), { q: search || null });
    return send(res, 200, patients);
  }
  if (m === 'GET' && (mm = p.match(/^\/api\/shr\/patients\/([0-9-]+)$/))) {
    const patient = await query(`select resource from fhir_resources where resource_type = 'Patient'
      and patient_philsys = (:'p'::jsonb)->>'k';`, { k: mm[1] });
    if (!patient) return send(res, 404, { error: 'Patient record not found in the Shared Health Record' });
    const [record, referrals] = await Promise.all([
      patientRecordBundle(mm[1]),
      query(rows(referralList(`r.patient_philsys = (:'p'::jsonb)->>'k'`)), { k: mm[1] }),
    ]);
    return send(res, 200, { patient, record, referrals });
  }
  if (m === 'GET' && p === '/api/shr/raw') {
    const out = await query(rows(`
      select id, resource_type, fhir_id, version_id, patient_philsys, source_emr, created_at, updated_at, resource
      from fhir_resources
      where ((:'p'::jsonb)->>'type' is null or resource_type = (:'p'::jsonb)->>'type')
        and ((:'p'::jsonb)->>'patient' is null or patient_philsys = (:'p'::jsonb)->>'patient')
        and ((:'p'::jsonb)->>'q' is null or resource::text ilike '%' || ((:'p'::jsonb)->>'q') || '%')
      order by updated_at desc
      limit least(coalesce(((:'p'::jsonb)->>'n')::int, 100), 500)`), { type: q.type || null, patient: q.patient || null, q: q.q || null, n: q.limit || null });
    return send(res, 200, out);
  }
  if (m === 'GET' && p === '/api/referrals') return send(res, 200, await query(rows(referralList())));
  if (m === 'GET' && (mm = p.match(/^\/api\/referrals\/([0-9a-f-]{36})$/))) {
    const r = await query(`select to_jsonb(r) from referrals r where id::text = (:'p'::jsonb)->>'k';`, { k: mm[1] });
    return r ? send(res, 200, r) : send(res, 404, { error: 'Referral not found' });
  }
  if (m === 'GET' && p === '/api/audit') {
    return send(res, 200, await query(rows(`select id, ts, emr_id, action, outcome, detail from audit_log order by id desc limit least(coalesce(((:'p'::jsonb)->>'n')::int, 100), 500)`), { n: q.limit || null }));
  }

  // ---- EMR-facing API (x-api-key)
  if (p.startsWith('/api/')) {
    const key = req.headers['x-api-key'];
    const emr = key ? await getEmrByKey(String(key)) : null;
    if (!emr) return send(res, 401, { error: 'Missing or invalid x-api-key' });
    const { api_key, ...emrPublic } = emr; void api_key;

    if (m === 'POST' && p === '/api/referrals') {
      const input = await readBody(req);
      try {
        const out = await handleReferral(emr, input);
        return send(res, 201, out);
      } catch (e) {
        if (!(e instanceof Rejected)) throw e;
        await audit(emr.emr_id, 'referral', 'rejected', { step: e.step, message: e.message });
        return send(res, e.status, { error: e.message, failedStep: e.step, steps: e.steps });
      }
    }
    if (m === 'POST' && (mm = p.match(/^\/api\/referrals\/([0-9a-f-]{36})\/back-referral$/))) {
      const input = await readBody(req);
      try {
        const out = await handleBackReferral(emr, mm[1], input);
        return send(res, 201, out);
      } catch (e) {
        if (!(e instanceof Rejected)) throw e;
        await audit(emr.emr_id, 'back_referral', 'rejected', { referral: mm[1], step: e.step, message: e.message });
        return send(res, e.status, { error: e.message, failedStep: e.step, steps: e.steps });
      }
    }
    if (m === 'POST' && (mm = p.match(/^\/api\/referrals\/([0-9a-f-]{36})\/receive$/))) {
      const r = await query(`update referrals set status='received'
        where id::text = (:'p'::jsonb)->>'k' and to_emr = (:'p'::jsonb)->>'emr' and direction='referral' and status='sent'
        returning jsonb_build_object('id', id, 'status', status);`, { k: mm[1], emr: emr.emr_id });
      if (!r) return send(res, 409, { error: 'Referral not found, not addressed to you, or not in "sent" status' });
      await audit(emr.emr_id, 'receive_referral', 'ok', { referral: mm[1] });
      return send(res, 200, r);
    }
    if (m === 'GET' && p === '/api/inbox') {
      return send(res, 200, await query(rows(referralList(`r.to_emr = (:'p'::jsonb)->>'emr'`)), { emr: emr.emr_id }));
    }
    if (m === 'GET' && p === '/api/outbox') {
      return send(res, 200, await query(rows(referralList(`r.from_emr = (:'p'::jsonb)->>'emr'`)), { emr: emr.emr_id }));
    }
    if (m === 'GET' && p === '/api/patients/search') {
      const search = (q.q || '').trim();
      if (search.length < 2) return send(res, 200, []);
      const matches = await query(rows(`
        select fhir_id, patient_philsys as philsys_id,
               resource->'name'->0->'given'->>0 as given_name,
               resource->'name'->0->>'family' as family_name,
               resource->>'gender' as gender,
               resource->>'birthDate' as birth_date,
               coalesce((resource->>'active')::boolean, true) as active
        from fhir_resources
        where resource_type = 'Patient' and patient_philsys is not null
          and (
            position(lower((:'p'::jsonb)->>'q') in lower(fhir_id)) > 0
            or position(lower((:'p'::jsonb)->>'q') in lower(coalesce(patient_philsys, ''))) > 0
            or exists (
              select 1 from jsonb_array_elements(coalesce(resource->'name', '[]'::jsonb)) patient_name
              where position(lower((:'p'::jsonb)->>'q') in lower(concat_ws(
                ' ', patient_name->>'text',
                (select string_agg(given_name, ' ')
                 from jsonb_array_elements_text(coalesce(patient_name->'given', '[]'::jsonb)) given_names(given_name)),
                patient_name->>'family'
              ))) > 0
            )
            or exists (
              select 1 from jsonb_array_elements(coalesce(resource->'identifier', '[]'::jsonb)) identifier
              where position(lower((:'p'::jsonb)->>'q') in lower(coalesce(identifier->>'value', ''))) > 0
            )
          )
        order by case
          when lower(fhir_id) = lower((:'p'::jsonb)->>'q')
            or lower(coalesce(patient_philsys, '')) = lower((:'p'::jsonb)->>'q') then 0
          else 1
        end, family_name, given_name
        limit 20`), { q: search });
      await audit(emr.emr_id, 'search_patients', 'ok', { matches: matches.length });
      return send(res, 200, matches);
    }
    if (m === 'GET' && (mm = p.match(/^\/api\/patients\/([0-9-]+)\/record$/))) {
      const patient = await getPatient(mm[1]);
      if (!patient) return send(res, 404, { error: 'Patient not found in PhilSys' });
      const bundle = await patientRecordBundle(mm[1]);
      await audit(emr.emr_id, 'get_patient_record', 'ok', { patient: mm[1], resources: bundle.total });
      return fhirSend(res, 200, bundle);
    }
    void emrPublic;
  }

  return send(res, 404, { error: 'Not found' });
}

db.init().then(() => http.createServer((req, res) => {
  applyCors(req, res);
  route(req, res).catch((e) => {
    console.error(e);
    send(res, e.status || 500, { error: e.message || 'Internal error' });
  });
}).listen(PORT, HOST, () => console.log(`Shared Health Record running at http://localhost:${PORT}  (${db.EMBEDDED ? 'embedded Postgres' : 'Postgres via DATABASE_URL'})`)))
  .catch((e) => { console.error('Startup failed:', e.message); process.exit(1); });
