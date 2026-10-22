'use strict';
// End-to-end check against a running server: node scripts/smoke-test.js
const { createEmrClient } = require('../src/emr-client');
const { prefillFromBundle } = require('../src/patient-prefill');
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const KEY = { EMR1: 'demo-key-emr1', EMR2: 'demo-key-emr2', EMR3: 'demo-key-emr3' };
const emrClient = createEmrClient({ baseUrl: BASE, apiKey: KEY.EMR2 });
const corsOrigin = process.env.TEST_CORS_ORIGIN;
let pass = 0, fail = 0;
const check = (name, cond, extra) => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && extra ? '  -> ' + JSON.stringify(extra) : ''}`); };
const call = async (path, emr, method = 'GET', body) => {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(emr ? { 'x-api-key': KEY[emr] } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};

(async () => {
  const openapi = await call('/openapi.json');
  check('machine-readable OpenAPI contract is served', openapi.status === 200 && openapi.body.openapi === '3.1.0' && Boolean(openapi.body.paths['/api/referrals']) && Boolean(openapi.body.paths['/api/health']), openapi.body);
  const prefillScript = await fetch(BASE + '/patient-prefill.js');
  check('EMR dashboard can load shared patient prefill logic', prefillScript.ok && (await prefillScript.text()).includes('prefillFromBundle'));
  const prefillFixture = prefillFromBundle({ resourceType: 'Bundle', entry: [
    { resource: { resourceType: 'Condition', code: { coding: [{ system: 'http://hl7.org/fhir/sid/icd-10', code: 'A01', display: 'Active diagnosis' }] }, clinicalStatus: { coding: [{ code: 'active' }] } } },
    { resource: { resourceType: 'Condition', code: { text: 'Resolved diagnosis' }, clinicalStatus: { coding: [{ code: 'resolved' }] } } },
    { resource: { resourceType: 'Observation', id: 'old', status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '8867-4', display: 'Heart rate' }] }, valueQuantity: { value: 80, unit: '/min' }, meta: { lastUpdated: '2025-01-01T00:00:00Z' } } },
    { resource: { resourceType: 'Observation', id: 'new', status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '8867-4', display: 'Heart rate' }] }, valueQuantity: { value: 90, unit: '/min' }, meta: { lastUpdated: '2026-01-01T00:00:00Z' } } },
    { resource: { resourceType: 'MedicationStatement', status: 'active', medicationCodeableConcept: { text: 'Active medicine' } } },
    { resource: { resourceType: 'MedicationStatement', status: 'stopped', medicationCodeableConcept: { text: 'Stopped medicine' } } },
  ] });
  check('prefill excludes resolved conditions and stopped medications, uses latest observation', prefillFixture.conditions === 'A01 | Active diagnosis' && prefillFixture.observations === '8867-4 | Heart rate | 90 | /min' && prefillFixture.medications === 'Active medicine', prefillFixture);
  const health = await emrClient.checkHealth();
  check('reusable EMR client confirms SHR and database connectivity', health.status === 'ok' && health.fhirVersion === '4.0.1', health);
  if (corsOrigin) {
    const preflight = await fetch(BASE + '/api/inbox', {
      method: 'OPTIONS',
      headers: { origin: corsOrigin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'x-api-key' },
    });
    check('configured EMR origin passes CORS preflight', preflight.status === 204 && preflight.headers.get('access-control-allow-origin') === corsOrigin && preflight.headers.get('access-control-allow-headers')?.toLowerCase().includes('x-api-key'), { status: preflight.status, origin: preflight.headers.get('access-control-allow-origin') });
    const crossOriginRead = await fetch(BASE + '/api/inbox', { headers: { origin: corsOrigin, 'x-api-key': KEY.EMR2 } });
    check('configured EMR origin can call its authenticated API', crossOriginRead.ok && crossOriginRead.headers.get('access-control-allow-origin') === corsOrigin, { status: crossOriginRead.status, origin: crossOriginRead.headers.get('access-control-allow-origin') });
    const adminPreflight = await fetch(BASE + '/api/demo/config', {
      method: 'OPTIONS',
      headers: { origin: corsOrigin, 'access-control-request-method': 'GET' },
    });
    check('CORS does not expose demo credentials or admin data', adminPreflight.status === 403 && !adminPreflight.headers.has('access-control-allow-origin'), { status: adminPreflight.status });
    const untrustedOrigin = await fetch(BASE + '/api/inbox', {
      method: 'OPTIONS',
      headers: { origin: `${corsOrigin}.untrusted`, 'access-control-request-method': 'GET' },
    });
    check('unlisted EMR origin is rejected', untrustedOrigin.status === 403 && !untrustedOrigin.headers.has('access-control-allow-origin'), { status: untrustedOrigin.status });
  }

  // 1. EMR1 -> EMR2 referral
  const ref = await call('/api/referrals', 'EMR1', 'POST', {
    patientPhilsysId: '2345-6789-0123-4567', toEmr: 'EMR2', practitionerNhwr: 'NHWR-1001', priority: 'urgent',
    reason: 'Severe abdominal pain', service: 'Surgical consult',
    conditions: [{ code: 'R10.0', display: 'Acute abdomen' }],
    observations: [{ code: '8480-6', display: 'Systolic blood pressure', value: 110, unit: 'mm[Hg]' }],
    medications: [{ display: 'Omeprazole 20mg', dosage: '1 cap daily' }],
  });
  check('EMR1 referral accepted (201)', ref.status === 201, ref.body);
  check('orchestrator ran 5 steps, all ok', ref.body.steps?.length === 5 && ref.body.steps.every((s) => s.ok), ref.body.steps);
  const refId = ref.body.referral_id;
  const patientSearchByName = await emrClient.searchPatients('Maria Santos');
  check('EMR client can find an SHR patient by name', patientSearchByName.some((p) => p.philsys_id === '2345-6789-0123-4567' && p.given_name === 'Maria' && p.family_name === 'Santos'), patientSearchByName);
  const patientSearchById = await call('/api/patients/search?q=2345-6789-0123-4567', 'EMR3');
  check('EMR can find an SHR patient by PhilSys ID', patientSearchById.status === 200 && patientSearchById.body.some((p) => p.philsys_id === '2345-6789-0123-4567'), patientSearchById.body);
  const importedRecord = prefillFromBundle(await emrClient.getPatientRecord('2345-6789-0123-4567'));
  check('SHR patient record prepopulates referral conditions', importedRecord.conditions.includes('R10.0 | Acute abdomen'), importedRecord);
  check('SHR patient record prepopulates latest observations and active medications', importedRecord.observations.includes('8480-6 | Systolic blood pressure | 110 | mm[Hg]') && importedRecord.medications.includes('Omeprazole 20mg | 1 cap daily') && importedRecord.updatedAt, importedRecord);
  const sharedPatients = await call('/api/shr/patients');
  check('SHR patient directory lists patients with records', sharedPatients.status === 200 && sharedPatients.body.some((p) => p.philsys_id === '2345-6789-0123-4567' && p.resources > 0), sharedPatients.body);
  const sharedPatient = await call('/api/shr/patients/2345-6789-0123-4567');
  check('SHR patient detail includes organized resources and referral history', sharedPatient.status === 200 && sharedPatient.body.patient.resourceType === 'Patient' && sharedPatient.body.record.entry.length > 0 && sharedPatient.body.referrals.some((r) => r.patient_philsys === '2345-6789-0123-4567'), sharedPatient.body);

  // 2. Rejections
  const badPt = await call('/api/referrals', 'EMR1', 'POST', { patientPhilsysId: '0000-0000-0000-0000', toEmr: 'EMR2', practitionerNhwr: 'NHWR-1001', reason: 'x' });
  check('unknown PhilSys rejected at patient step', badPt.status === 422 && badPt.body.failedStep.startsWith('Validate Patient'), badPt.body);
  const badWk = await call('/api/referrals', 'EMR1', 'POST', { patientPhilsysId: '2345-6789-0123-4567', toEmr: 'EMR2', practitionerNhwr: 'NHWR-2001', reason: 'x' });
  check('health worker from another facility rejected', badWk.status === 422 && badWk.body.failedStep.includes('NHWR'), badWk.body);
  const noKey = await call('/api/inbox', null);
  check('missing API key -> 401', noKey.status === 401);
  const noSearchKey = await call('/api/patients/search?q=Maria', null);
  check('patient search requires an EMR API key', noSearchKey.status === 401);

  // 3. EMR2 inbox, receive, get patient record
  const inbox = await call('/api/inbox', 'EMR2');
  check('EMR2 inbox contains the referral', inbox.body.some((r) => r.id === refId));
  const clientInbox = await emrClient.getInbox();
  check('reusable EMR API client reads its inbox', clientInbox.some((r) => r.id === refId), clientInbox);
  const rec1 = await call(`/api/referrals/${refId}/receive`, 'EMR2', 'POST');
  check('EMR2 marks referral received', rec1.status === 200 && rec1.body.status === 'received', rec1.body);
  const wrongRecv = await call(`/api/referrals/${refId}/receive`, 'EMR3', 'POST');
  check('EMR3 cannot receive EMR2 referral', wrongRecv.status === 409);
  const record = await call('/api/patients/2345-6789-0123-4567/record', 'EMR2');
  const types = new Set((record.body.entry || []).map((e) => e.resource.resourceType));
  check('Get Patient Record returns Patient/Condition/ServiceRequest/Task', ['Patient', 'Condition', 'ServiceRequest', 'Task', 'Organization', 'Practitioner'].every((t) => types.has(t)), [...types]);

  // 4. Back-referral from EMR2
  const back = await call(`/api/referrals/${refId}/back-referral`, 'EMR2', 'POST', {
    practitionerNhwr: 'NHWR-2001', findings: 'Treated, stable for discharge', followUp: 'Review at RHU in 1 week',
    conditions: [{ code: 'R10.0', display: 'Acute abdomen, resolved' }],
    observations: [{ code: '8310-5', display: 'Body temperature', value: 36.9, unit: 'Cel' }],
    medications: [{ display: 'Hyoscine 10mg', dosage: '1 tab PRN' }],
  });
  check('EMR2 back-referral accepted (201)', back.status === 201, back.body);
  const again = await call(`/api/referrals/${refId}/back-referral`, 'EMR2', 'POST', { practitionerNhwr: 'NHWR-2001', findings: 'dup' });
  check('second back-referral on closed thread rejected', again.status === 422, again.body);
  const wrongSide = await call(`/api/referrals/${refId}/back-referral`, 'EMR3', 'POST', { practitionerNhwr: 'NHWR-3001', findings: 'x' });
  check('non-recipient EMR cannot back-refer', wrongSide.status === 422, wrongSide.body);

  // 5. Versioning + FHIR read API
  const refRow = await call(`/api/referrals/${refId}`, null);
  const srId = refRow.body.service_request_id;
  const sr = await call(`/fhir/ServiceRequest/${srId}`);
  check('ServiceRequest now completed at version 2', sr.body.status === 'completed' && sr.body.meta?.versionId === '2', sr.body);
  const hist = await call(`/fhir/ServiceRequest/${srId}/_history`);
  check('FHIR _history has 2 versions', hist.body.total === 2, hist.body.total);
  const task = await call(`/fhir/Task/task-${srId}`);
  check('Task completed with back-referral output', task.body.status === 'completed' && task.body.output?.[0]?.valueReference?.reference?.startsWith('Communication/'), task.body);
  const cap = await call('/fhir/metadata');
  check('CapabilityStatement served (FHIR 4.0.1)', cap.body.fhirVersion === '4.0.1');

  // 6. EMR1 sees the back-referral; original referral is completed
  const inbox1 = await call('/api/inbox', 'EMR1');
  check('EMR1 inbox has the back-referral', inbox1.body.some((r) => r.direction === 'back_referral' && r.parent_referral_id === refId));
  const out1 = await call('/api/outbox', 'EMR1');
  check('original referral status is completed', out1.body.find((r) => r.id === refId)?.status === 'completed');

  // 7. Third EMR participates: EMR3 -> EMR1
  const r3 = await call('/api/referrals', 'EMR3', 'POST', { patientPhilsysId: '3456-7890-1234-5678', toEmr: 'EMR1', practitionerNhwr: 'NHWR-3001', reason: 'Post-discharge follow-up care', conditions: [{ display: 'Hypertension' }] });
  check('EMR3 -> EMR1 referral accepted', r3.status === 201, r3.body);
  const record3 = await call('/api/patients/3456-7890-1234-5678/record', 'EMR1');
  const referencedIds = new Set(record3.body.entry.map((e) => `${e.resource.resourceType}/${e.resource.id}`));
  check('patient record contains its referenced facilities and practitioner', ['Organization/org-nhfr-0001', 'Organization/org-nhfr-0003', 'Practitioner/prac-nhwr-3001'].every((id) => referencedIds.has(id)), [...referencedIds]);
  check('patient record excludes unrelated facility and practitioner', !referencedIds.has('Organization/org-nhfr-0002') && !referencedIds.has('Practitioner/prac-nhwr-1001') && !referencedIds.has('Practitioner/prac-nhwr-2001'), [...referencedIds]);

  // 8. Audit + raw data
  const audit = await call('/api/audit?limit=100');
  check('audit log has ok and rejected entries', audit.body.some((a) => a.outcome === 'ok') && audit.body.some((a) => a.outcome === 'rejected'));
  const raw = await call('/api/shr/raw?type=Patient');
  check('raw SHR rows are queryable', Array.isArray(raw.body) && raw.body.length >= 1 && raw.body[0].resource.resourceType === 'Patient');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
